import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { BrowserProvider, Contract, formatEther, formatUnits } from "ethers";
import { ABIS, ADDRESSES, CHAIN, CHAIN_ID, DEPLOYMENT } from "../config";
import { Api, session } from "../lib/api";
import { decodeError } from "../lib/errors";
import TxDialog from "../components/TxDialog";

/** Polls /api/health until the backend indexer has processed `block` (max ~20 s). */
async function waitForIndexer(block) {
  for (let i = 0; i < 20; i++) {
    try {
      const h = await Api.health();
      if ((h.indexer?.lastBlock ?? -1) >= block) return;
    } catch {
      /* API down: give up quietly, pages still show live chain data */
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const WalletContext = createContext(null);
export const useWallet = () => useContext(WalletContext);

const ROLE_BITS = [
  [1, "admin"],
  [2, "client"],
  [4, "freelancer"],
  [8, "arbiter"],
];

export function WalletProvider({ children }) {
  const eth = typeof window !== "undefined" ? window.ethereum : undefined;
  const [account, setAccount] = useState(null);
  const [chainId, setChainId] = useState(null);
  const [roles, setRoles] = useState([]);
  const [signedIn, setSignedIn] = useState(Boolean(session.get()));
  const [error, setError] = useState(null);
  const [tx, setTx] = useState(null); // state of the transaction dialog
  const [refreshKey, setRefreshKey] = useState(0); // bump to make pages refetch after a tx

  const provider = useMemo(() => (eth ? new BrowserProvider(eth, "any") : null), [eth]);
  const onRightChain = chainId === CHAIN_ID;

  const readContract = useCallback(
    (name) => (provider && ADDRESSES[name] ? new Contract(ADDRESSES[name], ABIS[name], provider) : null),
    [provider]
  );

  const refreshRoles = useCallback(async () => {
    if (!account || !onRightChain || !DEPLOYMENT) return setRoles([]);
    try {
      const mask = Number(await readContract("PlatformRegistry").rolesOf(account));
      setRoles(ROLE_BITS.filter(([b]) => mask & b).map(([, n]) => n));
    } catch (err) {
      setError(`Could not read roles: ${decodeError(err)}`);
    }
  }, [account, onRightChain, readContract]);

  // wallet events
  useEffect(() => {
    if (!eth) return;
    const onAccounts = (accs) => {
      setAccount(accs[0]?.toLowerCase() || null);
      session.clear(); // JWT belongs to the previous account
      setSignedIn(false);
    };
    const onChain = (hex) => setChainId(Number(hex));
    eth.request({ method: "eth_accounts" }).then((a) => setAccount(a[0]?.toLowerCase() || null));
    eth.request({ method: "eth_chainId" }).then(onChain);
    eth.on?.("accountsChanged", onAccounts);
    eth.on?.("chainChanged", onChain);
    return () => {
      eth.removeListener?.("accountsChanged", onAccounts);
      eth.removeListener?.("chainChanged", onChain);
    };
  }, [eth]);

  useEffect(() => {
    refreshRoles();
  }, [refreshRoles, refreshKey]);

  const connect = useCallback(async () => {
    setError(null);
    if (!eth) return setError("MetaMask not found. Install it from metamask.io (or open this page in the MetaMask app).");
    try {
      const accs = await eth.request({ method: "eth_requestAccounts" });
      setAccount(accs[0]?.toLowerCase() || null);
    } catch (err) {
      setError(decodeError(err));
    }
  }, [eth]);

  const switchChain = useCallback(async () => {
    if (!eth || !CHAIN) return;
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN.chainId }] });
    } catch (err) {
      if (err.code === 4902 || err?.data?.originalError?.code === 4902) {
        const { explorer, ...params } = CHAIN; // eslint-disable-line no-unused-vars
        await eth.request({ method: "wallet_addEthereumChain", params: [params] });
      } else setError(decodeError(err));
    }
  }, [eth]);

  /** SIWE-style login: sign the server's one-time message, receive a JWT. */
  const signIn = useCallback(async () => {
    setError(null);
    try {
      const signer = await provider.getSigner();
      const { message } = await Api.nonce(account);
      const signature = await signer.signMessage(message);
      const { token } = await Api.verify(account, signature);
      session.set(token);
      setSignedIn(true);
      return true;
    } catch (err) {
      setError(`Sign-in failed: ${err.message?.includes("rejected") ? "rejected in wallet" : decodeError(err)}`);
      return false;
    }
  }, [provider, account]);

  const signOut = useCallback(() => {
    session.clear();
    setSignedIn(false);
  }, []);

  /**
   * Every write goes through here: estimate gas -> show cost -> user confirms ->
   * MetaMask signs -> wait for receipt -> show actual gas used.
   */
  const runTx = useCallback(
    ({ label, contract, method, args = [], value }) =>
      new Promise((resolve) => {
        const start = async () => {
          setTx({ label, phase: "estimating" });
          try {
            if (!onRightChain) throw new Error(`Switch your wallet to ${CHAIN?.chainName}`);
            const signer = await provider.getSigner();
            const c = new Contract(ADDRESSES[contract], ABIS[contract], signer);
            const overrides = value ? { value } : {};
            const [gas, feeData] = await Promise.all([c[method].estimateGas(...args, overrides), provider.getFeeData()]);
            const price = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
            setTx({
              label,
              phase: "confirm",
              estimate: { gas, price, cost: gas * price },
              send: async () => {
                setTx((t) => ({ ...t, phase: "pending" }));
                try {
                  const sent = await c[method](...args, { ...overrides, gasLimit: (gas * 12n) / 10n });
                  setTx((t) => ({ ...t, hash: sent.hash }));
                  const receipt = await sent.wait();
                  setTx((t) => ({ ...t, phase: "mined", receipt }));
                  setRefreshKey((k) => k + 1); // live chain reads update now
                  resolve(receipt);
                  // API data comes from the indexer: refetch once it has caught up with this block
                  waitForIndexer(receipt.blockNumber).then(() => setRefreshKey((k) => k + 1));
                } catch (err) {
                  setTx((t) => ({ ...t, phase: "error", error: decodeError(err) }));
                  resolve(null);
                }
              },
              cancel: () => {
                setTx(null);
                resolve(null);
              },
            });
          } catch (err) {
            setTx({ label, phase: "error", error: decodeError(err) });
            resolve(null);
          }
        };
        start();
      }),
    [provider, onRightChain]
  );

  const value = {
    hasWallet: Boolean(eth),
    account,
    chainId,
    onRightChain,
    roles,
    hasRole: (r) => roles.includes(r),
    signedIn,
    error,
    setError,
    connect,
    switchChain,
    signIn,
    signOut,
    runTx,
    readContract,
    refreshRoles,
    refreshKey,
    bump: () => setRefreshKey((k) => k + 1),
    getEthBalance: async () => (provider && account ? formatEther(await provider.getBalance(account)) : null),
    getTokenBalance: async (token, decimals) =>
      provider && account
        ? formatUnits(await new Contract(token, ABIS.MockUSDC, provider).balanceOf(account), decimals)
        : null,
  };

  return (
    <WalletContext.Provider value={value}>
      {children}
      {tx && <TxDialog tx={tx} onClose={() => setTx(null)} />}
    </WalletContext.Provider>
  );
}
