const express = require("express");
const { optionalAddress, intParam, oneOf, paging, text } = require("../validate");

const CONTRACTS = ["PlatformRegistry", "EscrowManager", "DisputeResolution", "Reputation"];

module.exports = function eventRoutes({ db }) {
  const r = express.Router();

  // GET /api/events?contract=&name=&address=&escrowId=&page=&pageSize=
  // `address` matches any address argument of the event -> a user's on-chain history.
  r.get("/", (req, res) => {
    const contract = oneOf(req.query.contract, "contract", CONTRACTS);
    const name = text(req.query.name, "name", 64);
    const address = optionalAddress(req.query.address, "address");
    const escrowId = req.query.escrowId ? intParam(req.query.escrowId, "escrowId", { min: 1 }) : undefined;
    const { page, pageSize, offset } = paging(req.query);

    const where = [];
    const p = {};
    if (contract) (where.push("ev.contract = @contract"), (p.contract = contract));
    if (name) (where.push("ev.name = @name"), (p.name = name));
    if (address) (where.push("ev.actors LIKE @actor"), (p.actor = `%,${address},%`));
    if (escrowId) (where.push("ev.escrow_id = @escrowId"), (p.escrowId = escrowId));
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const total = db.prepare(`SELECT COUNT(*) n FROM events ev ${w}`).get(p).n;
    const items = db
      .prepare(
        `SELECT ev.*, es.token AS escrow_token FROM events ev LEFT JOIN escrows es ON es.id = ev.escrow_id
         ${w} ORDER BY ev.block_number DESC, ev.log_index DESC LIMIT @limit OFFSET @offset`
      )
      .all({ ...p, limit: pageSize, offset })
      .map((e) => ({ ...e, args: JSON.parse(e.args) }));
    res.json({ items, page, pageSize, total });
  });

  // GET /api/events/names -> distinct event names for the filter dropdown
  r.get("/names", (_req, res) => {
    res.json(db.prepare("SELECT contract, name, COUNT(*) count FROM events GROUP BY contract, name ORDER BY contract, name").all());
  });

  return r;
};
