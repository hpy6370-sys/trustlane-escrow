const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  STATUS,
  MS,
  FEE_BPS,
  ETH,
  hash,
  deploySystem,
  futureDeadline,
  createEthEscrow,
  createActiveEscrow,
} = require("./fixture");

const fee = (x) => (x * BigInt(FEE_BPS)) / 10000n;

describe("EscrowManager", () => {
  describe("createEscrow", () => {
    it("creates a funded ETH escrow with milestones", async () => {
      const ctx = await loadFixture(deploySystem);
      const { escrow, client, freelancer } = ctx;
      const amounts = [ethers.parseEther("1"), ethers.parseEther("2")];
      const deadline = await futureDeadline();
      const tx = escrow.connect(client).createEscrow(freelancer.address, ETH, amounts, deadline, hash("terms"), {
        value: ethers.parseEther("3"),
      });
      await expect(tx)
        .to.emit(escrow, "EscrowCreated")
        .withArgs(1, client.address, freelancer.address, ETH, ethers.parseEther("3"), 2, deadline, hash("terms"));
      await expect(tx).to.changeEtherBalances([client, escrow], [ethers.parseEther("-3"), ethers.parseEther("3")]);

      const e = await escrow.getEscrow(1);
      expect(e.status).to.equal(STATUS.Created);
      expect(e.total).to.equal(ethers.parseEther("3"));
      expect(e.feeBps).to.equal(FEE_BPS);
      const ms = await escrow.getMilestones(1);
      expect(ms.length).to.equal(2);
      expect(ms[1].amount).to.equal(ethers.parseEther("2"));
      expect(ms[1].state).to.equal(MS.Pending);
    });

    it("creates an ERC20 (mUSDC) escrow pulled via allowance", async () => {
      const { escrow, usdc, client, freelancer } = await loadFixture(deploySystem);
      await usdc.connect(client).faucet();
      const amount = 5_000n * 10n ** 6n;
      await usdc.connect(client).approve(escrow.target, amount);
      await expect(
        escrow.connect(client).createEscrow(freelancer.address, usdc.target, [amount], await futureDeadline(), hash("t"))
      ).to.changeTokenBalances(usdc, [client, escrow], [-amount, amount]);
    });

    it("requires CLIENT role for the sender and FREELANCER role for the payee", async () => {
      const ctx = await loadFixture(deploySystem);
      const { escrow, outsider, client, freelancer } = ctx;
      const d = await futureDeadline();
      await expect(
        escrow.connect(outsider).createEscrow(freelancer.address, ETH, [1n], d, hash("t"), { value: 1n })
      ).to.be.revertedWithCustomError(escrow, "MissingRole");
      await expect(
        escrow.connect(client).createEscrow(outsider.address, ETH, [1n], d, hash("t"), { value: 1n })
      ).to.be.revertedWithCustomError(escrow, "MissingRole");
    });

    it("validates freelancer, milestones, deadline and payment", async () => {
      const { escrow, client, freelancer, usdc, registry } = await loadFixture(deploySystem);
      const d = await futureDeadline();
      const c = escrow.connect(client);
      await expect(c.createEscrow(client.address, ETH, [1n], d, hash("t"), { value: 1n }))
        .to.be.revertedWithCustomError(escrow, "InvalidParams")
        .withArgs("freelancer");
      await expect(c.createEscrow(freelancer.address, ETH, [], d, hash("t")))
        .to.be.revertedWithCustomError(escrow, "InvalidParams")
        .withArgs("milestones");
      await expect(c.createEscrow(freelancer.address, ETH, Array(21).fill(1n), d, hash("t"), { value: 21n }))
        .to.be.revertedWithCustomError(escrow, "InvalidParams")
        .withArgs("milestones");
      await expect(c.createEscrow(freelancer.address, ETH, [1n, 0n], d, hash("t"), { value: 1n }))
        .to.be.revertedWithCustomError(escrow, "InvalidParams")
        .withArgs("amount");
      await expect(c.createEscrow(freelancer.address, ETH, [1n], (await time.latest()) - 1, hash("t"), { value: 1n }))
        .to.be.revertedWithCustomError(escrow, "InvalidParams")
        .withArgs("deadline");
      await expect(c.createEscrow(freelancer.address, ETH, [1n], d + 400 * 86400, hash("t"), { value: 1n }))
        .to.be.revertedWithCustomError(escrow, "InvalidParams")
        .withArgs("deadline");
      await expect(c.createEscrow(freelancer.address, ETH, [10n], d, hash("t"), { value: 9n }))
        .to.be.revertedWithCustomError(escrow, "IncorrectPayment")
        .withArgs(10n, 9n);
      await expect(c.createEscrow(freelancer.address, usdc.target, [10n], d, hash("t"), { value: 1n }))
        .to.be.revertedWithCustomError(escrow, "IncorrectPayment")
        .withArgs(0n, 1n);
      await registry.setTokenAllowed(usdc.target, false);
      await expect(c.createEscrow(freelancer.address, usdc.target, [10n], d, hash("t"))).to.be.revertedWithCustomError(
        escrow,
        "TokenNotAllowed"
      );
    });

    it("accepts exactly 20 milestones (upper boundary)", async () => {
      const { escrow, client, freelancer } = await loadFixture(deploySystem);
      await escrow
        .connect(client)
        .createEscrow(freelancer.address, ETH, Array(20).fill(1n), await futureDeadline(), hash("t"), { value: 20n });
      expect((await escrow.getMilestones(1)).length).to.equal(20);
    });

    it("snapshots the fee so later fee changes do not affect live jobs", async () => {
      const ctx = await loadFixture(deploySystem);
      const { id } = await createActiveEscrow(ctx, ["1"]);
      await ctx.registry.setPlatformFee(1000);
      await ctx.escrow.connect(ctx.freelancer).submitMilestone(id, 0, hash("d"));
      await ctx.escrow.connect(ctx.client).approveMilestone(id, 0);
      expect(await ctx.escrow.accruedFees(ETH)).to.equal(fee(ethers.parseEther("1")));
    });
  });

  describe("accept / cancel", () => {
    it("only the named freelancer can accept, and only before the deadline", async () => {
      const ctx = await loadFixture(deploySystem);
      const { escrow, freelancer, freelancer2 } = ctx;
      const { id, deadline } = await createEthEscrow(ctx);
      await expect(escrow.connect(freelancer2).acceptEscrow(id)).to.be.revertedWithCustomError(escrow, "NotAuthorized");
      await time.increaseTo(deadline + 1);
      await expect(escrow.connect(freelancer).acceptEscrow(id)).to.be.revertedWithCustomError(escrow, "DeadlinePassed");
    });

    it("moves Created -> Active on accept", async () => {
      const ctx = await loadFixture(deploySystem);
      const { id } = await createEthEscrow(ctx);
      await expect(ctx.escrow.connect(ctx.freelancer).acceptEscrow(id))
        .to.emit(ctx.escrow, "EscrowAccepted")
        .withArgs(id, ctx.freelancer.address);
      expect((await ctx.escrow.getEscrow(id)).status).to.equal(STATUS.Active);
    });

    it("client cancels before acceptance and gets a full credit", async () => {
      const ctx = await loadFixture(deploySystem);
      const { id, total } = await createEthEscrow(ctx);
      await expect(ctx.escrow.connect(ctx.client).cancelEscrow(id)).to.emit(ctx.escrow, "EscrowCancelled").withArgs(id, total);
      expect(await ctx.escrow.balances(ctx.client.address, ETH)).to.equal(total);
      expect((await ctx.escrow.getEscrow(id)).status).to.equal(STATUS.Cancelled);
    });

    it("cannot cancel after acceptance or by someone else", async () => {
      const ctx = await loadFixture(deploySystem);
      const a = await createEthEscrow(ctx);
      await expect(ctx.escrow.connect(ctx.freelancer).cancelEscrow(a.id)).to.be.revertedWithCustomError(
        ctx.escrow,
        "NotAuthorized"
      );
      await ctx.escrow.connect(ctx.freelancer).acceptEscrow(a.id);
      await expect(ctx.escrow.connect(ctx.client).cancelEscrow(a.id))
        .to.be.revertedWithCustomError(ctx.escrow, "WrongStatus")
        .withArgs(STATUS.Active);
    });
  });

  describe("milestones", () => {
    it("freelancer submits, client approves, freelancer is credited minus fee", async () => {
      const ctx = await loadFixture(deploySystem);
      const { escrow, client, freelancer } = ctx;
      const { id, amounts } = await createActiveEscrow(ctx, ["1", "2"]);
      await expect(escrow.connect(freelancer).submitMilestone(id, 0, hash("v1")))
        .to.emit(escrow, "MilestoneSubmitted")
        .withArgs(id, 0, hash("v1"));
      await expect(escrow.connect(client).approveMilestone(id, 0))
        .to.emit(escrow, "MilestoneApproved")
        .withArgs(id, 0, amounts[0] - fee(amounts[0]), fee(amounts[0]));
      expect(await escrow.balances(freelancer.address, ETH)).to.equal(amounts[0] - fee(amounts[0]));
      expect((await escrow.getEscrow(id)).status).to.equal(STATUS.Active);
    });

    it("completes the escrow and updates reputation after the last approval", async () => {
      const ctx = await loadFixture(deploySystem);
      const { escrow, reputation, client, freelancer } = ctx;
      const { id } = await createActiveEscrow(ctx, ["1", "2"]);
      for (const i of [0, 1]) await escrow.connect(freelancer).submitMilestone(id, i, hash(`d${i}`));
      await escrow.connect(client).approveMilestone(id, 0);
      await expect(escrow.connect(client).approveMilestone(id, 1))
        .to.emit(escrow, "EscrowCompleted")
        .withArgs(id)
        .and.to.emit(reputation, "CompletionRecorded")
        .withArgs(client.address, freelancer.address);
      expect((await escrow.getEscrow(id)).status).to.equal(STATUS.Completed);
      expect((await reputation.recordOf(freelancer.address)).completedJobs).to.equal(1);
    });

    it("allows re-submission but not approval of an unsubmitted or approved milestone", async () => {
      const ctx = await loadFixture(deploySystem);
      const { escrow, client, freelancer } = ctx;
      const { id } = await createActiveEscrow(ctx, ["1", "1"]);
      await expect(escrow.connect(client).approveMilestone(id, 0))
        .to.be.revertedWithCustomError(escrow, "WrongMilestoneState")
        .withArgs(0, MS.Pending);
      await escrow.connect(freelancer).submitMilestone(id, 0, hash("v1"));
      await escrow.connect(freelancer).submitMilestone(id, 0, hash("v2")); // revision
      await escrow.connect(client).approveMilestone(id, 0);
      await expect(escrow.connect(client).approveMilestone(id, 0)).to.be.revertedWithCustomError(escrow, "WrongMilestoneState");
      await expect(escrow.connect(freelancer).submitMilestone(id, 0, hash("v3"))).to.be.revertedWithCustomError(
        escrow,
        "WrongMilestoneState"
      );
    });

    it("rejects wrong caller, out-of-range index and empty deliverable hash", async () => {
      const ctx = await loadFixture(deploySystem);
      const { escrow, client, freelancer, outsider } = ctx;
      const { id } = await createActiveEscrow(ctx, ["1"]);
      await expect(escrow.connect(client).submitMilestone(id, 0, hash("x"))).to.be.revertedWithCustomError(escrow, "NotAuthorized");
      await expect(escrow.connect(freelancer).submitMilestone(id, 1, hash("x")))
        .to.be.revertedWithCustomError(escrow, "InvalidParams")
        .withArgs("index");
      await expect(escrow.connect(freelancer).submitMilestone(id, 0, ethers.ZeroHash))
        .to.be.revertedWithCustomError(escrow, "InvalidParams")
        .withArgs("hash");
      await escrow.connect(freelancer).submitMilestone(id, 0, hash("x"));
      await expect(escrow.connect(outsider).approveMilestone(id, 0)).to.be.revertedWithCustomError(escrow, "NotAuthorized");
      await expect(escrow.connect(client).approveMilestone(id, 5))
        .to.be.revertedWithCustomError(escrow, "InvalidParams")
        .withArgs("index");
    });

    it("cannot submit on a Created (not yet accepted) escrow", async () => {
      const ctx = await loadFixture(deploySystem);
      const { id } = await createEthEscrow(ctx, ["1"]);
      await expect(ctx.escrow.connect(ctx.freelancer).submitMilestone(id, 0, hash("x")))
        .to.be.revertedWithCustomError(ctx.escrow, "WrongStatus")
        .withArgs(STATUS.Created);
    });

    it("zero fee works (boundary)", async () => {
      const ctx = await loadFixture(deploySystem);
      await ctx.registry.setPlatformFee(0);
      const { id, total } = await createActiveEscrow(ctx, ["1"]);
      await ctx.escrow.connect(ctx.freelancer).submitMilestone(id, 0, hash("x"));
      await ctx.escrow.connect(ctx.client).approveMilestone(id, 0);
      expect(await ctx.escrow.balances(ctx.freelancer.address, ETH)).to.equal(total);
      expect(await ctx.escrow.accruedFees(ETH)).to.equal(0);
    });
  });

  describe("timeout refund", () => {
    it("cannot be claimed before the deadline", async () => {
      const ctx = await loadFixture(deploySystem);
      const { id } = await createActiveEscrow(ctx, ["1"]);
      await expect(ctx.escrow.claimTimeoutRefund(id)).to.be.revertedWithCustomError(ctx.escrow, "DeadlineNotReached");
    });

    it("refunds only undelivered milestones and penalises the freelancer; anyone can trigger", async () => {
      const ctx = await loadFixture(deploySystem);
      const { escrow, reputation, client, freelancer, outsider } = ctx;
      const { id, amounts, deadline } = await createActiveEscrow(ctx, ["1", "2"]);
      await escrow.connect(freelancer).submitMilestone(id, 0, hash("x"));
      await escrow.connect(client).approveMilestone(id, 0);
      await time.increaseTo(deadline + 1);
      await expect(escrow.connect(outsider).claimTimeoutRefund(id))
        .to.emit(escrow, "TimeoutRefunded")
        .withArgs(id, amounts[1])
        .and.to.emit(reputation, "TimeoutRecorded")
        .withArgs(freelancer.address);
      expect(await escrow.balances(client.address, ETH)).to.equal(amounts[1]);
      const ms = await escrow.getMilestones(id);
      expect(ms[0].state).to.equal(MS.Approved);
      expect(ms[1].state).to.equal(MS.Refunded);
      expect((await escrow.getEscrow(id)).status).to.equal(STATUS.Refunded);
    });

    it("does not penalise when the job was never accepted", async () => {
      const ctx = await loadFixture(deploySystem);
      const { id, total, deadline } = await createEthEscrow(ctx, ["1"]);
      await time.increaseTo(deadline + 1);
      await expect(ctx.escrow.claimTimeoutRefund(id)).not.to.emit(ctx.reputation, "TimeoutRecorded");
      expect(await ctx.escrow.balances(ctx.client.address, ETH)).to.equal(total);
    });

    it("is blocked while a delivered milestone awaits review", async () => {
      const ctx = await loadFixture(deploySystem);
      const { id, deadline } = await createActiveEscrow(ctx, ["1", "1"]);
      await ctx.escrow.connect(ctx.freelancer).submitMilestone(id, 1, hash("x"));
      await time.increaseTo(deadline + 1);
      await expect(ctx.escrow.claimTimeoutRefund(id))
        .to.be.revertedWithCustomError(ctx.escrow, "MilestoneUnderReview")
        .withArgs(1);
    });

    it("cannot be claimed twice", async () => {
      const ctx = await loadFixture(deploySystem);
      const { id, deadline } = await createEthEscrow(ctx, ["1"]);
      await time.increaseTo(deadline + 1);
      await ctx.escrow.claimTimeoutRefund(id);
      await expect(ctx.escrow.claimTimeoutRefund(id))
        .to.be.revertedWithCustomError(ctx.escrow, "WrongStatus")
        .withArgs(STATUS.Refunded);
    });
  });

  describe("withdraw (pull payments)", () => {
    it("pays out ETH and zeroes the balance", async () => {
      const ctx = await loadFixture(deploySystem);
      const { id, total } = await createEthEscrow(ctx, ["1"]);
      await ctx.escrow.connect(ctx.client).cancelEscrow(id);
      const tx = ctx.escrow.connect(ctx.client).withdraw(ETH);
      await expect(tx).to.changeEtherBalances([ctx.client, ctx.escrow], [total, -total]);
      await expect(tx).to.emit(ctx.escrow, "Withdrawal").withArgs(ctx.client.address, ETH, total);
      await expect(ctx.escrow.connect(ctx.client).withdraw(ETH)).to.be.revertedWithCustomError(ctx.escrow, "NothingToWithdraw");
    });

    it("pays out ERC20", async () => {
      const { escrow, usdc, client, freelancer } = await loadFixture(deploySystem);
      await usdc.connect(client).faucet();
      const amt = 1_000n * 10n ** 6n;
      await usdc.connect(client).approve(escrow.target, amt);
      await escrow.connect(client).createEscrow(freelancer.address, usdc.target, [amt], await futureDeadline(), hash("t"));
      await escrow.connect(freelancer).acceptEscrow(1);
      await escrow.connect(freelancer).submitMilestone(1, 0, hash("d"));
      await escrow.connect(client).approveMilestone(1, 0);
      const net = amt - fee(amt);
      await expect(escrow.connect(freelancer).withdraw(usdc.target)).to.changeTokenBalance(usdc, freelancer, net);
    });

    it("admin withdraws accrued fees; others cannot", async () => {
      const ctx = await loadFixture(deploySystem);
      const { escrow, admin, client, freelancer, outsider } = ctx;
      const { id, total } = await createActiveEscrow(ctx, ["4"]);
      await escrow.connect(freelancer).submitMilestone(id, 0, hash("d"));
      await escrow.connect(client).approveMilestone(id, 0);
      await expect(escrow.connect(outsider).withdrawFees(ETH, outsider.address)).to.be.revertedWithCustomError(
        escrow,
        "NotAuthorized"
      );
      await expect(escrow.connect(admin).withdrawFees(ETH, ethers.ZeroAddress)).to.be.revertedWithCustomError(escrow, "InvalidParams");
      const tx = escrow.connect(admin).withdrawFees(ETH, outsider.address);
      await expect(tx).to.emit(escrow, "FeesWithdrawn").withArgs(ETH, outsider.address, fee(total));
      await expect(tx).to.changeEtherBalance(outsider, fee(total));
      await expect(escrow.connect(admin).withdrawFees(ETH, admin.address)).to.be.revertedWithCustomError(escrow, "NothingToWithdraw");
    });

    it("contract stays fully collateralised: balance == credited + fees after a full cycle", async () => {
      const ctx = await loadFixture(deploySystem);
      const { escrow, client, freelancer } = ctx;
      const { id } = await createActiveEscrow(ctx, ["1", "1.5"]);
      await createEthEscrow(ctx, ["0.7"]); // still locked
      for (const i of [0, 1]) {
        await escrow.connect(freelancer).submitMilestone(id, i, hash(`d${i}`));
        await escrow.connect(client).approveMilestone(id, i);
      }
      const held = await ethers.provider.getBalance(escrow.target);
      const credited = (await escrow.balances(freelancer.address, ETH)) + (await escrow.accruedFees(ETH));
      const locked = ethers.parseEther("0.7");
      expect(held).to.equal(credited + locked);
    });
  });

  describe("pause (circuit breaker)", () => {
    it("blocks new money and progress but keeps exit paths open", async () => {
      const ctx = await loadFixture(deploySystem);
      const { escrow, registry, client, freelancer } = ctx;
      const a = await createEthEscrow(ctx, ["1"]);
      const b = await createActiveEscrow(ctx, ["1"]);
      await registry.pause();
      const d = await futureDeadline();
      await expect(
        escrow.connect(client).createEscrow(freelancer.address, ETH, [1n], d, hash("t"), { value: 1n })
      ).to.be.revertedWithCustomError(escrow, "PlatformPaused");
      await expect(escrow.connect(freelancer).acceptEscrow(a.id)).to.be.revertedWithCustomError(escrow, "PlatformPaused");
      await expect(escrow.connect(freelancer).submitMilestone(b.id, 0, hash("x"))).to.be.revertedWithCustomError(
        escrow,
        "PlatformPaused"
      );
      // exit paths
      await escrow.connect(client).cancelEscrow(a.id);
      await escrow.connect(client).withdraw(ETH);
    });
  });

  describe("ratings", () => {
    it("each party rates once after completion; outsiders and open jobs rejected", async () => {
      const ctx = await loadFixture(deploySystem);
      const { escrow, reputation, client, freelancer, outsider } = ctx;
      const { id } = await createActiveEscrow(ctx, ["1"]);
      await expect(escrow.connect(client).rateCounterparty(id, 5)).to.be.revertedWithCustomError(escrow, "WrongStatus");
      await escrow.connect(freelancer).submitMilestone(id, 0, hash("d"));
      await escrow.connect(client).approveMilestone(id, 0);
      await expect(escrow.connect(client).rateCounterparty(id, 5))
        .to.emit(escrow, "CounterpartyRated")
        .withArgs(id, client.address, freelancer.address, 5)
        .and.to.emit(reputation, "Rated");
      await expect(escrow.connect(client).rateCounterparty(id, 4)).to.be.revertedWithCustomError(escrow, "AlreadyRated");
      await escrow.connect(freelancer).rateCounterparty(id, 4);
      await expect(escrow.connect(outsider).rateCounterparty(id, 3)).to.be.revertedWithCustomError(escrow, "NotAuthorized");
      await expect(escrow.connect(freelancer).rateCounterparty(id, 3)).to.be.revertedWithCustomError(escrow, "AlreadyRated");
    });

    it("rejects scores outside 1..5", async () => {
      const ctx = await loadFixture(deploySystem);
      const { id } = await createActiveEscrow(ctx, ["1"]);
      await ctx.escrow.connect(ctx.freelancer).submitMilestone(id, 0, hash("d"));
      await ctx.escrow.connect(ctx.client).approveMilestone(id, 0);
      await expect(ctx.escrow.connect(ctx.client).rateCounterparty(id, 6)).to.be.revertedWithCustomError(
        ctx.reputation,
        "InvalidScore"
      );
      await expect(ctx.escrow.connect(ctx.client).rateCounterparty(id, 0)).to.be.revertedWithCustomError(
        ctx.reputation,
        "InvalidScore"
      );
    });
  });

  describe("module wiring", () => {
    it("only DisputeResolution may freeze or settle an escrow", async () => {
      const ctx = await loadFixture(deploySystem);
      const { id } = await createActiveEscrow(ctx, ["1"]);
      await expect(ctx.escrow.connect(ctx.client).markDisputed(id)).to.be.revertedWithCustomError(ctx.escrow, "NotAuthorized");
      await expect(ctx.escrow.connect(ctx.admin).settleDispute(id, 5000)).to.be.revertedWithCustomError(
        ctx.escrow,
        "NotAuthorized"
      );
    });

    it("dispute resolver can be set once, by admin only", async () => {
      const ctx = await loadFixture(deploySystem);
      await expect(ctx.escrow.connect(ctx.outsider).setDisputeResolver(ctx.outsider.address)).to.be.revertedWithCustomError(
        ctx.escrow,
        "NotAuthorized"
      );
      await expect(ctx.escrow.setDisputeResolver(ctx.outsider.address)).to.be.revertedWithCustomError(
        ctx.escrow,
        "ResolverAlreadySet"
      );
    });

    it("rejects calls on a non-existent escrow id", async () => {
      const { escrow, client } = await loadFixture(deploySystem);
      await expect(escrow.connect(client).cancelEscrow(999))
        .to.be.revertedWithCustomError(escrow, "WrongStatus")
        .withArgs(STATUS.None);
    });
  });
});
