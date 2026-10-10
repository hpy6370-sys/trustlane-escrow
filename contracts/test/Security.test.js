const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { ETH, hash, deploySystem, futureDeadline, createActiveEscrow } = require("./fixture");

describe("Security", () => {
  it("re-entrancy: a malicious receiver cannot withdraw twice", async () => {
    const ctx = await loadFixture(deploySystem);
    const { escrow, registry, freelancer } = ctx;
    const attacker = await ethers.deployContract("ReentrancyAttacker", [escrow.target, registry.target]);

    // An honest user's funds are also sitting in the contract.
    await createActiveEscrow(ctx, ["5"]);

    const stake = ethers.parseEther("1");
    await attacker.setup(freelancer.address, await futureDeadline(), { value: stake });
    expect(await escrow.balances(attacker.target, ETH)).to.equal(stake);

    await expect(attacker.attack()).to.changeEtherBalance(attacker, stake);
    expect(await attacker.reentryAttempts()).to.equal(1);
    expect(await attacker.reentrySucceeded()).to.equal(false);
    expect(await escrow.balances(attacker.target, ETH)).to.equal(0);
    // honest user's 5 ETH untouched
    expect(await ethers.provider.getBalance(escrow.target)).to.equal(ethers.parseEther("5"));
  });

  it("direct ETH transfers to EscrowManager are rejected (no receive function)", async () => {
    const { escrow, outsider } = await loadFixture(deploySystem);
    await expect(outsider.sendTransaction({ to: escrow.target, value: 1n })).to.be.reverted;
  });

  it("parties cannot redirect funds: settlement and payouts always go to recorded addresses", async () => {
    const ctx = await loadFixture(deploySystem);
    const { escrow, client, freelancer, outsider } = ctx;
    const { id } = await createActiveEscrow(ctx, ["1"]);
    await escrow.connect(freelancer).submitMilestone(id, 0, hash("d"));
    await escrow.connect(client).approveMilestone(id, 0);
    // outsider has nothing to claim even though the job paid out
    await expect(escrow.connect(outsider).withdraw(ETH)).to.be.revertedWithCustomError(escrow, "NothingToWithdraw");
  });

  it("MockUSDC faucet is rate-limited", async () => {
    const { usdc, client } = await loadFixture(deploySystem);
    await usdc.connect(client).faucet();
    await expect(usdc.connect(client).faucet()).to.be.revertedWithCustomError(usdc, "FaucetCooldown");
    await time.increase(3600);
    await usdc.connect(client).faucet();
    expect(await usdc.balanceOf(client.address)).to.equal(20_000n * 10n ** 6n);
    expect(await usdc.decimals()).to.equal(6);
  });

  it("ERC20 escrow without enough allowance reverts and leaves no state behind", async () => {
    const { escrow, usdc, client, freelancer } = await loadFixture(deploySystem);
    await usdc.connect(client).faucet();
    await usdc.connect(client).approve(escrow.target, 10n);
    await expect(
      escrow.connect(client).createEscrow(freelancer.address, usdc.target, [11n], await futureDeadline(), hash("t"))
    ).to.be.revertedWithCustomError(usdc, "ERC20InsufficientAllowance");
    expect(await escrow.escrowCount()).to.equal(0);
  });
});
