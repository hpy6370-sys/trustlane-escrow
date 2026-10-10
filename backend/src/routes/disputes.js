const express = require("express");
const { oneOf, optionalAddress, paging } = require("../validate");

const STATUSES = ["Open", "UnderReview", "Resolved"];

module.exports = function disputeRoutes({ db, auth }) {
  const r = express.Router();

  const list = (where, params, { pageSize, offset }) =>
    db
      .prepare(
        `SELECT d.*, e.client, e.freelancer, e.token, e.total, e.released, doc.title AS reason_title
         FROM disputes d JOIN escrows e ON e.id = d.escrow_id
         LEFT JOIN documents doc ON doc.hash = d.reason_hash
         ${where} ORDER BY d.id DESC LIMIT @limit OFFSET @offset`
      )
      .all({ ...params, limit: pageSize, offset });

  // GET /api/disputes?status=&arbiter=
  r.get("/", (req, res) => {
    const status = oneOf(req.query.status, "status", STATUSES);
    const arbiter = optionalAddress(req.query.arbiter, "arbiter");
    const pg = paging(req.query);
    const where = [];
    const p = {};
    if (status) (where.push("d.status = @status"), (p.status = status));
    if (arbiter) (where.push("d.arbiter = @arbiter"), (p.arbiter = arbiter));
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = db.prepare(`SELECT COUNT(*) n FROM disputes d ${w}`).get(p).n;
    res.json({ items: list(w, p, pg), page: pg.page, pageSize: pg.pageSize, total });
  });

  // GET /api/disputes/assigned  (Arbiter only) -> my queue
  r.get("/assigned", auth.requireAuth, auth.requireRole("arbiter"), (req, res) => {
    const pg = paging(req.query);
    const items = list("WHERE d.arbiter = @me", { me: req.user.address }, pg);
    res.json({ items, page: pg.page, pageSize: pg.pageSize });
  });

  return r;
};
