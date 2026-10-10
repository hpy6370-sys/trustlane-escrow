const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySystem } = require("./fixture");

/** Reputation with the admin wallet registered as an updater so we can drive it directly. */
async function directFixture() {
  const ctx = await deploySystem();
  await ctx.reputation.setUpdater(ctx.admin.address, true);
  return ctx;
}

describe("Reputation", () => {
  it("only authorised modules can write", async () => {
    const { reputation, outsider, client, freelancer } = await loadFixture(deploySystem);
    const r = reputation.connect(outsider);
    await expect(r.recordCompletion(client.address, freelancer.address))
      .to.be.revertedWithCustomError(reputation, "NotUpdater")
      .withArgs(outsider.address);
    await expect(r.recordDisputeOutcome(client.address, freelancer.address, 0)).to.be.revertedWithCustomError(
      reputation,
      "NotUpdater"
    );
    await expect(r.recordTimeout(freelancer.address)).to.be.revertedWithCustomError(reputation, "NotUpdater");
    await expect(r.submitRating(client.address, freelancer.address, 5)).to.be.revertedWithCustomError(reputation, "NotUpdater");
  });

  it("only admin can authorise modules", async () => {
    const { reputation, outsider } = await loadFixture(deploySystem);
    await expect(reputation.connect(outsider).setUpdater(outsider.address, true))
      .to.be.revertedWithCustomError(reputation, "NotAdmin")
      .withArgs(outsider.address);
    await expect(reputation.setUpdater(outsider.address, true)).to.emit(reputation, "UpdaterSet").withArgs(outsider.address, true);
  });

  it("starts everyone at the base score", async () => {
    const { reputation, outsider } = await loadFixture(deploySystem);
    expect(await reputation.scoreOf(outsider.address)).to.equal(500);
  });

  it("applies the documented score formula", async () => {
    const { reputation, client, freelancer } = await loadFixture(directFixture);
    await reputation.recordCompletion(client.address, freelancer.address); // +20 each
    await reputation.recordCompletion(client.address, freelancer.address); // +20 each
    await reputation.recordDisputeOutcome(client.address, freelancer.address, 2000); // freelancer wins +10, client -40
    await reputation.recordTimeout(freelancer.address); // -30
    await reputation.submitRating(client.address, freelancer.address, 5);
    await reputation.submitRating(client.address, freelancer.address, 4); // avg 4.5 -> +75
    expect(await reputation.scoreOf(freelancer.address)).to.equal(500 + 40 + 10 - 30 + 75);
    expect(await reputation.scoreOf(client.address)).to.equal(500 + 40 - 40);
  });

  it("clamps the score to [0, 1000]", async () => {
    const { reputation, client, freelancer } = await loadFixture(directFixture);
    for (let i = 0; i < 20; i++) await reputation.recordTimeout(freelancer.address);
    expect(await reputation.scoreOf(freelancer.address)).to.equal(0);
    for (let i = 0; i < 30; i++) await reputation.recordCompletion(client.address, client.address);
    expect(await reputation.scoreOf(client.address)).to.equal(1000);
  });

  it("packs a user's whole record into one storage slot", async () => {
    const { reputation, client, freelancer } = await loadFixture(directFixture);
    await reputation.recordCompletion(client.address, freelancer.address);
    const r = await reputation.recordOf(freelancer.address);
    expect(r.completedJobs).to.equal(1);
    expect(r.reserved).to.equal(0);
  });
});
