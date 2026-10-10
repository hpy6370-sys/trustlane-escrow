import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Api } from "../lib/api";
import { anchorDocument } from "../lib/documents";
import { decodeError } from "../lib/errors";
import { amount, dateTime, relative } from "../lib/format";
import { useWallet } from "../context/WalletContext";
import { Address, Card, ErrorBox, Status, useLoad } from "../components/ui";
import EventTable from "../components/EventTable";

function parseTerms(body) {
  try {
    return JSON.parse(body);
  } catch {
    return body ? { description: body } : null;
  }
}

/** Text box + button that anchors a document hash on-chain. */
function DocAction({ label, kind, placeholder, onHash, cta }) {
  const [text, setText] = useState("");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="inline-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!text.trim()) return setErr("Please write something first");
        setErr(null);
        setBusy(true);
        try {
          const { hash } = await anchorDocument(kind, label, text);
          if (await onHash(hash)) setText("");
        } catch (e2) {
          setErr(decodeError(e2));
        } finally {
          setBusy(false);
        }
      }}
    >
      <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} aria-label={label} />
      <button className="btn sm" disabled={busy}>
        {cta}
      </button>
      {err && <p className="err small">{err}</p>}
    </form>
  );
}

export default function EscrowDetail() {
  const { id } = useParams();
  const w = useWallet();
  const [tick, setTick] = useState(0);
  const d = useLoad(() => Api.escrow(id), [id, w.refreshKey, tick]);

  // a fresh escrow may not be indexed yet -> poll briefly
  useEffect(() => {
    if (d.error?.status === 404) {
      const t = setTimeout(() => setTick((x) => x + 1), 3000);
      return () => clearTimeout(t);
    }
  }, [d.error]);

  const arbiters = useLoad(
    () => (w.hasRole("admin") && w.signedIn ? Api.arbiters() : Promise.resolve([])),
    [w.roles.join(), w.signedIn]
  );
  const [arb, setArb] = useState("");
  const [bps, setBps] = useState(5000);
  const [score, setScore] = useState(5);

  if (d.error?.status === 404) return <Card>Waiting for escrow #{id} to be indexed…</Card>;
  if (d.error) return <ErrorBox error={d.error} />;
  if (!d.data) return <p className="muted">Loading…</p>;

  const { escrow: e, milestones, dispute, evidence, events } = d.data;
  const me = w.account;
  const isClient = me === e.client;
  const isFreelancer = me === e.freelancer;
  const isParty = isClient || isFreelancer;
  const isArbiter = dispute && me === dispute.arbiter && w.hasRole("arbiter");
  const pastDeadline = Date.now() / 1000 > e.deadline;
  const terms = parseTerms(e.description);
  const msNames = terms?.milestones || [];
  const remaining = BigInt(e.total) - BigInt(e.released);
  const alreadyRated = events.some((ev) => ev.name === "CounterpartyRated" && ev.args.rater === me);

  const act = (label, contract, method, args = []) => w.runTx({ label, contract, method, args });
  const E = "EscrowManager";
  const D = "DisputeResolution";

  return (
    <div className="stack">
      <div className="page-head">
        <h1>
          #{e.id} {e.title || <span className="muted">Untitled job</span>}
        </h1>
        <Status value={e.status} />
      </div>

      <div className="grid-2">
        <Card title="Overview">
          <dl className="kv">
            <dt>Total</dt>
            <dd className="num">{amount(e.total, e.token)}</dd>
            <dt>Still locked</dt>
            <dd className="num">{amount(remaining, e.token)}</dd>
            <dt>Platform fees taken</dt>
            <dd className="num">{amount(e.fees, e.token)}</dd>
            <dt>Client</dt>
            <dd>
              <Address value={e.client} /> {isClient && <span className="tag">you</span>}
            </dd>
            <dt>Freelancer</dt>
            <dd>
              <Address value={e.freelancer} /> {isFreelancer && <span className="tag">you</span>}
            </dd>
            <dt>Deadline</dt>
            <dd>
              {dateTime(e.deadline)} <span className="muted">({relative(e.deadline)})</span>
            </dd>
            <dt>Terms hash</dt>
            <dd>
              <code className="small">{e.terms_hash}</code>
            </dd>
          </dl>
          {terms?.description && <p className="prewrap">{terms.description}</p>}
        </Card>

        <Card title="Actions">
          {!me && <p className="muted">Connect your wallet to act on this escrow.</p>}
          <div className="actions">
            {isFreelancer && e.status === "Created" && !pastDeadline && (
              <button className="btn primary" onClick={() => act("Accept job", E, "acceptEscrow", [e.id])}>
                Accept job
              </button>
            )}
            {isClient && e.status === "Created" && (
              <button className="btn" onClick={() => act("Cancel escrow (full refund)", E, "cancelEscrow", [e.id])}>
                Cancel &amp; refund
              </button>
            )}
            {me && ["Created", "Active"].includes(e.status) && pastDeadline && (
              <button className="btn" onClick={() => act("Claim timeout refund", E, "claimTimeoutRefund", [e.id])}>
                Trigger timeout refund
              </button>
            )}
            {isParty && ["Completed", "Resolved"].includes(e.status) && !alreadyRated && (
              <div className="row">
                <select value={score} onChange={(ev) => setScore(Number(ev.target.value))} aria-label="Rating">
                  {[5, 4, 3, 2, 1].map((s) => (
                    <option key={s} value={s}>
                      {s} ★
                    </option>
                  ))}
                </select>
                <button className="btn" onClick={() => act(`Rate counterparty ${score}★`, E, "rateCounterparty", [e.id, score])}>
                  Rate {isClient ? "freelancer" : "client"}
                </button>
              </div>
            )}
          </div>
          {isParty && e.status === "Active" && (
            <>
              <h3>Open a dispute</h3>
              <p className="muted small">Freezes the remaining funds until an arbiter rules.</p>
              <DocAction
                label="Dispute reason"
                kind="dispute"
                placeholder="What went wrong?"
                cta="Open dispute"
                onHash={(h) => act("Open dispute", D, "openDispute", [e.id, h])}
              />
            </>
          )}
          {me && !isParty && !isArbiter && !w.hasRole("admin") && (
            <p className="muted small">You are not a party to this escrow.</p>
          )}
        </Card>
      </div>

      <Card title="Milestones">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Deliverable</th>
                <th className="num">Amount</th>
                <th>State</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {milestones.map((m) => (
                <tr key={m.idx}>
                  <td className="num">{m.idx + 1}</td>
                  <td>
                    {msNames[m.idx]?.name || <span className="muted">Milestone {m.idx + 1}</span>}
                    {m.deliverable_hash && (
                      <div className="small muted" title={m.deliverable_hash}>
                        delivered: {m.deliverable_title || m.deliverable_hash.slice(0, 18) + "…"}
                      </div>
                    )}
                  </td>
                  <td className="num nowrap">{amount(m.amount, e.token)}</td>
                  <td>
                    <Status value={m.state} />
                  </td>
                  <td className="actions-cell">
                    {isFreelancer && e.status === "Active" && ["Pending", "Submitted"].includes(m.state) && (
                      <DocAction
                        label={`Milestone ${m.idx + 1} delivery`}
                        kind="deliverable"
                        placeholder="Link / notes for the client"
                        cta={m.state === "Submitted" ? "Re-submit" : "Submit work"}
                        onHash={(h) => act(`Submit milestone ${m.idx + 1}`, E, "submitMilestone", [e.id, m.idx, h])}
                      />
                    )}
                    {isClient && e.status === "Active" && m.state === "Submitted" && (
                      <button
                        className="btn primary sm"
                        onClick={() => act(`Approve milestone ${m.idx + 1} & release payment`, E, "approveMilestone", [e.id, m.idx])}
                      >
                        Approve &amp; pay
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {dispute && (
        <Card title={`Dispute #${dispute.id}`} actions={<Status value={dispute.status} />}>
          <dl className="kv">
            <dt>Opened by</dt>
            <dd>
              <Address value={dispute.opened_by} /> · {dateTime(dispute.opened_at)}
            </dd>
            <dt>Arbiter</dt>
            <dd>{dispute.arbiter ? <Address value={dispute.arbiter} /> : <span className="muted">not assigned</span>}</dd>
            {dispute.status === "Resolved" && (
              <>
                <dt>Ruling</dt>
                <dd>
                  {(dispute.client_share_bps / 100).toFixed(2)}% to client · {amount(dispute.to_client, e.token)} client /{" "}
                  {amount(dispute.to_freelancer, e.token)} freelancer
                </dd>
              </>
            )}
          </dl>

          <h3>Evidence ({evidence.length})</h3>
          {evidence.length ? (
            <ul className="evidence">
              {evidence.map((ev, i) => (
                <li key={i}>
                  <Address value={ev.submitter} /> <span className="muted small">{dateTime(ev.block_time)}</span>
                  <div className="prewrap">{ev.body || <code className="small">{ev.hash}</code>}</div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No evidence yet.</p>
          )}

          {isParty && dispute.status !== "Resolved" && (
            <DocAction
              label="Evidence"
              kind="evidence"
              placeholder="Describe or link your evidence"
              cta="Submit evidence"
              onHash={(h) => act("Submit evidence", D, "submitEvidence", [dispute.id, h])}
            />
          )}

          {w.hasRole("admin") && dispute.status !== "Resolved" && (
            <div className="row">
              <select value={arb} onChange={(ev) => setArb(ev.target.value)} aria-label="Arbiter">
                <option value="">Choose arbiter…</option>
                {(arbiters.data || [])
                  .filter((a) => a.address !== e.client && a.address !== e.freelancer)
                  .map((a) => (
                    <option key={a.address} value={a.address}>
                      {a.display_name || a.address} ({a.open_cases} open)
                    </option>
                  ))}
              </select>
              <button
                className="btn"
                disabled={!arb}
                onClick={() => act("Assign arbiter", D, "assignArbiter", [dispute.id, arb])}
              >
                Assign
              </button>
              {!w.signedIn && <span className="muted small">Sign in to load the arbiter list.</span>}
            </div>
          )}

          {isArbiter && dispute.status === "UnderReview" && (
            <div className="ruling">
              <h3>Rule</h3>
              <label>
                Client share: <b className="num">{(bps / 100).toFixed(0)}%</b> · freelancer{" "}
                <b className="num">{(100 - bps / 100).toFixed(0)}%</b> of {amount(remaining, e.token)}
                <input type="range" min={0} max={10000} step={500} value={bps} onChange={(ev) => setBps(Number(ev.target.value))} />
              </label>
              <DocAction
                label="Ruling"
                kind="ruling"
                placeholder="Reasoning for the ruling"
                cta="Resolve dispute"
                onHash={(h) => act(`Resolve: ${bps / 100}% to client`, D, "resolveDispute", [dispute.id, bps, h])}
              />
            </div>
          )}
        </Card>
      )}

      <Card title="On-chain timeline">
        <EventTable items={events} compact />
      </Card>
      <p>
        <Link to="/escrows">← All escrows</Link>
      </p>
    </div>
  );
}
