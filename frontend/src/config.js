import { id, ZeroHash } from "ethers";
import deployments from "./contracts/deployments.json";
import abis from "./contracts/abis.json";

export const API_URL = (import.meta.env.VITE_API_URL || "http://localhost:4000").replace(/\/$/, "");
export const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID || 31337);

const CHAINS = {
  31337: {
    chainId: "0x7a69",
    chainName: "Hardhat Local",
    rpcUrls: ["http://127.0.0.1:8545"],
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    explorer: null,
  },
  11155111: {
    chainId: "0xaa36a7",
    chainName: "Sepolia",
    rpcUrls: ["https://ethereum-sepolia-rpc.publicnode.com"],
    nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
    blockExplorerUrls: ["https://sepolia.etherscan.io"],
    explorer: "https://sepolia.etherscan.io",
  },
};

export const CHAIN = CHAINS[CHAIN_ID];
export const DEPLOYMENT = deployments[String(CHAIN_ID)] || null;
export const ABIS = abis;
export const ADDRESSES = DEPLOYMENT?.contracts || {};

export const ETH = "0x0000000000000000000000000000000000000000";
export const TOKENS = [
  { address: ETH, symbol: "ETH", decimals: 18 },
  ...(ADDRESSES.MockUSDC ? [{ address: ADDRESSES.MockUSDC.toLowerCase(), symbol: "mUSDC", decimals: 6 }] : []),
];
export const tokenInfo = (addr) =>
  TOKENS.find((t) => t.address === String(addr).toLowerCase()) || { address: addr, symbol: "TOKEN", decimals: 18 };

export const txLink = (hash) => (CHAIN?.explorer ? `${CHAIN.explorer}/tx/${hash}` : null);
export const addressLink = (a) => (CHAIN?.explorer ? `${CHAIN.explorer}/address/${a}` : null);

export const ROLE_IDS = {
  ADMIN: ZeroHash,
  CLIENT: id("CLIENT_ROLE"),
  FREELANCER: id("FREELANCER_ROLE"),
  ARBITER: id("ARBITER_ROLE"),
};
