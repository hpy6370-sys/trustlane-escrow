const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const ROLE = {
  ADMIN: ethers.ZeroHash,
  ARBITER: ethers.id("ARBITER_ROLE"),
  CLIENT: ethers.id("CLIENT_ROLE"),
  FREELANCER: ethers.id("FREELANCER_ROLE"),
};

const STATUS = { None: 0n, Created: 1n, Active: 2n, Disputed: 3n, Completed: 4n, Cancelled: 5n, Refunded: 6n, Resolved: 7n };
const MS = { Pending: 0n, Submitted: 1n, Approved: 2n, Refunded: 3n };
const FEE_BPS = 250; // 2.5 %
const ETH = ethers.ZeroAddress;
const hash = (s) => ethers.id(s);

/** Deploys and wires the whole system exactly like scripts/deploy.js does. */
async function deploySystem() {
  const [admin, client, freelancer, arbiter, outsider, client2, freelancer2] = await ethers.getSigners();

  const registry = await ethers.deployContract("PlatformRegistry", [admin.address, FEE_BPS]);
  const reputation = await ethers.deployContract("Reputation", [registry.target]);
  const escrow = await ethers.deployContract("EscrowManager", [registry.target, reputation.target]);
  const dispute = await ethers.deployContract("DisputeResolution", [registry.target, escrow.target, reputation.target]);
  const usdc = await ethers.deployContract("MockUSDC");

  await escrow.setDisputeResolver(dispute.target);
  await reputation.setUpdater(escrow.target, true);
  await reputation.setUpdater(dispute.target, true);
  await registry.setTokenAllowed(usdc.target, true);
  await registry.grantRole(ROLE.ARBITER, arbiter.address);

  await registry.connect(client).registerAs(ROLE.CLIENT);
  await registry.connect(client2).registerAs(ROLE.CLIENT);
  await registry.connect(freelancer).registerAs(ROLE.FREELANCER);
  await registry.connect(freelancer2).registerAs(ROLE.FREELANCER);

  return { registry, reputation, escrow, dispute, usdc, admin, client, freelancer, arbiter, outsider, client2, freelancer2 };
}

async function futureDeadline(days = 30) {
  return (await time.latest()) + days * 24 * 3600;
}

/** Creates an ETH escrow with the given milestone amounts (in ETH strings). */
async function createEthEscrow(ctx, amountsEth = ["1", "2"], opts = {}) {
  const { escrow, client, freelancer } = ctx;
  const amounts = amountsEth.map((a) => ethers.parseEther(a));
  const total = amounts.reduce((a, b) => a + b, 0n);
  const deadline = opts.deadline ?? (await futureDeadline());
  const c = opts.client ?? client;
  const f = opts.freelancer ?? freelancer;
  await escrow.connect(c).createEscrow(f.address, ETH, amounts, deadline, hash("terms"), { value: total });
  const id = await escrow.escrowCount();
  return { id, amounts, total, deadline };
}

/** Created -> Active. */
async function createActiveEscrow(ctx, amountsEth, opts = {}) {
  const r = await createEthEscrow(ctx, amountsEth, opts);
  await ctx.escrow.connect(opts.freelancer ?? ctx.freelancer).acceptEscrow(r.id);
  return r;
}

module.exports = { ROLE, STATUS, MS, FEE_BPS, ETH, hash, deploySystem, futureDeadline, createEthEscrow, createActiveEscrow };
