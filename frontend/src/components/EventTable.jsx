import { Link } from "react-router-dom";
import { txLink } from "../config";
import { amount, dateTime, short } from "../lib/format";

/** One-line human summary of an event's arguments. */
function summary(e) {
  const a = e.args;
  const tok = (raw) => (e.escrow_token ? amount(raw, e.escrow_token) : `${raw} base units`);
  switch (e.name) {
    case "EscrowCreated":
      return `${short(a.client)} funded ${amount(a.total, a.token)} for ${short(a.freelancer)} (${a.milestoneCount} milestones)`;
    case "MilestoneApproved":
      return `milestone ${Number(a.index) + 1} approved: ${tok(a.paidToFreelancer)} to freelancer, fee ${tok(a.fee)}`;
    case "TimeoutRefunded":
      return `deadline passed, ${tok(a.refund)} refunded to client`;
    case "EscrowCancelled":
      return `cancelled, ${tok(a.refund)} refunded to client`;
    case "DisputeSettled":
      return `${tok(a.toClient)} to client, ${tok(a.toFreelancer)} to freelancer, fee ${tok(a.fee)}`;
    case "EscrowAccepted":
      return `accepted by ${short(a.freelancer)}`;
    case "EscrowCompleted":
      return "all milestones approved";
    case "EvidenceSubmitted":
      return `evidence from ${short(a.submitter)} on dispute #${a.disputeId}`;
    case "MilestoneSubmitted":
      return `milestone ${Number(a.index) + 1} delivered`;
    case "DisputeOpened":
      return `dispute #${a.disputeId} opened by ${short(a.openedBy)}`;
    case "DisputeResolved":
      return `client share ${(Number(a.clientShareBps) / 100).toFixed(2)}%`;
    case "ArbiterAssigned":
      return `arbiter ${short(a.arbiter)} on dispute #${a.disputeId}`;
    case "Withdrawal":
      return `${short(a.account)} withdrew ${amount(a.amount, a.token)}`;
    case "FeesWithdrawn":
      return `${amount(a.amount, a.token)} to ${short(a.to)}`;
    case "RoleGranted":
    case "RoleRevoked":
      return short(a.account);
    case "PlatformFeeUpdated":
      return `${a.oldFeeBps} → ${a.newFeeBps} bps`;
    case "Rated":
    case "CounterpartyRated":
      return `${short(a.rater)} → ${short(a.ratee)}: ${a.score}★`;
    default:
      return Object.entries(a)
        .filter(([k]) => !k.endsWith("Hash"))
        .map(([k, v]) => `${k}=${typeof v === "string" && v.startsWith("0x") ? short(v) : v}`)
        .join(" ");
  }
}

export default function EventTable({ items, compact = false }) {
  if (!items.length) return <p className="muted">No events yet.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Event</th>
            {!compact && <th>Contract</th>}
            <th>Escrow</th>
            <th>Details</th>
            <th>Tx</th>
          </tr>
        </thead>
        <tbody>
          {items.map((e) => {
            const link = txLink(e.tx_hash);
            return (
              <tr key={e.id}>
                <td className="nowrap">{dateTime(e.block_time)}</td>
                <td>
                  <code>{e.name}</code>
                </td>
                {!compact && <td className="muted">{e.contract}</td>}
                <td>{e.escrow_id ? <Link to={`/escrows/${e.escrow_id}`}>#{e.escrow_id}</Link> : "—"}</td>
                <td className="details">{summary(e)}</td>
                <td className="nowrap">
                  {link ? (
                    <a href={link} target="_blank" rel="noreferrer">
                      {short(e.tx_hash)}
                    </a>
                  ) : (
                    <span title={e.tx_hash}>{short(e.tx_hash)}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
