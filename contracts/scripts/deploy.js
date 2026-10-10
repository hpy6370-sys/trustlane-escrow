// Deploys and wires the full system.
//   npx hardhat run scripts/deploy.js --network localhost
//   npx hardhat run scripts/deploy.js --network sepolia      (needs .env, see .env.example)
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { exportArtifacts } = require("./export");

const { ethers, network } = hre;
const FEE_BPS = Number(process.env.PLATFORM_FEE_BPS ?? 250);

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer account. For sepolia set DEPLOYER_PRIVATE_KEY in contracts/.env");
  const admin = process.env.ADMIN_ADDRESS || deployer.address;
  const { chainId } = await ethers.provider.getNetwork();
  const startBlock = await ethers.provider.getBlockNumber();
  console.log(`network=${network.name} chainId=${chainId} deployer=${deployer.address} admin=${admin}`);
  console.log(`deployer balance: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);

  const receipts = [];
  const deploy = async (name, args = []) => {
    const c = await ethers.deployContract(name, args);
    await c.waitForDeployment();
    const rcpt = await c.deploymentTransaction().wait();
    receipts.push({ step: `deploy ${name}`, gasUsed: rcpt.gasUsed.toString() });
    console.log(`  ${name.padEnd(18)} ${c.target}  gas=${rcpt.gasUsed}`);
    return c;
  };
  const send = async (label, txPromise) => {
    const rcpt = await (await txPromise).wait();
    receipts.push({ step: label, gasUsed: rcpt.gasUsed.toString() });
    console.log(`  ${label.padEnd(40)} gas=${rcpt.gasUsed}`);
  };

  // Deployer is temporary admin so it can wire modules; admin role is handed over at the end if different.
  const registry = await deploy("PlatformRegistry", [deployer.address, FEE_BPS]);
  const reputation = await deploy("Reputation", [registry.target]);
  const escrow = await deploy("EscrowManager", [registry.target, reputation.target]);
  const dispute = await deploy("DisputeResolution", [registry.target, escrow.target, reputation.target]);
  const usdc = await deploy("MockUSDC");

  await send("escrow.setDisputeResolver", escrow.setDisputeResolver(dispute.target));
  await send("reputation.setUpdater(escrow)", reputation.setUpdater(escrow.target, true));
  await send("reputation.setUpdater(dispute)", reputation.setUpdater(dispute.target, true));
  await send("registry.setTokenAllowed(mUSDC)", registry.setTokenAllowed(usdc.target, true));

  if (admin.toLowerCase() !== deployer.address.toLowerCase()) {
    const ADMIN = await registry.DEFAULT_ADMIN_ROLE();
    await send("registry.grantRole(ADMIN, admin)", registry.grantRole(ADMIN, admin));
    await send("registry.renounceRole(ADMIN, deployer)", registry.renounceRole(ADMIN, deployer.address));
  }

  const deployment = {
    chainId: Number(chainId),
    network: network.name,
    deployedAt: new Date().toISOString(),
    startBlock,
    admin,
    contracts: {
      PlatformRegistry: registry.target,
      Reputation: reputation.target,
      EscrowManager: escrow.target,
      DisputeResolution: dispute.target,
      MockUSDC: usdc.target,
    },
  };

  const outDir = path.resolve(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${network.name}.json`), JSON.stringify({ ...deployment, receipts }, null, 2));
  exportArtifacts(deployment);

  if (network.name === "sepolia") {
    console.log("\nVerify on Etherscan (needs ETHERSCAN_API_KEY):");
    console.log(`  npx hardhat verify --network sepolia ${registry.target} ${deployer.address} ${FEE_BPS}`);
    console.log(`  npx hardhat verify --network sepolia ${reputation.target} ${registry.target}`);
    console.log(`  npx hardhat verify --network sepolia ${escrow.target} ${registry.target} ${reputation.target}`);
    console.log(`  npx hardhat verify --network sepolia ${dispute.target} ${registry.target} ${escrow.target} ${reputation.target}`);
    console.log(`  npx hardhat verify --network sepolia ${usdc.target}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
