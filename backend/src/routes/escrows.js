const express = require("express");
const { notFound } = require("../errors");
const { optionalAddress, intParam, oneOf, paging } = require("../validate");

const STATUSES = ["Created", "Active", "Disputed", "Completed", "Cancelled", "Refunded", "Resolved"];

module.exports = function escrowRoutes({ db, chain }) {
  const r = express.Router();
  const decorate = (e) => ({ ...e, tokenInfo: chain.tokenInfo(e.token) });

  // GET /api/escrows?status=&client=&freelancer=&party=&page=&pageSize=
  r.get("/", (req, res) => {
    const status = oneOf(req.query.status, "status", STATUSES);
    const client = optionalAddress(req.query.client, "client");
    const freelancer = optionalAddress(req.query.freelancer, "freelancer");
    const party = optionalAddress(req.query.party, "party");
    const { page, pageSize, offset } = paging(req.query);

    const where = [];
    const params = {};
    if (status) (where.push("e.status = @status"), (params.status = status));
    if (client) (where.push("e.client = @client"), (params.client = client));
    if (freelancer) (where.push("e.freelancer = @freelancer"), (params.freelancer = freelancer));
    if (party) (where.push("(e.client = @party OR e.freelancer = @party)"), (params.party = party));
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const total = db.prepare(`SELECT COUNT(*) n FROM escrows e ${w}`).get(params).n;
    const items = db
      .prepare(
        `SELECT e.*, d.title, (SELECT id FROM disputes WHERE escrow_id = e.id ORDER BY id DESC LIMIT 1) AS dispute_id
         FROM escrows e LEFT JOIN documents d ON d.hash = e.terms_hash
         ${w} ORDER BY e.id DESC LIMIT @limit OFFSET @offset`
      )
      .all({ ...params, limit: pageSize, offset });
    res.json({ items: items.map(decorate), page, pageSize, total });
  });

  // GET /api/escrows/:id  -> escrow + milestones + dispute + evidence + event timeline
  r.get("/:id", (req, res) => {
    const id = intParam(req.params.id, "id", { min: 1 });
    const escrow = db
      .prepare(
        `SELECT e.*, d.title, d.body AS description FROM escrows e
         LEFT JOIN documents d ON d.hash = e.terms_hash WHERE e.id = ?`
      )
      .get(id);
    if (!escrow) throw notFound(`Escrow ${id} not found (it may not be indexed yet)`);
    const milestones = db
      .prepare(
        `SELECT m.*, doc.title AS deliverable_title FROM milestones m
         LEFT JOIN documents doc ON doc.hash = m.deliverable_hash WHERE m.escrow_id = ? ORDER BY m.idx`
      )
      .all(id);
    const dispute = db.prepare("SELECT * FROM disputes WHERE escrow_id = ? ORDER BY id DESC LIMIT 1").get(id) || null;
    const evidence = dispute
      ? db
          .prepare(
            `SELECT ev.*, doc.title, doc.body FROM evidence ev LEFT JOIN documents doc ON doc.hash = ev.hash
             WHERE ev.dispute_id = ? ORDER BY ev.block_time`
          )
          .all(dispute.id)
      : [];
    const events = db
      .prepare("SELECT *, ? AS escrow_token FROM events WHERE escrow_id = ? ORDER BY block_number, log_index")
      .all(escrow.token, id)
      .map((e) => ({ ...e, args: JSON.parse(e.args) }));
    res.json({ escrow: decorate(escrow), milestones, dispute, evidence, events });
  });

  return r;
};
