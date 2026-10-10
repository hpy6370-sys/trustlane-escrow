// Copies ABIs (and, when given, deployed addresses) into the frontend and backend
// so both apps build from the same source of truth.
//   npx hardhat compile && node scripts/export.js        -> ABIs only
//   called from deploy.js                                -> ABIs + addresses
const fs = require("fs");
const path = require("path");

const CONTRACTS = ["PlatformRegistry", "Reputation", "EscrowManager", "DisputeResolution", "MockUSDC"];
const ROOT = path.resolve(__dirname, "..", "..");
const TARGETS = [path.join(ROOT, "frontend", "src", "contracts"), path.join(ROOT, "backend", "src", "contracts")];

function loadAbi(name) {
  const dir = name === "MockUSDC" ? "mocks/" : "";
  const p = path.resolve(__dirname, "..", "artifacts", "contracts", `${dir}${name}.sol`, `${name}.json`);
  if (!fs.existsSync(p)) throw new Error(`Artifact missing for ${name}; run "npx hardhat compile" first`);
  return JSON.parse(fs.readFileSync(p, "utf8")).abi;
}

/** @param {{chainId:number, network:string, startBlock:number, contracts:Record<string,string>}=} deployment */
function exportArtifacts(deployment) {
  const abis = Object.fromEntries(CONTRACTS.map((n) => [n, loadAbi(n)]));
  for (const dir of TARGETS) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "abis.json"), JSON.stringify(abis, null, 2));
    const addrFile = path.join(dir, "deployments.json");
    const all = fs.existsSync(addrFile) ? JSON.parse(fs.readFileSync(addrFile, "utf8")) : {};
    if (deployment) all[String(deployment.chainId)] = deployment;
    fs.writeFileSync(addrFile, JSON.stringify(all, null, 2));
    console.log(`exported -> ${path.relative(ROOT, dir)}`);
  }
}

module.exports = { exportArtifacts, CONTRACTS };

if (require.main === module) exportArtifacts();
