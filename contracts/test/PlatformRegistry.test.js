const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { ROLE, FEE_BPS, deploySystem } = require("./fixture");

describe("PlatformRegistry", () => {
  describe("deployment", () => {
    it("sets admin, fee and allows native ETH", async () => {
      const { registry, admin } = await loadFixture(deploySystem);
      expect(await registry.hasRole(ROLE.ADMIN, admin.address)).to.equal(true);
      expect(await registry.feeBps()).to.equal(FEE_BPS);
      expect(await registry.allowedTokens(ethers.ZeroAddress)).to.equal(true);
    });

    it("rejects zero admin and fee above the cap", async () => {
      const F = await ethers.getContractFactory("PlatformRegistry");
      const [a] = await ethers.getSigners();
      await expect(F.deploy(ethers.ZeroAddress, 100)).to.be.revertedWithCustomError(F, "ZeroAddress");
      await expect(F.deploy(a.address, 1001)).to.be.revertedWithCustomError(F, "FeeTooHigh");
    });
  });

  describe("roles", () => {
    it("lets users self-register as Client or Freelancer and emits once", async () => {
      const { registry, outsider } = await loadFixture(deploySystem);
      await expect(registry.connect(outsider).registerAs(ROLE.CLIENT))
        .to.emit(registry, "SelfRegistered")
        .withArgs(outsider.address, ROLE.CLIENT);
      // second registration is a no-op, no duplicate event
      await expect(registry.connect(outsider).registerAs(ROLE.CLIENT)).not.to.emit(registry, "SelfRegistered");
      await registry.connect(outsider).registerAs(ROLE.FREELANCER);
      expect(await registry.rolesOf(outsider.address)).to.equal(2 + 4);
    });

    it("forbids self-assigning Arbiter or Admin", async () => {
      const { registry, outsider } = await loadFixture(deploySystem);
      await expect(registry.connect(outsider).registerAs(ROLE.ARBITER))
        .to.be.revertedWithCustomError(registry, "RoleNotSelfAssignable")
        .withArgs(ROLE.ARBITER);
      await expect(registry.connect(outsider).registerAs(ROLE.ADMIN)).to.be.revertedWithCustomError(
        registry,
        "RoleNotSelfAssignable"
      );
    });

    it("only Admin can grant and revoke Arbiter", async () => {
      const { registry, admin, outsider, arbiter } = await loadFixture(deploySystem);
      await expect(registry.connect(outsider).grantRole(ROLE.ARBITER, outsider.address))
        .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
        .withArgs(outsider.address, ROLE.ADMIN);
      await registry.connect(admin).revokeRole(ROLE.ARBITER, arbiter.address);
      expect(await registry.hasRole(ROLE.ARBITER, arbiter.address)).to.equal(false);
    });

    it("rolesOf returns a bitmask for every role", async () => {
      const { registry, admin, client, freelancer, arbiter, outsider } = await loadFixture(deploySystem);
      expect(await registry.rolesOf(admin.address)).to.equal(1);
      expect(await registry.rolesOf(client.address)).to.equal(2);
      expect(await registry.rolesOf(freelancer.address)).to.equal(4);
      expect(await registry.rolesOf(arbiter.address)).to.equal(8);
      expect(await registry.rolesOf(outsider.address)).to.equal(0);
    });
  });

  describe("admin settings", () => {
    it("updates the platform fee within the cap", async () => {
      const { registry } = await loadFixture(deploySystem);
      await expect(registry.setPlatformFee(500)).to.emit(registry, "PlatformFeeUpdated").withArgs(FEE_BPS, 500);
      await expect(registry.setPlatformFee(1001)).to.be.revertedWithCustomError(registry, "FeeTooHigh");
      await registry.setPlatformFee(1000); // boundary: exactly the cap is fine
      expect(await registry.feeBps()).to.equal(1000);
    });

    it("blocks non-admins from fee, token and pause settings", async () => {
      const { registry, outsider } = await loadFixture(deploySystem);
      const r = registry.connect(outsider);
      await expect(r.setPlatformFee(1)).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
      await expect(r.setTokenAllowed(outsider.address, true)).to.be.revertedWithCustomError(
        registry,
        "AccessControlUnauthorizedAccount"
      );
      await expect(r.pause()).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    });

    it("pause blocks self-registration until unpaused", async () => {
      const { registry, outsider } = await loadFixture(deploySystem);
      await registry.pause();
      await expect(registry.connect(outsider).registerAs(ROLE.CLIENT)).to.be.revertedWithCustomError(
        registry,
        "EnforcedPause"
      );
      await registry.unpause();
      await registry.connect(outsider).registerAs(ROLE.CLIENT);
    });

    it("toggles allowed tokens", async () => {
      const { registry, usdc } = await loadFixture(deploySystem);
      await expect(registry.setTokenAllowed(usdc.target, false)).to.emit(registry, "TokenAllowed").withArgs(usdc.target, false);
      expect(await registry.allowedTokens(usdc.target)).to.equal(false);
    });
  });
});
