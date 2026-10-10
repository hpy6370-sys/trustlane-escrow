require("dotenv").config({ quiet: true });
const crypto = require("crypto");

const env = process.env;
const isProd = env.NODE_ENV === "production";

function int(name, fallback) {
  const v = env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`Config ${name} must be an integer, got "${v}"`);
  return n;
}

let jwtSecret = env.JWT_SECRET;
if (!jwtSecret) {
  if (isProd) throw new Error("JWT_SECRET is required in production");
  // dev only: tokens become invalid on restart, which is fine locally
  jwtSecret = crypto.randomBytes(32).toString("hex");
  console.warn("[config] JWT_SECRET not set, using a random dev secret");
}

module.exports = {
  isProd,
  port: int("PORT", 4000),
  databasePath: env.DATABASE_PATH || "./data/escrow.db",
  jwtSecret,
  jwtTtl: env.JWT_TTL || "12h",
  corsOrigins: (env.CORS_ORIGINS || "http://localhost:5173,http://127.0.0.1:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  chainId: int("CHAIN_ID", 31337),
  rpcUrl: env.RPC_URL || "http://127.0.0.1:8545",
  indexer: {
    enabled: env.INDEXER_ENABLED !== "false",
    pollMs: int("INDEXER_POLL_MS", 4000),
    logChunk: int("LOG_CHUNK", 500),
    confirmations: int("CONFIRMATIONS", 0),
  },
  // Used only when the chain is unreachable: addresses treated as Admin.
  adminFallback: (env.ADMIN_ADDRESSES || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  siweDomain: env.SIWE_DOMAIN || "localhost:5173",
  nonceTtlMs: int("NONCE_TTL_MS", 5 * 60 * 1000),
};
