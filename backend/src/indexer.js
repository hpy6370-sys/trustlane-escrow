const { ethers } = require("ethers");
const { ROLE_BY_HASH, CORE } = require("./chain");

/**
 * Polls eth_getLogs for the four core contracts, decodes each log, appends it to
 * `events` and updates the read-model tables (escrows, milestones, disputes...).
 *
 * Each log is applied in its own DB transaction together with the cursor, and the
 * (tx_hash, log_index) UNIQUE key makes re-processing a no-op, so a crash at any
 * point resumes cleanly.
 *
 * ponytail: no reorg handling beyond the CONFIRMATIONS lag. On Sepolia set
 * CONFIRMATIONS=3+; a deep reorg would need a rewind-and-replay from a checkpoint.
 */
function createIndexer({ db, chain, config, log = console }) {
  const status = { running: false, lastBlock: null, head: null, lastError: null, lastRunAt: null, eventsIndexed: 0 };
  if (!chain.available) {
    status.lastError = `No deployment for chainId ${chain.chainId}; indexer disabled`;
    return { status, start() {}, stop() {}, runOnce: async () => 0 };
  }

  const ifaces = Object.fromEntries(CORE.map((n) => [n, new ethers.Interface(chain.abis[n])]));
  const byAddress = Object.fromEntries(CORE.map((n) => [chain.deployment.contracts[n].toLowerCase(), n]));
  const addresses = Object.keys(byAddress);
  const blockTimes = new Map();

  const getCursor = db.prepare("SELECT value FROM sync_state WHERE key = 'lastBlock'");
  const setCursor = db.prepare(
    "INSERT INTO sync_state (key, value) VALUES ('lastBlock', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  const insertEvent = db.prepare(`INSERT OR IGNORE INTO events
    (block_number, block_time, tx_hash, log_index, contract, name, args, escrow_id, actors)
    VALUES (@block_number, @block_time, @tx_hash, @log_index, @contract, @name, @args, @escrow_id, @actors)`);
  const setEventEscrow = db.prepare("UPDATE events SET escrow_id = ? WHERE id = ?");

  const lc = (a) => String(a).toLowerCase();

  /** ethers Result -> plain JSON object with string bigints */
  function argsToObject(fragment, args) {
    const out = {};
    fragment.inputs.forEach((input, i) => {
      const v = args[i];
      out[input.name] = typeof v === "bigint" ? v.toString() : typeof v === "string" && ethers.isAddress(v) ? lc(v) : v;
    });
    return out;
  }

  // ---------------------------------------------------------------- projections
  const q = {
    insertEscrow: db.prepare(`INSERT OR IGNORE INTO escrows
      (id, client, freelancer, token, total, milestone_count, deadline, terms_hash, status, created_at, updated_at, created_tx)
      VALUES (@id, @client, @freelancer, @token, @total, @milestone_count, @deadline, @terms_hash, 'Created', @t, @t, @tx)`),
    insertMilestone: db.prepare("INSERT OR IGNORE INTO milestones (escrow_id, idx, amount, updated_at) VALUES (?, ?, ?, ?)"),
    setStatus: db.prepare("UPDATE escrows SET status = ?, updated_at = ? WHERE id = ?"),
    getEscrow: db.prepare("SELECT * FROM escrows WHERE id = ?"),
    setReleased: db.prepare("UPDATE escrows SET released = ?, fees = ?, updated_at = ? WHERE id = ?"),
    msState: db.prepare("UPDATE milestones SET state = ?, updated_at = ? WHERE escrow_id = ? AND idx = ?"),
    msSubmit: db.prepare(
      "UPDATE milestones SET state = 'Submitted', deliverable_hash = ?, updated_at = ? WHERE escrow_id = ? AND idx = ?"
    ),
    // read-model only: on-chain milestone states are left as-is after a ruling, the UI shows them as settled
    msSettle: db.prepare(
      "UPDATE milestones SET state = 'Settled', updated_at = ? WHERE escrow_id = ? AND state IN ('Pending','Submitted')"
    ),
    msRefundPending: db.prepare(
      "UPDATE milestones SET state = 'Refunded', updated_at = ? WHERE escrow_id = ? AND state = 'Pending'"
    ),
    insertDispute: db.prepare(`INSERT OR IGNORE INTO disputes (id, escrow_id, opened_by, reason_hash, status, opened_at)
      VALUES (?, ?, ?, ?, 'Open', ?)`),
    disputeEscrow: db.prepare("SELECT escrow_id FROM disputes WHERE id = ?"),
    addEvidence: db.prepare("INSERT INTO evidence (dispute_id, submitter, hash, block_time, tx_hash) VALUES (?, ?, ?, ?, ?)"),
    bumpEvidence: db.prepare("UPDATE disputes SET evidence_count = evidence_count + 1 WHERE id = ?"),
    assignArbiter: db.prepare("UPDATE disputes SET arbiter = ?, status = 'UnderReview' WHERE id = ?"),
    resolveDispute: db.prepare(`UPDATE disputes SET status = 'Resolved', client_share_bps = ?, to_client = ?,
      to_freelancer = ?, ruling_hash = ?, resolved_at = ? WHERE id = ?`),
    grantRole: db.prepare("INSERT OR IGNORE INTO user_roles (address, role, granted_at) VALUES (?, ?, ?)"),
    revokeRole: db.prepare("DELETE FROM user_roles WHERE address = ? AND role = ?"),
  };

  const addAmounts = (escrowId, released, fee, t) => {
    const e = q.getEscrow.get(escrowId);
    if (!e) return;
    q.setReleased.run((BigInt(e.released) + BigInt(released)).toString(), (BigInt(e.fees) + BigInt(fee)).toString(), t, escrowId);
  };

  /** Synchronous so it runs inside the same DB transaction as the event insert.
   *  Returns the escrow id this event belongs to (for the events.escrow_id column). */
  function project(name, a, t, txHash) {
    switch (name) {
      case "EscrowCreated": {
        const id = Number(a.escrowId);
        q.insertEscrow.run({
          id,
          client: a.client,
          freelancer: a.freelancer,
          token: a.token,
          total: a.total,
          milestone_count: Number(a.milestoneCount),
          deadline: Number(a.deadline),
          terms_hash: a.termsHash,
          t,
          tx: txHash,
        });
        // milestone amounts are immutable, so reading current state is safe
        for (const [i, m] of a._milestones.entries()) q.insertMilestone.run(id, i, m.amount.toString(), t);
        return id;
      }
      case "EscrowAccepted":
        q.setStatus.run("Active", t, Number(a.escrowId));
        return Number(a.escrowId);
      case "EscrowCancelled":
        q.setStatus.run("Cancelled", t, Number(a.escrowId));
        addAmounts(Number(a.escrowId), a.refund, 0n, t);
        return Number(a.escrowId);
      case "MilestoneSubmitted":
        q.msSubmit.run(a.deliverableHash, t, Number(a.escrowId), Number(a.index));
        return Number(a.escrowId);
      case "MilestoneApproved":
        q.msState.run("Approved", t, Number(a.escrowId), Number(a.index));
        addAmounts(Number(a.escrowId), BigInt(a.paidToFreelancer) + BigInt(a.fee), a.fee, t);
        return Number(a.escrowId);
      case "EscrowCompleted":
        q.setStatus.run("Completed", t, Number(a.escrowId));
        return Number(a.escrowId);
      case "TimeoutRefunded":
        q.msRefundPending.run(t, Number(a.escrowId));
        q.setStatus.run("Refunded", t, Number(a.escrowId));
        addAmounts(Number(a.escrowId), a.refund, 0n, t);
        return Number(a.escrowId);
      case "EscrowDisputed":
        q.setStatus.run("Disputed", t, Number(a.escrowId));
        return Number(a.escrowId);
      case "DisputeSettled":
        q.setStatus.run("Resolved", t, Number(a.escrowId));
        q.msSettle.run(t, Number(a.escrowId));
        addAmounts(Number(a.escrowId), BigInt(a.toClient) + BigInt(a.toFreelancer) + BigInt(a.fee), a.fee, t);
        return Number(a.escrowId);
      case "CounterpartyRated":
        return Number(a.escrowId);
      case "DisputeOpened":
        q.insertDispute.run(Number(a.disputeId), Number(a.escrowId), a.openedBy, a.reasonHash, t);
        return Number(a.escrowId);
      case "EvidenceSubmitted":
        q.addEvidence.run(Number(a.disputeId), a.submitter, a.evidenceHash, t, txHash);
        q.bumpEvidence.run(Number(a.disputeId));
        return q.disputeEscrow.get(Number(a.disputeId))?.escrow_id ?? null;
      case "ArbiterAssigned":
        q.assignArbiter.run(a.arbiter, Number(a.disputeId));
        return q.disputeEscrow.get(Number(a.disputeId))?.escrow_id ?? null;
      case "DisputeResolved":
        q.resolveDispute.run(Number(a.clientShareBps), a.toClient, a.toFreelancer, a.rulingHash, t, Number(a.disputeId));
        return Number(a.escrowId);
      case "RoleGranted":
        if (ROLE_BY_HASH[a.role]) q.grantRole.run(a.account, ROLE_BY_HASH[a.role], t);
        chain.clearRoleCache(a.account);
        return null;
      case "RoleRevoked":
        if (ROLE_BY_HASH[a.role]) q.revokeRole.run(a.account, ROLE_BY_HASH[a.role]);
        chain.clearRoleCache(a.account);
        return null;
      default:
        return null;
    }
  }

  async function blockTime(n) {
    if (!blockTimes.has(n)) {
      const b = await chain.provider.getBlock(n);
      blockTimes.set(n, b.timestamp);
      if (blockTimes.size > 5000) blockTimes.delete(blockTimes.keys().next().value);
    }
    return blockTimes.get(n);
  }

  async function handleLog(raw) {
    const contract = byAddress[lc(raw.address)];
    let parsed;
    try {
      parsed = ifaces[contract].parseLog(raw);
    } catch {
      parsed = null;
    }
    if (!parsed) return false; // unknown topic (e.g. from an older ABI); skip
    const args = argsToObject(parsed.fragment, parsed.args);
    const t = await blockTime(raw.blockNumber);

    // async reads must happen before the synchronous DB transaction
    if (parsed.name === "EscrowCreated") {
      // amounts are immutable after creation, so a latest-state read is correct (and works on non-archive RPCs)
      args._milestones = await chain.contracts.EscrowManager.getMilestones(args.escrowId);
    }

    const actors = new Set(Object.values(args).filter((v) => typeof v === "string" && /^0x[0-9a-f]{40}$/.test(v)));
    // event row + read-model update commit together or not at all
    const apply = db.transaction(() => {
      const res = insertEvent.run({
        block_number: raw.blockNumber,
        block_time: t,
        tx_hash: raw.transactionHash,
        log_index: raw.index,
        contract,
        name: parsed.name,
        args: JSON.stringify(Object.fromEntries(Object.entries(args).filter(([k]) => !k.startsWith("_")))),
        escrow_id: null,
        actors: `,${[...actors].join(",")},`,
      });
      if (res.changes === 0) return false; // already processed
      const escrowId = project(parsed.name, args, t, raw.transactionHash);
      if (escrowId != null) setEventEscrow.run(escrowId, res.lastInsertRowid);
      return true;
    });
    return apply();
  }

  async function runOnce() {
    const head = (await chain.provider.getBlockNumber()) - config.indexer.confirmations;
    status.head = head;
    const cursor = getCursor.get();
    let from = cursor ? Number(cursor.value) + 1 : chain.deployment.startBlock ?? 0;
    let count = 0;
    while (from <= head) {
      const to = Math.min(from + config.indexer.logChunk - 1, head);
      const logs = await chain.provider.getLogs({ address: addresses, fromBlock: from, toBlock: to });
      logs.sort((x, y) => x.blockNumber - y.blockNumber || x.index - y.index);
      for (const l of logs) if (await handleLog(l)) count++;
      setCursor.run(String(to));
      status.lastBlock = to;
      from = to + 1;
    }
    status.eventsIndexed += count;
    status.lastRunAt = new Date().toISOString();
    status.lastError = null;
    return count;
  }

  let timer = null;
  let backoff = config.indexer.pollMs;
  async function loop() {
    try {
      const n = await runOnce();
      if (n) log.info?.(`[indexer] +${n} events, now at block ${status.lastBlock}`);
      backoff = config.indexer.pollMs;
    } catch (err) {
      status.lastError = err.shortMessage || err.message;
      log.warn?.(`[indexer] ${status.lastError}; retry in ${backoff} ms`);
      backoff = Math.min(backoff * 2, 60_000);
    }
    if (status.running) timer = setTimeout(loop, backoff);
  }

  return {
    status,
    runOnce,
    start() {
      if (status.running) return;
      status.running = true;
      const cur = getCursor.get();
      status.lastBlock = cur ? Number(cur.value) : null;
      loop();
    },
    stop() {
      status.running = false;
      clearTimeout(timer);
    },
  };
}

module.exports = { createIndexer };
