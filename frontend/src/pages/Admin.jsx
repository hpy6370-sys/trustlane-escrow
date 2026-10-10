import { useEffect, useState } from "react";
import { isAddress } from "ethers";
import { ROLE_IDS, TOKENS } from "../config";
import { Api } from "../lib/api";
import { amount, dateTime } from "../lib/format";
import { useWallet } from "../context/WalletContext";
import { Address, Card, ErrorBox, StatTile, useLoad } from "../components/ui";

export default function Admin() {
  const w = useWallet();
  const [chainState, setChainState] = useState(null);
  const [fee, setFee] = useState("");
  const [arbAddr, setArbAddr] = useState("");
  const [tokenAddr, setTokenAddr] = useState("");
  const [feeTo, setFeeTo] = useState("");

  const overview = useLoad(() => (w.signedIn ? Api.adminOverview() : Promise.resolve(null)), [w.signedIn, w.refreshKey]);
  const arbiters = useLoad(() => (w.signedIn ? Api.arbiters() : Promise.resolve([])), [w.signedIn, w.refreshKey]);

  // live platform settings straight from the contracts
  useEffect(() => {
    const reg = w.readContract("PlatformRegistry");
    const esc = w.readContract("EscrowManager");
    if (!reg || !w.onRightChain) return;
    Promise.all([reg.feeBps(), reg.paused(), ...TOKENS.map((t) => esc.accruedFees(t.address))])
      .then(([f, p, ...fees]) => setChainState({ feeBps: Number(f), paused: p, fees }))
      .catch(() => setChainState(null));
  }, [w.readContract, w.onRightChain, w.refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const reg = (label, method, args = []) => w.runTx({ label, contract: "PlatformRegistry", method, args });
  const feeValid = fee !== "" && Number.isInteger(Number(fee)) && Number(fee) >= 0 && Number(fee) <= 1000;

  return (
    <div className="stack">
      <h1>Admin console</h1>
      {!w.signedIn && (
        <div className="alert">
          <button className="link" onClick={w.signIn}>Sign in</button> to load indexer health and the arbiter list from the API.
        </div>
      )}

      {chainState && (
        <div className="tiles">
          <StatTile label="Platform fee" value={`${(chainState.feeBps / 100).toFixed(2)}%`} sub={`${chainState.feeBps} bps · cap 1000`} />
          <StatTile label="Platform state" value={chainState.paused ? "⏸ Paused" : "▶ Running"} />
          {TOKENS.map((t, i) => (
            <StatTile key={t.address} label={`Fees accrued · ${t.symbol}`} value={amount(chainState.fees[i], t.address, 6)} />
          ))}
        </div>
      )}

      <div className="grid-2">
        <Card title="Platform settings">
          <div className="form">
            <label>
              New fee (basis points, 0–1000)
              <div className="row">
                <input className="grow" value={fee} onChange={(e) => setFee(e.target.value)} inputMode="numeric" placeholder="250" />
                <button className="btn" disabled={!feeValid} onClick={() => reg(`Set fee to ${fee} bps`, "setPlatformFee", [Number(fee)])}>
                  Update fee
                </button>
              </div>
            </label>
            <div className="row">
              {chainState?.paused ? (
                <button className="btn primary" onClick={() => reg("Unpause platform", "unpause")}>
                  Unpause platform
                </button>
              ) : (
                <button className="btn warn" onClick={() => reg("Pause platform (circuit breaker)", "pause")}>
                  Pause platform
                </button>
              )}
            </div>
            <p className="muted small">
              Pause blocks new escrows, acceptance, submissions, approvals and new disputes. Cancel, timeout refunds and
              withdrawals keep working so users can always exit.
            </p>
            <label>
              Allow / disallow ERC20 token
              <div className="row">
                <input className="grow" value={tokenAddr} onChange={(e) => setTokenAddr(e.target.value)} placeholder="0x… token address" />
                <button className="btn" disabled={!isAddress(tokenAddr)} onClick={() => reg("Allow token", "setTokenAllowed", [tokenAddr, true])}>
                  Allow
                </button>
                <button className="btn ghost" disabled={!isAddress(tokenAddr)} onClick={() => reg("Disallow token", "setTokenAllowed", [tokenAddr, false])}>
                  Disallow
                </button>
              </div>
            </label>
          </div>
        </Card>

        <Card title="Arbiters">
          <div className="row">
            <input className="grow" value={arbAddr} onChange={(e) => setArbAddr(e.target.value)} placeholder="0x… address" />
            <button className="btn" disabled={!isAddress(arbAddr)} onClick={() => reg("Grant ARBITER_ROLE", "grantRole", [ROLE_IDS.ARBITER, arbAddr])}>
              Grant
            </button>
            <button className="btn ghost" disabled={!isAddress(arbAddr)} onClick={() => reg("Revoke ARBITER_ROLE", "revokeRole", [ROLE_IDS.ARBITER, arbAddr])}>
              Revoke
            </button>
          </div>
          <ErrorBox error={arbiters.error} />
          {arbiters.data?.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Arbiter</th>
                    <th>Since</th>
                    <th className="num">Open cases</th>
                  </tr>
                </thead>
                <tbody>
                  {arbiters.data.map((a) => (
                    <tr key={a.address}>
                      <td>
                        <Address value={a.address} label={a.display_name} />
                      </td>
                      <td>{dateTime(a.granted_at)}</td>
                      <td className="num">{a.open_cases}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <Card title="Withdraw platform fees">
        <div className="row">
          <input className="grow" value={feeTo} onChange={(e) => setFeeTo(e.target.value)} placeholder={`Recipient (default ${w.account})`} />
          {TOKENS.map((t) => (
            <button
              key={t.address}
              className="btn"
              disabled={feeTo !== "" && !isAddress(feeTo)}
              onClick={() =>
                w.runTx({
                  label: `Withdraw ${t.symbol} fees`,
                  contract: "EscrowManager",
                  method: "withdrawFees",
                  args: [t.address, feeTo || w.account],
                })
              }
            >
              Withdraw {t.symbol}
            </button>
          ))}
        </div>
      </Card>

      {overview.data && (
        <Card title="Backend indexer">
          <dl className="kv">
            <dt>Running</dt>
            <dd>{overview.data.indexer.running ? "yes" : "no"}</dd>
            <dt>Last indexed block</dt>
            <dd className="num">{overview.data.indexer.lastBlock ?? "—"}</dd>
            <dt>Chain head (minus confirmations)</dt>
            <dd className="num">{overview.data.indexer.head ?? "—"}</dd>
            <dt>Last error</dt>
            <dd>{overview.data.indexer.lastError || "none"}</dd>
            <dt>Users by role</dt>
            <dd>{overview.data.roles.map((r) => `${r.role}: ${r.n}`).join(" · ")}</dd>
          </dl>
        </Card>
      )}
    </div>
  );
}
