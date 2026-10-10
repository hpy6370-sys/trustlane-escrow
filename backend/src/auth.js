const crypto = require("crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const { ethers } = require("ethers");
const { badRequest, unauthorized, forbidden } = require("./errors");
const { requireAddress } = require("./validate");

/**
 * Wallet sign-in in the spirit of EIP-4361 (Sign-In with Ethereum):
 *   1. GET  /api/auth/nonce?address=0x..  -> server stores a one-time message
 *   2. wallet signs that exact message with personal_sign (no gas, no tx)
 *   3. POST /api/auth/verify {address, signature} -> server recovers the signer,
 *      burns the nonce and returns a JWT carrying the address + on-chain roles.
 */
function createAuth({ db, chain, config }) {
  async function resolveRoles(address) {
    const addr = address.toLowerCase();
    if (chain.available) {
      try {
        return await chain.rolesOnChain(addr);
      } catch (err) {
        console.warn(`[auth] on-chain role lookup failed, using indexed roles: ${err.shortMessage || err.message}`);
      }
    }
    const roles = db.prepare("SELECT role FROM user_roles WHERE address = ?").all(addr).map((r) => r.role);
    if (config.adminFallback.includes(addr) && !roles.includes("admin")) roles.push("admin");
    return roles;
  }

  function buildMessage(address, nonce, issuedAt, expiresAt) {
    return [
      `${config.siweDomain} wants you to sign in with your Ethereum account:`,
      ethers.getAddress(address),
      "",
      "Sign in to TrustLane Escrow. This request will not trigger a blockchain transaction or cost any gas.",
      "",
      `URI: http://${config.siweDomain}`,
      "Version: 1",
      `Chain ID: ${config.chainId}`,
      `Nonce: ${nonce}`,
      `Issued At: ${new Date(issuedAt).toISOString()}`,
      `Expiration Time: ${new Date(expiresAt).toISOString()}`,
    ].join("\n");
  }

  /** Middleware: requires a valid Bearer token; sets req.user = { address, roles }. */
  function requireAuth(req, _res, next) {
    const header = req.get("authorization") || "";
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token) return next(unauthorized());
    const payload = jwt.verify(token, config.jwtSecret); // throws -> errorHandler maps to 401
    req.user = { address: payload.sub, roles: payload.roles || [] };
    next();
  }

  /** Middleware factory: role is re-checked live (roles may be revoked after the JWT was issued). */
  function requireRole(...allowed) {
    return async (req, _res, next) => {
      if (!req.user) return next(unauthorized());
      const roles = await resolveRoles(req.user.address);
      if (!roles.some((r) => allowed.includes(r))) {
        return next(forbidden(`Requires role: ${allowed.join(" or ")}`));
      }
      req.user.roles = roles;
      next();
    };
  }

  const router = express.Router();

  router.get("/nonce", (req, res) => {
    const address = requireAddress(req.query.address, "address");
    const nonce = crypto.randomBytes(16).toString("hex");
    const now = Date.now();
    const expiresAt = now + config.nonceTtlMs;
    const message = buildMessage(address, nonce, now, expiresAt);
    db.prepare(
      `INSERT INTO auth_nonces (address, message, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(address) DO UPDATE SET message = excluded.message, expires_at = excluded.expires_at`
    ).run(address, message, expiresAt);
    res.json({ message, expiresAt });
  });

  router.post("/verify", async (req, res) => {
    const address = requireAddress(req.body?.address, "address");
    const signature = req.body?.signature;
    if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
      throw badRequest("signature must be a 65-byte hex string");
    }
    const row = db.prepare("SELECT message, expires_at FROM auth_nonces WHERE address = ?").get(address);
    if (!row) throw unauthorized("No pending sign-in for this address; request a nonce first");
    // one-time use: delete before verifying so a failed attempt also burns it
    db.prepare("DELETE FROM auth_nonces WHERE address = ?").run(address);
    if (row.expires_at < Date.now()) throw unauthorized("Sign-in message expired; request a new nonce");

    let recovered;
    try {
      recovered = ethers.verifyMessage(row.message, signature);
    } catch {
      throw unauthorized("Signature could not be verified");
    }
    if (recovered.toLowerCase() !== address) throw unauthorized("Signature does not match address");

    db.prepare("INSERT INTO users (address) VALUES (?) ON CONFLICT(address) DO NOTHING").run(address);
    chain.clearRoleCache?.(address);
    const roles = await resolveRoles(address);
    const token = jwt.sign({ roles }, config.jwtSecret, { subject: address, expiresIn: config.jwtTtl });
    res.json({ token, address, roles });
  });

  router.get("/me", requireAuth, async (req, res) => {
    const roles = await resolveRoles(req.user.address);
    const profile = db.prepare("SELECT * FROM users WHERE address = ?").get(req.user.address) || null;
    res.json({ address: req.user.address, roles, profile });
  });

  return { router, requireAuth, requireRole, resolveRoles };
}

module.exports = { createAuth };
