import { useEffect, useState } from "react";
import { addressLink } from "../config";
import { short } from "../lib/format";

export function Address({ value, label }) {
  if (!value) return <span className="muted">—</span>;
  const link = addressLink(value);
  const text = label || short(value);
  return (
    <span className="addr" title={value}>
      {link ? (
        <a href={link} target="_blank" rel="noreferrer">
          {text}
        </a>
      ) : (
        text
      )}
    </span>
  );
}

const STATUS_TONE = {
  Created: "neutral",
  Active: "info",
  Disputed: "serious",
  Completed: "good",
  Cancelled: "neutral",
  Refunded: "warning",
  Resolved: "good",
  Open: "serious",
  UnderReview: "warning",
  Pending: "neutral",
  Submitted: "info",
  Approved: "good",
  Settled: "neutral",
};
const STATUS_ICON = { good: "✓", serious: "!", warning: "◷", info: "●", neutral: "○" };

/** Status pill: colour + icon + text, never colour alone. */
export function Status({ value }) {
  const tone = STATUS_TONE[value] || "neutral";
  return (
    <span className={`pill pill-${tone}`}>
      <span aria-hidden="true">{STATUS_ICON[tone]}</span> {value === "UnderReview" ? "Under review" : value}
    </span>
  );
}

export function StatTile({ label, value, sub }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {sub && <div className="tile-sub">{sub}</div>}
    </div>
  );
}

export function Card({ title, actions, children, className = "" }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function ErrorBox({ error }) {
  if (!error) return null;
  return (
    <div className="alert" role="alert">
      {typeof error === "string" ? error : error.message}
    </div>
  );
}

export function Pager({ page, pageSize, total, onPage }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="pager">
      <button className="btn ghost sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        ‹ Prev
      </button>
      <span className="muted small">
        Page {page} / {pages} · {total} rows
      </span>
      <button className="btn ghost sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next ›
      </button>
    </div>
  );
}

/** Tiny data hook: runs `fn` when deps change, exposes {data, error, loading, reload}. */
export function useLoad(fn, deps) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    fn()
      .then((data) => alive && setState({ data, error: null, loading: false }))
      .catch((error) => alive && setState({ data: null, error, loading: false }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { ...state, reload: () => setN((x) => x + 1) };
}
