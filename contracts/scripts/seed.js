// Fills a local chain with demo data covering every transaction type, so the
// dashboard has something to show. Local only (uses Hardhat's funded accounts).
//   npx hardhat run scripts/seed.js --network localhost
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const ETH = ethers.ZeroAddress;
const h = (s) => ethers.id(s);
const usd = (n) => BigInt(n) * 10n ** 6n;
const eth = (n) => ethers.parseEther(String(n));

async function main() {
  if (network.name !== "localhost" && network.name !== "hardhat") {
    throw new Error("seed.js is for local demo chains only");
  }
  const file = path.resolve(__dirname, "..", "deployments", `${network.name}.json`);
  const dep = JSON.parse(fs.readFileSync(file, "utf8"));
  const [admin, alice, bob, carol, dave, erin, arb] = await ethers.getSigners();
  const at = (name) => ethers.getContractAt(name, dep.contracts[name]);
  const registry = await at("PlatformRegistry");
  const escrow = await at("EscrowManager");
  const dispute = await at("DisputeResolution");
  const usdc = await at("MockUSDC");

  const CLIENT = ethers.id("CLIENT_ROLE");
  const FREELANCER = ethers.id("FREELANCER_ROLE");
  const ARBITER = ethers.id("ARBITER_ROLE");
  const wait = async (p) => (await p).wait();
  const now = async () => (await ethers.provider.getBlock("latest")).timestamp;
  const later = async (days) => (await now()) + days * 86400;
  const lastId = async () => escrow.escrowCount();

  // roles: alice & bob are clients, carol & dave freelancers, erin both, arb is an arbiter
  for (const s of [alice, bob, erin]) await wait(registry.connect(s).registerAs(CLIENT));
  for (const s of [carol, dave, erin]) await wait(registry.connect(s).registerAs(FREELANCER));
  await wait(registry.grantRole(ARBITER, arb.address));
  for (const s of [alice, bob]) {
    await wait(usdc.connect(s).faucet());
    await wait(usdc.connect(s).approve(escrow.target, usd(10_000)));
  }

  // 1) completed mUSDC job + ratings
  await wait(escrow.connect(alice).createEscrow(carol.address, usdc.target, [usd(800), usd(1200)], await later(30), h("Landing page redesign")));
  let id = await lastId();
  await wait(escrow.connect(carol).acceptEscrow(id));
  for (const i of [0, 1]) {
    await wait(escrow.connect(carol).submitMilestone(id, i, h(`deliverable-${id}-${i}`)));
    await wait(escrow.connect(alice).approveMilestone(id, i));
  }
  await wait(escrow.connect(alice).rateCounterparty(id, 5));
  await wait(escrow.connect(carol).rateCounterparty(id, 4));

  // 2) completed ETH job
  await wait(escrow.connect(bob).createEscrow(dave.address, ETH, [eth(0.4)], await later(14), h("Smart contract audit"), { value: eth(0.4) }));
  id = await lastId();
  await wait(escrow.connect(dave).acceptEscrow(id));
  await wait(escrow.connect(dave).submitMilestone(id, 0, h("audit-report")));
  await wait(escrow.connect(bob).approveMilestone(id, 0));

  // 3) disputed then resolved 70/30
  await wait(escrow.connect(bob).createEscrow(erin.address, ETH, [eth(0.5), eth(0.5)], await later(20), h("Mobile app MVP"), { value: eth(1) }));
  id = await lastId();
  await wait(escrow.connect(erin).acceptEscrow(id));
  await wait(escrow.connect(erin).submitMilestone(id, 0, h("mvp-build-1")));
  await wait(dispute.connect(bob).openDispute(id, h("Build crashes on launch")));
  let did = await dispute.disputeCount();
  await wait(dispute.connect(bob).submitEvidence(did, h("crash-logs")));
  await wait(dispute.connect(erin).submitEvidence(did, h("test-recording")));
  await wait(dispute.assignArbiter(did, arb.address));
  await wait(dispute.connect(arb).resolveDispute(did, 7000, h("ruling: partial delivery")));

  // 4) open dispute waiting for an arbiter
  await wait(escrow.connect(alice).createEscrow(dave.address, usdc.target, [usd(1500)], await later(25), h("Data pipeline"), {}));
  id = await lastId();
  await wait(escrow.connect(dave).acceptEscrow(id));
  await wait(dispute.connect(dave).openDispute(id, h("Client unresponsive")));

  // 5) cancelled before acceptance
  await wait(escrow.connect(alice).createEscrow(erin.address, ETH, [eth(0.2)], await later(10), h("Logo design"), { value: eth(0.2) }));
  await wait(escrow.connect(alice).cancelEscrow(await lastId()));

  // 6) in progress (one milestone submitted)
  await wait(escrow.connect(erin).createEscrow(carol.address, ETH, [eth(0.3), eth(0.3), eth(0.4)], await later(40), h("Docs site"), { value: eth(1) }));
  id = await lastId();
  await wait(escrow.connect(carol).acceptEscrow(id));
  await wait(escrow.connect(carol).submitMilestone(id, 0, h("docs-v1")));

  // 7) waiting for acceptance
  await wait(escrow.connect(bob).createEscrow(carol.address, usdc.target, [usd(600), usd(600)], await later(30), h("Brand video"), {}));

  // 8) timed out -> refund (short deadline then fast-forward)
  await wait(escrow.connect(alice).createEscrow(dave.address, ETH, [eth(0.25)], await later(2), h("Bug bash"), { value: eth(0.25) }));
  id = await lastId();
  await wait(escrow.connect(dave).acceptEscrow(id));
  await ethers.provider.send("evm_increaseTime", [3 * 86400]);
  await ethers.provider.send("evm_mine", []);
  await wait(escrow.connect(admin).claimTimeoutRefund(id));

  // withdrawals and fee sweep
  await wait(escrow.connect(carol).withdraw(usdc.target));
  await wait(escrow.connect(bob).withdraw(ETH));
  await wait(escrow.connect(alice).withdraw(ETH));
  await wait(escrow.withdrawFees(usdc.target, admin.address));

  console.log(`seeded ${await escrow.escrowCount()} escrows, ${await dispute.disputeCount()} disputes`);
  console.log("demo accounts (Hardhat defaults, import into MetaMask for local testing):");
  const named = { admin, alice, bob, carol, dave, erin, arbiter: arb };
  for (const [k, s] of Object.entries(named)) console.log(`  ${k.padEnd(8)} ${s.address}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
