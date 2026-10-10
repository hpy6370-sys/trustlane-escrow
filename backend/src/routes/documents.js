const express = require("express");
const { ethers } = require("ethers");
const { badRequest, notFound } = require("../errors");
const { text } = require("../validate");

const KINDS = ["terms", "deliverable", "evidence", "dispute", "ruling"];

/**
 * Off-chain documents anchored on-chain by hash. The client uploads the text,
 * gets back keccak256(canonical JSON) and passes that hash into the contract
 * call (termsHash / deliverableHash / evidenceHash / reasonHash / rulingHash).
 * Anyone can later re-hash the stored body to prove it was not altered.
 */
function documentHash({ kind, title, body }) {
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify({ kind, title: title || "", body })));
}

function documentRoutes({ db, auth }) {
  const r = express.Router();

  r.post("/", auth.requireAuth, (req, res) => {
    const kind = req.body?.kind;
    if (!KINDS.includes(kind)) throw badRequest(`kind must be one of: ${KINDS.join(", ")}`);
    const title = text(req.body.title, "title", 120);
    const body = text(req.body.body, "body", 20_000);
    if (!body) throw badRequest("body is required");
    const hash = documentHash({ kind, title, body });
    const existing = db.prepare("SELECT * FROM documents WHERE hash = ?").get(hash);
    if (existing) return res.json(existing);
    db.prepare("INSERT INTO documents (hash, kind, author, title, body) VALUES (?, ?, ?, ?, ?)").run(
      hash,
      kind,
      req.user.address,
      title,
      body
    );
    res.status(201).json(db.prepare("SELECT * FROM documents WHERE hash = ?").get(hash));
  });

  r.get("/:hash", (req, res) => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(req.params.hash)) throw badRequest("hash must be 32-byte hex");
    const doc = db.prepare("SELECT * FROM documents WHERE hash = ?").get(req.params.hash.toLowerCase());
    if (!doc) throw notFound("Document not found");
    res.json({ ...doc, verified: documentHash(doc) === doc.hash });
  });

  return r;
}

module.exports = documentRoutes;
module.exports.documentHash = documentHash;
