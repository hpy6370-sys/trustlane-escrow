const { ethers } = require("ethers");
const abis = require("./contracts/abis.json");
const deployments = require("./contracts/deployments.json");

const ROLE_BITS = [
  [1, "admin"],
  [2, "client"],
  [4, "freelancer"],
  [8, "arbiter"],
];
const ROLE_BY_HASH = {
  [ethers.ZeroHash]: "admin",
  [ethers.id("CLIENT_ROLE")]: "client",
  [ethers.id("FREELANCER_ROLE")]: "freelancer",
  [ethers.id("ARBITER_ROLE")]: "arbiter",
};
const CORE = ["PlatformRegistry", "EscrowManager", "DisputeResolution", "Reputation"];

/**
 * Wraps provider + contract handles. `available` is false when no deployment
 * exists for the configured chain; the API still runs, just without live reads.
 */
function createChain({ chainId, rpcUrl }) {
  const deployment = deployments[String(chainId)] || null;
  const provider = new ethers.JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
  const contracts = {};
  if (deployment) {
    for (const name of [...CORE, "MockUSDC"]) {
      contracts[name] = new ethers.Contract(deployment.contracts[name], abis[name], provider);
    }
  }

  const tokens = { [ethers.ZeroAddress]: { symbol: "ETH", decimals: 18 } };
  if (deployment) tokens[deployment.contracts.MockUSDC.toLowerCase()] = { symbol: "mUSDC", decimals: 6 };

  // Small TTL cache: role checks happen on every privileged request.
  const roleCache = new Map();
  async function rolesOnChain(address) {
    const key = address.toLowerCase();
    const hit = roleCache.get(key);
    if (hit && hit.until > Date.now()) return hit.roles;
    const mask = Number(await contracts.PlatformRegistry.rolesOf(address));
    const roles = ROLE_BITS.filter(([bit]) => mask & bit).map(([, name]) => name);
    roleCache.set(key, { roles, until: Date.now() + 15_000 });
    return roles;
  }

  return {
    chainId,
    deployment,
    available: Boolean(deployment),
    provider,
    contracts,
    abis,
    tokens,
    rolesOnChain,
    tokenInfo: (addr) => tokens[addr.toLowerCase()] || { symbol: "TOKEN", decimals: 18 },
    clearRoleCache: (addr) => roleCache.delete(addr.toLowerCase()),
  };
}

module.exports = { createChain, ROLE_BY_HASH, CORE };
