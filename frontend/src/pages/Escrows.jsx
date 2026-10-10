import { useState } from "react";
import { Link } from "react-router-dom";
import { Api } from "../lib/api";
import { amount, dateTime, relative } from "../lib/format";
import { useWallet } from "../context/WalletContext";
import { Address, Card, ErrorBox, Pager, Status, useLoad } from "../components/ui";

const STATUSES = ["", "Created", "Active", "Disputed", "Completed", "Resolved", "Refunded", "Cancelled"];

export default function Escrows() {
  const w = useWallet();
  const [status, setStatus] = useState("");
  const [mine, setMine] = useState(false);
  const [page, setPage] = useState(1);
  const list = useLoad(
    () => Api.escrows({ status, party: mine ? w.account : "", page, pageSize: 15 }),
    [status, mine, w.account, page, w.refreshKey]
  );

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Escrows</h1>
        {w.hasRole("client") && (
          <Link className="btn primary" to="/new">
            New escrow
          </Link>
        )}
      </div>
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
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s || "All"}
                </option>
              ))}
            </select>
          </label>
          {w.account && (
            <label className="check">
              <input
                type="checkbox"
                checked={mine}
                onChange={(e) => {
                  setMine(e.target.checked);
                  setPage(1);
                }}
              />
              Only mine
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
                    <th>Title</th>
                    <th>Status</th>
                    <th className="num">Amount</th>
                    <th>Client</th>
                    <th>Freelancer</th>
                    <th>Milestones</th>
                    <th>Deadline</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((e) => (
                    <tr key={e.id}>
                      <td>
                        <Link to={`/escrows/${e.id}`}>#{e.id}</Link>
                      </td>
                      <td>
                        <Link to={`/escrows/${e.id}`}>{e.title || <span className="muted">Untitled job</span>}</Link>
                      </td>
                      <td>
                        <Status value={e.status} />
                      </td>
                      <td className="num nowrap">{amount(e.total, e.token)}</td>
                      <td>
                        <Address value={e.client} />
                      </td>
                      <td>
                        <Address value={e.freelancer} />
                      </td>
                      <td className="num">{e.milestone_count}</td>
                      <td className="nowrap" title={dateTime(e.deadline)}>
                        {relative(e.deadline)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!list.data.items.length && <p className="muted">No escrows match.</p>}
            <Pager page={page} pageSize={15} total={list.data.total} onPage={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
