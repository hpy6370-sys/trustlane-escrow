const express = require("express");
const { intParam } = require("../validate");

const DAY = 86400;

/** Converts base units to a JS number in token units, for charts only (precision loss is fine there). */
function toUnits(raw, decimals) {
  const v = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  return Number(v / base) + Number(v % base) / Number(base);
}

module.exports = function statsRoutes({ db, chain }) {
  const r = express.Router();

  // GET /api/stats?days=30
  // ponytail: aggregates in JS over all escrow rows; fine to ~100k rows. Beyond
  // that, keep running totals in a stats table updated by the indexer.
  r.get("/", (req, res) => {
    const days = intParam(req.query.days, "days", { min: 1, max: 365, fallback: 30 });
    const escrows = db.prepare("SELECT id, token, total, released, fees, status, created_at, freelancer FROM escrows").all();

    const byStatus = {};
    const perToken = {};
    for (const e of escrows) {
      byStatus[e.status] = (byStatus[e.status] || 0) + 1;
      const t = (perToken[e.token] ??= { token: e.token, ...chain.tokenInfo(e.token), escrowed: 0n, locked: 0n, fees: 0n, count: 0 });
      t.count++;
      t.escrowed += BigInt(e.total);
      t.fees += BigInt(e.fees);
      if (["Created", "Active", "Disputed"].includes(e.status)) t.locked += BigInt(e.total) - BigInt(e.released);
    }

    // daily series for the last `days` days (UTC), zero-filled
    const today = Math.floor(Date.now() / 1000 / DAY);
    const series = [];
    const index = new Map();
    for (let d = today - days + 1; d <= today; d++) {
      const row = { date: new Date(d * DAY * 1000).toISOString().slice(0, 10), created: 0, disputes: 0, volume: {} };
      index.set(d, row);
      series.push(row);
    }
    for (const e of escrows) {
      const row = index.get(Math.floor(e.created_at / DAY));
      if (!row) continue;
      row.created++;
      const info = chain.tokenInfo(e.token);
      row.volume[info.symbol] = (row.volume[info.symbol] || 0) + toUnits(e.total, info.decimals);
    }
    for (const d of db.prepare("SELECT opened_at FROM disputes").all()) {
      const row = index.get(Math.floor(d.opened_at / DAY));
      if (row) row.disputes++;
    }

    const disputeCount = db.prepare("SELECT COUNT(*) n FROM disputes").get().n;
    const resolved = db.prepare("SELECT COUNT(*) n FROM disputes WHERE status = 'Resolved'").get().n;
    // dispute rate over jobs that actually started (a Created/Cancelled job can't be disputed)
    const started = escrows.filter((e) => !["Created", "Cancelled"].includes(e.status)).length;

    const topFreelancers = db
      .prepare(
        `SELECT freelancer AS address, COUNT(*) AS completed FROM escrows WHERE status = 'Completed'
         GROUP BY freelancer ORDER BY completed DESC LIMIT 5`
      )
      .all();

    res.json({
      totals: {
        escrows: escrows.length,
        disputes: disputeCount,
        disputesResolved: resolved,
        disputeRate: started ? disputeCount / started : 0,
        users: db.prepare("SELECT COUNT(DISTINCT address) n FROM user_roles").get().n,
        events: db.prepare("SELECT COUNT(*) n FROM events").get().n,
      },
      byStatus,
      tokens: Object.values(perToken).map((t) => ({
        token: t.token,
        symbol: t.symbol,
        decimals: t.decimals,
        count: t.count,
        escrowed: t.escrowed.toString(),
        locked: t.locked.toString(),
        fees: t.fees.toString(),
        escrowedUnits: toUnits(t.escrowed, t.decimals),
        lockedUnits: toUnits(t.locked, t.decimals),
      })),
      series,
      topFreelancers,
    });
  });

  return r;
};

module.exports.toUnits = toUnits;
