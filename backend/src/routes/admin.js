const express = require("express");

module.exports = function adminRoutes({ db, chain, auth, indexer }) {
  const r = express.Router();
  r.use(auth.requireAuth, auth.requireRole("admin"));

  // GET /api/admin/overview -> indexer health, role counts, on-chain platform settings
  r.get("/overview", async (_req, res) => {
    const roles = db.prepare("SELECT role, COUNT(*) n FROM user_roles GROUP BY role").all();
    let platform = null;
    if (chain.available) {
      try {
        const { PlatformRegistry: reg, EscrowManager: esc } = chain.contracts;
        const tokens = Object.keys(chain.tokens);
        const [feeBps, paused, ...fees] = await Promise.all([
          reg.feeBps(),
          reg.paused(),
          ...tokens.map((t) => esc.accruedFees(t)),
        ]);
        platform = {
          feeBps: Number(feeBps),
          paused,
          accruedFees: tokens.map((t, i) => ({ token: t, ...chain.tokenInfo(t), amount: fees[i].toString() })),
        };
      } catch (err) {
        platform = { error: err.shortMessage || err.message };
      }
    }
    res.json({ indexer: indexer.status, roles, platform, deployment: chain.deployment });
  });

  // GET /api/admin/arbiters -> current arbiters (from indexed RoleGranted)
  r.get("/arbiters", (_req, res) => {
    res.json(
      db
        .prepare(
          `SELECT ur.address, ur.granted_at, u.display_name,
             (SELECT COUNT(*) FROM disputes d WHERE d.arbiter = ur.address AND d.status = 'UnderReview') AS open_cases
           FROM user_roles ur LEFT JOIN users u ON u.address = ur.address WHERE ur.role = 'arbiter'`
        )
        .all()
    );
  });

  return r;
};
