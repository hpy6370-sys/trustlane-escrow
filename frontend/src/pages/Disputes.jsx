import { useState } from "react";
import { Link } from "react-router-dom";
import { Api } from "../lib/api";
import { amount, dateTime } from "../lib/format";
import { useWallet } from "../context/WalletContext";
import { Address, Card, ErrorBox, Pager, Status, useLoad } from "../components/ui";

export default function Disputes() {
  const w = useWallet();
  const [status, setStatus] = useState("");
  const [mineOnly, setMineOnly] = useState(false);
  const [page, setPage] = useState(1);
  const list = useLoad(
    () => Api.disputes({ status, arbiter: mineOnly ? w.account : "", page, pageSize: 15 }),
    [status, mineOnly, page, w.account, w.refreshKey]
  );

  return (
    <div className="stack">
      <h1>Disputes</h1>
      {w.hasRole("arbiter") && <p className="muted">You are an arbiter. Open a case assigned to you to rule on it.</p>}
      {w.hasRole("admin") && <p className="muted">As admin, open an Open dispute to assign an arbiter.</p>}
      <Card>
        <div className="filters">
          <label>
            Status
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All</option>
              <option value="Open">Open (needs arbiter)</option>
              <option value="UnderReview">Under review</option>
              <option value="Resolved">Resolved</option>
            </select>
          </label>
          {w.hasRole("arbiter") && (
            <label className="check">
              <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} /> Assigned to me
            </label>
          )}
        </div>
        <ErrorBox error={list.error} />
        {list.data && (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Escrow</th>
                    <th>Status</th>
                    <th>Opened by</th>
                    <th>Arbiter</th>
                    <th className="num">At stake</th>
                    <th className="num">Evidence</th>
                    <th>Opened</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((d) => (
                    <tr key={d.id}>
                      <td>{d.id}</td>
                      <td>
                        <Link to={`/escrows/${d.escrow_id}`}>Escrow #{d.escrow_id}</Link>
                      </td>
                      <td>
                        <Status value={d.status} />
                      </td>
                      <td>
                        <Address value={d.opened_by} />
                      </td>
                      <td>{d.arbiter ? <Address value={d.arbiter} /> : <span className="muted">—</span>}</td>
                      <td className="num nowrap">
                        {d.status === "Resolved"
                          ? amount(BigInt(d.to_client) + BigInt(d.to_freelancer), d.token)
                          : amount(BigInt(d.total) - BigInt(d.released), d.token)}
                      </td>
                      <td className="num">{d.evidence_count}</td>
                      <td className="nowrap">{dateTime(d.opened_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!list.data.items.length && <p className="muted">No disputes.</p>}
            <Pager page={page} pageSize={15} total={list.data.total} onPage={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
