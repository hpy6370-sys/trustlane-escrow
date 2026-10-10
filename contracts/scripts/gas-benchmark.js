// Controlled gas measurements for docs/gas-analysis.md. Runs on the in-process
// Hardhat network (deterministic), records receipt.gasUsed per scenario.
//   npx hardhat run scripts/gas-benchmark.js
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

async function main() {
  if (network.name !== "hardhat") throw new Error("run on the in-process hardhat network");
  const [admin, client, freelancer, arbiter] = await ethers.getSigners();
  const ETH = ethers.ZeroAddress;
  const h = (s) => ethers.id(s);
  const rows = [];
  const gas = async (label, p, note = "") => {
    const r = await (await p).wait();
    rows.push({ scenario: label, gasUsed: Number(r.gasUsed), note });
    return r;
  };

  const registry = await ethers.deployContract("PlatformRegistry", [admin.address, 250]);
  const reputation = await ethers.deployContract("Reputation", [registry.target]);
  const escrow = await ethers.deployContract("EscrowManager", [registry.target, reputation.target]);
  const dispute = await ethers.deployContract("DisputeResolution", [registry.target, escrow.target, reputation.target]);
  const usdc = await ethers.deployContract("MockUSDC");
  for (const [n, c] of Object.entries({ PlatformRegistry: registry, Reputation: reputation, EscrowManager: escrow, DisputeResolution: dispute, MockUSDC: usdc })) {
    rows.push({ scenario: `deploy ${n}`, gasUsed: Number((await c.deploymentTransaction().wait()).gasUsed), note: "one-off" });
  }
  await escrow.setDisputeResolver(dispute.target);
  await reputation.setUpdater(escrow.target, true);
  await reputation.setUpdater(dispute.target, true);
  await registry.setTokenAllowed(usdc.target, true);
  await registry.grantRole(ethers.id("ARBITER_ROLE"), arbiter.address);

  await gas("registerAs(CLIENT) first time", registry.connect(client).registerAs(ethers.id("CLIENT_ROLE")));
  await gas("registerAs(FREELANCER) first time", registry.connect(freelancer).registerAs(ethers.id("FREELANCER_ROLE")));
  await gas("registerAs(CLIENT) again (no-op)", registry.connect(client).registerAs(ethers.id("CLIENT_ROLE")), "role already held: no SSTORE");

  const deadline = (await ethers.provider.getBlock("latest")).timestamp + 30 * 86400;
  const create = (n, opts = {}) => {
    const amounts = Array(n).fill(ethers.parseEther("0.1"));
    const total = amounts.reduce((a, b) => a + b, 0n);
    return escrow.connect(client).createEscrow(freelancer.address, ETH, amounts, deadline, h("t"), { value: total, ...opts });
  };

  // createEscrow scaling with milestone count (ETH)
  for (const n of [1, 2, 3, 5, 10, 20]) await gas(`createEscrow ETH, ${n} milestone(s)`, create(n));

  // ERC20 path
  await usdc.connect(client).faucet();
  await gas("mUSDC approve", usdc.connect(client).approve(escrow.target, 10_000n * 10n ** 6n));
  await gas(
    "createEscrow mUSDC, 1 milestone",
    escrow.connect(client).createEscrow(freelancer.address, usdc.target, [1000n * 10n ** 6n], deadline, h("t")),
    "safeTransferFrom + 2x balanceOf check"
  );
  await gas(
    "createEscrow mUSDC, 3 milestones",
    escrow.connect(client).createEscrow(freelancer.address, usdc.target, [1n * 10n ** 6n, 2n * 10n ** 6n, 3n * 10n ** 6n], deadline, h("t"))
  );

  // full lifecycle on a 3-milestone ETH job (#3)
  const id = 3;
  await gas("acceptEscrow", escrow.connect(freelancer).acceptEscrow(id));
  await gas("submitMilestone (first submit)", escrow.connect(freelancer).submitMilestone(id, 0, h("d0")));
  await gas("submitMilestone (re-submit)", escrow.connect(freelancer).submitMilestone(id, 0, h("d0b")), "state unchanged, event only");
  await gas("approveMilestone (not last)", escrow.connect(client).approveMilestone(id, 0), "first credit to freelancer + fee slot");
  await escrow.connect(freelancer).submitMilestone(id, 1, h("d1"));
  await gas("approveMilestone (not last, warm balances)", escrow.connect(client).approveMilestone(id, 1));
  await escrow.connect(freelancer).submitMilestone(id, 2, h("d2"));
  await gas("approveMilestone (last -> Completed + Reputation call)", escrow.connect(client).approveMilestone(id, 2), "cross-contract");
  await gas("rateCounterparty (Reputation call)", escrow.connect(client).rateCounterparty(id, 5), "cross-contract");
  await gas("withdraw ETH", escrow.connect(freelancer).withdraw(ETH));

  // cancel (#1)
  await gas("cancelEscrow", escrow.connect(client).cancelEscrow(1));

  // dispute flow (#4, 5 milestones)
  await escrow.connect(freelancer).acceptEscrow(4);
  await gas("openDispute (Dispute -> Escrow call)", dispute.connect(client).openDispute(4, h("r")), "cross-contract");
  await gas("submitEvidence", dispute.connect(freelancer).submitEvidence(1, h("e")));
  await gas("assignArbiter", dispute.connect(admin).assignArbiter(1, arbiter.address));
  await gas("resolveDispute (Dispute -> Escrow -> Reputation)", dispute.connect(arbiter).resolveDispute(1, 6000, h("ruling")), "2 cross-contract calls");

  // timeout refund (#5, 10 milestones, accepted)
  await escrow.connect(freelancer).acceptEscrow(5);
  await ethers.provider.send("evm_increaseTime", [31 * 86400]);
  await ethers.provider.send("evm_mine", []);
  await gas("claimTimeoutRefund, 10 milestones", escrow.connect(arbiter).claimTimeoutRefund(5), "loops all milestones");
  await gas("claimTimeoutRefund, 2 milestones (never accepted)", escrow.connect(arbiter).claimTimeoutRefund(2));

  // admin
  await gas("setPlatformFee", registry.setPlatformFee(300));
  await gas("pause", registry.pause());
  await gas("unpause", registry.unpause());
  await gas("withdrawFees ETH", escrow.withdrawFees(ETH, admin.address));

  const out = rows;
  const dir = path.resolve(__dirname, "..", "..", "docs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "gas-benchmark.json"), JSON.stringify(out, null, 2));
  console.table(out);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
