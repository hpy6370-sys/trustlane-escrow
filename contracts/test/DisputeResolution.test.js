const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { ROLE, STATUS, FEE_BPS, ETH, hash, deploySystem, createEthEscrow, createActiveEscrow } = require("./fixture");

const D = { None: 0n, Open: 1n, UnderReview: 2n, Resolved: 3n };

async function disputedFixture() {
  const ctx = await deploySystem();
  const job = await createActiveEscrow(ctx, ["1", "3"]);
  // first milestone delivered and paid, second one is contested
  await ctx.escrow.connect(ctx.freelancer).submitMilestone(job.id, 0, hash("m0"));
  await ctx.escrow.connect(ctx.client).approveMilestone(job.id, 0);
  await ctx.escrow.connect(ctx.freelancer).submitMilestone(job.id, 1, hash("m1"));
  await ctx.dispute.connect(ctx.client).openDispute(job.id, hash("late and incomplete"));
  return { ...ctx, job, disputeId: 1n };
}

describe("DisputeResolution", () => {
  describe("openDispute", () => {
    it("a party opens a dispute and the escrow freezes", async () => {
      const ctx = await loadFixture(deploySystem);
      const { id } = await createActiveEscrow(ctx, ["1"]);
      await expect(ctx.dispute.connect(ctx.freelancer).openDispute(id, hash("client unresponsive")))
        .to.emit(ctx.dispute, "DisputeOpened")
        .withArgs(1, id, ctx.freelancer.address, hash("client unresponsive"))
        .and.to.emit(ctx.escrow, "EscrowDisputed")
        .withArgs(id);
      expect((await ctx.escrow.getEscrow(id)).status).to.equal(STATUS.Disputed);
      expect(await ctx.dispute.disputeOfEscrow(id)).to.equal(1);
      // frozen: no approvals
      await expect(ctx.escrow.connect(ctx.client).approveMilestone(id, 0)).to.be.revertedWithCustomError(ctx.escrow, "WrongStatus");
    });

    it("outsiders cannot open; non-Active escrows cannot be disputed; no double dispute", async () => {
      const ctx = await loadFixture(deploySystem);
      const created = await createEthEscrow(ctx, ["1"]);
      await expect(ctx.dispute.connect(ctx.outsider).openDispute(created.id, hash("x"))).to.be.revertedWithCustomError(
        ctx.dispute,
        "NotAuthorized"
      );
      await expect(ctx.dispute.connect(ctx.client).openDispute(created.id, hash("x")))
        .to.be.revertedWithCustomError(ctx.escrow, "WrongStatus")
        .withArgs(STATUS.Created);
      await ctx.escrow.connect(ctx.freelancer).acceptEscrow(created.id);
      await ctx.dispute.connect(ctx.client).openDispute(created.id, hash("x"));
      await expect(ctx.dispute.connect(ctx.freelancer).openDispute(created.id, hash("y")))
        .to.be.revertedWithCustomError(ctx.escrow, "WrongStatus")
        .withArgs(STATUS.Disputed);
    });

    it("is blocked while paused", async () => {
      const ctx = await loadFixture(deploySystem);
      const { id } = await createActiveEscrow(ctx, ["1"]);
      await ctx.registry.pause();
      await expect(ctx.dispute.connect(ctx.client).openDispute(id, hash("x"))).to.be.revertedWithCustomError(
        ctx.dispute,
        "PlatformPaused"
      );
    });
  });

  describe("evidence and arbiter assignment", () => {
    it("both parties submit evidence; outsiders and empty hashes rejected", async () => {
      const ctx = await loadFixture(disputedFixture);
      const { dispute, client, freelancer, outsider, disputeId } = ctx;
      await expect(dispute.connect(freelancer).submitEvidence(disputeId, hash("commit log")))
        .to.emit(dispute, "EvidenceSubmitted")
        .withArgs(disputeId, freelancer.address, hash("commit log"));
      await dispute.connect(client).submitEvidence(disputeId, hash("chat export"));
      expect((await dispute.getDispute(disputeId)).evidenceCount).to.equal(2);
      await expect(dispute.connect(outsider).submitEvidence(disputeId, hash("x"))).to.be.revertedWithCustomError(
        dispute,
        "NotAuthorized"
      );
      await expect(dispute.connect(client).submitEvidence(disputeId, ethers.ZeroHash)).to.be.revertedWithCustomError(
        dispute,
        "InvalidParams"
      );
    });

    it("admin assigns an arbiter; must hold ARBITER_ROLE and not be a party", async () => {
      const ctx = await loadFixture(disputedFixture);
      const { dispute, registry, admin, arbiter, outsider, client, disputeId } = ctx;
      await expect(dispute.connect(outsider).assignArbiter(disputeId, arbiter.address)).to.be.revertedWithCustomError(
        dispute,
        "NotAuthorized"
      );
      await expect(dispute.connect(admin).assignArbiter(disputeId, outsider.address)).to.be.revertedWithCustomError(
        dispute,
        "InvalidArbiter"
      );
      await registry.grantRole(ROLE.ARBITER, client.address);
      await expect(dispute.connect(admin).assignArbiter(disputeId, client.address)).to.be.revertedWithCustomError(
        dispute,
        "InvalidArbiter"
      );
      await expect(dispute.connect(admin).assignArbiter(disputeId, arbiter.address))
        .to.emit(dispute, "ArbiterAssigned")
        .withArgs(disputeId, arbiter.address);
      const d = await dispute.getDispute(disputeId);
      expect(d.status).to.equal(D.UnderReview);
      expect(d.arbiter).to.equal(arbiter.address);
    });

    it("cannot assign on a non-existent dispute", async () => {
      const ctx = await loadFixture(deploySystem);
      await expect(ctx.dispute.assignArbiter(42, ctx.arbiter.address))
        .to.be.revertedWithCustomError(ctx.dispute, "WrongStatus")
        .withArgs(D.None);
    });
  });

  describe("resolveDispute", () => {
    it("splits remaining funds, takes fee only from the freelancer share, records reputation", async () => {
      const ctx = await loadFixture(disputedFixture);
      const { dispute, escrow, reputation, arbiter, client, freelancer, job, disputeId } = ctx;
      await dispute.assignArbiter(disputeId, arbiter.address);

      const remaining = ethers.parseEther("3"); // milestone 0 already paid
      const toClient = (remaining * 7000n) / 10000n;
      const gross = remaining - toClient;
      const fee = (gross * BigInt(FEE_BPS)) / 10000n;
      const freelancerBefore = await escrow.balances(freelancer.address, ETH);

      await expect(dispute.connect(arbiter).resolveDispute(disputeId, 7000, hash("ruling")))
        .to.emit(dispute, "DisputeResolved")
        .withArgs(disputeId, job.id, arbiter.address, 7000, toClient, gross - fee, hash("ruling"))
        .and.to.emit(escrow, "DisputeSettled")
        .withArgs(job.id, toClient, gross - fee, fee)
        .and.to.emit(reputation, "DisputeRecorded")
        .withArgs(client.address, freelancer.address, 7000);

      expect(await escrow.balances(client.address, ETH)).to.equal(toClient);
      expect((await escrow.balances(freelancer.address, ETH)) - freelancerBefore).to.equal(gross - fee);
      expect((await escrow.getEscrow(job.id)).status).to.equal(STATUS.Resolved);
      expect((await reputation.recordOf(client.address)).disputesWon).to.equal(1);
      expect((await reputation.recordOf(freelancer.address)).disputesLost).to.equal(1);
    });

    it("handles 0 % and 100 % client share boundaries", async () => {
      for (const bps of [0, 10000]) {
        const ctx = await loadFixture(disputedFixture);
        await ctx.dispute.assignArbiter(ctx.disputeId, ctx.arbiter.address);
        await ctx.dispute.connect(ctx.arbiter).resolveDispute(ctx.disputeId, bps, hash("r"));
        const clientBal = await ctx.escrow.balances(ctx.client.address, ETH);
        expect(clientBal).to.equal(bps === 0 ? 0n : ethers.parseEther("3"));
      }
    });

    it("only the assigned, still-authorised arbiter can rule, once, with bps <= 10000", async () => {
      const ctx = await loadFixture(disputedFixture);
      const { dispute, registry, arbiter, outsider, client, disputeId } = ctx;
      await expect(dispute.connect(arbiter).resolveDispute(disputeId, 5000, hash("r")))
        .to.be.revertedWithCustomError(dispute, "WrongStatus")
        .withArgs(D.Open);
      await dispute.assignArbiter(disputeId, arbiter.address);
      await expect(dispute.connect(outsider).resolveDispute(disputeId, 5000, hash("r"))).to.be.revertedWithCustomError(
        dispute,
        "NotAuthorized"
      );
      await expect(dispute.connect(client).resolveDispute(disputeId, 10000, hash("r"))).to.be.revertedWithCustomError(
        dispute,
        "NotAuthorized"
      );
      await expect(dispute.connect(arbiter).resolveDispute(disputeId, 10001, hash("r"))).to.be.revertedWithCustomError(
        dispute,
        "InvalidParams"
      );
      await registry.revokeRole(ROLE.ARBITER, arbiter.address);
      await expect(dispute.connect(arbiter).resolveDispute(disputeId, 5000, hash("r"))).to.be.revertedWithCustomError(
        dispute,
        "InvalidArbiter"
      );
      await registry.grantRole(ROLE.ARBITER, arbiter.address);
      await dispute.connect(arbiter).resolveDispute(disputeId, 5000, hash("r"));
      await expect(dispute.connect(arbiter).resolveDispute(disputeId, 5000, hash("r")))
        .to.be.revertedWithCustomError(dispute, "WrongStatus")
        .withArgs(D.Resolved);
    });

    it("an even split leaves win/loss records untouched, and resolved jobs can be rated", async () => {
      const ctx = await loadFixture(disputedFixture);
      await ctx.dispute.assignArbiter(ctx.disputeId, ctx.arbiter.address);
      await ctx.dispute.connect(ctx.arbiter).resolveDispute(ctx.disputeId, 5000, hash("r"));
      const r = await ctx.reputation.recordOf(ctx.client.address);
      expect(r.disputesWon + r.disputesLost).to.equal(0);
      await ctx.escrow.connect(ctx.freelancer).rateCounterparty(ctx.job.id, 2);
    });

    it("a re-assigned arbiter replaces the old one", async () => {
      const ctx = await loadFixture(disputedFixture);
      const { dispute, registry, arbiter, outsider, disputeId } = ctx;
      await dispute.assignArbiter(disputeId, arbiter.address);
      await registry.grantRole(ROLE.ARBITER, outsider.address);
      await dispute.assignArbiter(disputeId, outsider.address);
      await expect(dispute.connect(arbiter).resolveDispute(disputeId, 0, hash("r"))).to.be.revertedWithCustomError(
        dispute,
        "NotAuthorized"
      );
      await dispute.connect(outsider).resolveDispute(disputeId, 0, hash("r"));
    });
  });
});
