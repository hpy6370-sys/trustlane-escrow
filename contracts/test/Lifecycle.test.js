const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { ROLE, STATUS, ETH, hash, deploySystem, futureDeadline } = require("./fixture");

/**
 * End-to-end scenario touching all 4 production contracts in one run. Also gives
 * the gas reporter realistic averages across several jobs.
 */
describe("Lifecycle (integration)", () => {
  it("runs happy path, dispute path and timeout path side by side", async () => {
    const ctx = await loadFixture(deploySystem);
    const { registry, escrow, dispute, reputation, usdc, admin, client, client2, freelancer, freelancer2, arbiter } = ctx;

    // --- Job A: 3-milestone mUSDC job, completed and rated
    await usdc.connect(client).faucet();
    const usd = (n) => BigInt(n) * 10n ** 6n;
    await usdc.connect(client).approve(escrow.target, usd(3000));
    await escrow
      .connect(client)
      .createEscrow(freelancer.address, usdc.target, [usd(500), usd(1000), usd(1500)], await futureDeadline(), hash("A"));
    const A = await escrow.escrowCount();
    await escrow.connect(freelancer).acceptEscrow(A);
    for (let i = 0; i < 3; i++) {
      await escrow.connect(freelancer).submitMilestone(A, i, hash(`A${i}`));
      await escrow.connect(client).approveMilestone(A, i);
    }
    await escrow.connect(client).rateCounterparty(A, 5);
    await escrow.connect(freelancer).rateCounterparty(A, 4);

    // --- Job B: ETH job disputed by client2, arbiter splits 60/40
    await escrow
      .connect(client2)
      .createEscrow(freelancer2.address, ETH, [ethers.parseEther("2")], await futureDeadline(), hash("B"), {
        value: ethers.parseEther("2"),
      });
    const B = await escrow.escrowCount();
    await escrow.connect(freelancer2).acceptEscrow(B);
    await escrow.connect(freelancer2).submitMilestone(B, 0, hash("B0"));
    await dispute.connect(client2).openDispute(B, hash("quality"));
    const dB = await dispute.disputeCount();
    await dispute.connect(client2).submitEvidence(dB, hash("screenshots"));
    await dispute.connect(freelancer2).submitEvidence(dB, hash("delivery receipt"));
    await dispute.connect(admin).assignArbiter(dB, arbiter.address);
    await dispute.connect(arbiter).resolveDispute(dB, 6000, hash("ruling B"));

    // --- Job C: ETH job never delivered, keeper triggers timeout refund
    const deadlineC = await futureDeadline(7);
    await escrow
      .connect(client)
      .createEscrow(freelancer2.address, ETH, [ethers.parseEther("0.5"), ethers.parseEther("0.5")], deadlineC, hash("C"), {
        value: ethers.parseEther("1"),
      });
    const C = await escrow.escrowCount();
    await escrow.connect(freelancer2).acceptEscrow(C);
    await time.increaseTo(deadlineC + 1);
    await escrow.connect(admin).claimTimeoutRefund(C);

    // --- Job D: cancelled before acceptance
    await escrow
      .connect(client2)
      .createEscrow(freelancer.address, ETH, [ethers.parseEther("0.3")], await futureDeadline(), hash("D"), {
        value: ethers.parseEther("0.3"),
      });
    const Dd = await escrow.escrowCount();
    await escrow.connect(client2).cancelEscrow(Dd);

    // --- everyone withdraws, admin sweeps fees
    await escrow.connect(freelancer).withdraw(usdc.target);
    await escrow.connect(client2).withdraw(ETH);
    await escrow.connect(freelancer2).withdraw(ETH);
    await escrow.connect(client).withdraw(ETH);
    await escrow.connect(admin).withdrawFees(usdc.target, admin.address);
    await escrow.connect(admin).withdrawFees(ETH, admin.address);

    // --- admin housekeeping tx types
    await registry.connect(admin).setPlatformFee(300);
    await registry.connect(admin).grantRole(ROLE.ARBITER, client2.address);
    await registry.connect(admin).revokeRole(ROLE.ARBITER, client2.address);
    await registry.connect(admin).pause();
    await registry.connect(admin).unpause();

    // --- assertions: all money left the contract, statuses and reputation right
    expect(await ethers.provider.getBalance(escrow.target)).to.equal(0);
    expect(await usdc.balanceOf(escrow.target)).to.equal(0);
    expect((await escrow.getEscrow(A)).status).to.equal(STATUS.Completed);
    expect((await escrow.getEscrow(B)).status).to.equal(STATUS.Resolved);
    expect((await escrow.getEscrow(C)).status).to.equal(STATUS.Refunded);
    expect((await escrow.getEscrow(Dd)).status).to.equal(STATUS.Cancelled);
    expect(await reputation.scoreOf(freelancer.address)).to.equal(500 + 20 + 100); // 1 job + 5-star
    expect(await reputation.scoreOf(freelancer2.address)).to.equal(500 - 40 - 30); // lost dispute + timeout
  });
});
