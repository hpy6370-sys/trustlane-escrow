const express = require("express");
const { badRequest } = require("../errors");
const { requireAddress, text } = require("../validate");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = function userRoutes({ db, chain, auth }) {
  const r = express.Router();

  // PUT /api/users/me  (signed-in) -> update own off-chain profile
  r.put("/me", auth.requireAuth, (req, res) => {
    const b = req.body || {};
    const displayName = text(b.displayName, "displayName", 60);
    const email = text(b.email, "email", 120);
    if (email && !EMAIL_RE.test(email)) throw badRequest("email is not a valid address");
    const bio = text(b.bio, "bio", 1000);
    let skills = b.skills ?? null;
    if (skills !== null) {
      if (!Array.isArray(skills) || skills.length > 20 || skills.some((s) => typeof s !== "string" || s.length > 40)) {
        throw badRequest("skills must be an array of at most 20 strings (40 chars each)");
      }
      skills = JSON.stringify(skills.map((s) => s.trim()).filter(Boolean));
    }
    db.prepare(
      `INSERT INTO users (address, display_name, email, bio, skills) VALUES (@a, @n, @e, @b, @s)
       ON CONFLICT(address) DO UPDATE SET display_name = @n, email = @e, bio = @b, skills = @s, updated_at = datetime('now')`
    ).run({ a: req.user.address, n: displayName, e: email, b: bio, s: skills });
    res.json(db.prepare("SELECT * FROM users WHERE address = ?").get(req.user.address));
  });

  // GET /api/users/:address -> public profile + roles + job stats + on-chain reputation
  r.get("/:address", async (req, res) => {
    const address = requireAddress(req.params.address, "address");
    const profile = db.prepare("SELECT address, display_name, bio, skills, created_at FROM users WHERE address = ?").get(address);
    const roles = await auth.resolveRoles(address);
    const jobs = db
      .prepare(
        `SELECT
           SUM(client = @a) AS asClient,
           SUM(freelancer = @a) AS asFreelancer,
           SUM(status = 'Completed') AS completed,
           SUM(status IN ('Disputed','Resolved')) AS disputed
         FROM escrows WHERE client = @a OR freelancer = @a`
      )
      .get({ a: address });

    let reputation = null;
    if (chain.available) {
      try {
        const [rec, score] = await Promise.all([
          chain.contracts.Reputation.recordOf(address),
          chain.contracts.Reputation.scoreOf(address),
        ]);
        reputation = {
          score: Number(score),
          completedJobs: Number(rec.completedJobs),
          disputesWon: Number(rec.disputesWon),
          disputesLost: Number(rec.disputesLost),
          timeouts: Number(rec.timeouts),
          ratingCount: Number(rec.ratingCount),
          averageRating: Number(rec.ratingCount) ? Number(rec.ratingSum) / Number(rec.ratingCount) : null,
        };
      } catch (err) {
        reputation = { error: `unavailable: ${err.shortMessage || err.message}` };
      }
    }

    res.json({
      address,
      profile: profile ? { ...profile, skills: profile.skills ? JSON.parse(profile.skills) : [] } : null,
      roles,
      jobs: Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, v || 0])),
      reputation,
    });
  });

  return r;
};
