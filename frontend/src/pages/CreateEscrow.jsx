import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Interface, isAddress, parseUnits } from "ethers";
import { ABIS, ADDRESSES, ETH, ROLE_IDS, TOKENS } from "../config";
import { useWallet } from "../context/WalletContext";
import { anchorDocument } from "../lib/documents";
import { decodeError } from "../lib/errors";
import { Card, ErrorBox } from "../components/ui";

const escrowIface = new Interface(ABIS.EscrowManager);
const inDays = (d) => new Date(Date.now() + d * 86400_000).toISOString().slice(0, 10);

export default function CreateEscrow() {
  const w = useWallet();
  const nav = useNavigate();
  const [form, setForm] = useState({ title: "", description: "", freelancer: "", token: ETH, deadline: inDays(30) });
  const [milestones, setMilestones] = useState([{ name: "", amount: "" }]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const token = TOKENS.find((t) => t.address === form.token) || TOKENS[0];
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setMs = (i, k) => (e) => setMilestones((ms) => ms.map((m, j) => (j === i ? { ...m, [k]: e.target.value } : m)));

  function validate() {
    if (!form.title.trim()) return "Title is required";
    if (!isAddress(form.freelancer)) return "Freelancer must be a valid address";
    if (form.freelancer.toLowerCase() === w.account) return "You cannot hire yourself";
    if (!milestones.length || milestones.length > 20) return "Between 1 and 20 milestones";
    for (const [i, m] of milestones.entries()) {
      if (!m.name.trim()) return `Milestone ${i + 1} needs a description`;
      if (!(Number(m.amount) > 0)) return `Milestone ${i + 1} needs a positive amount`;
    }
    const dl = new Date(`${form.deadline}T23:59:59`).getTime();
    if (!(dl > Date.now())) return "Deadline must be in the future";
    if (dl > Date.now() + 365 * 86400_000) return "Deadline must be within 365 days";
    return null;
  }

  async function submit(e) {
    e.preventDefault();
    setError(null);
    const v = validate();
    if (v) return setError(v);
    setBusy(true);
    try {
      const amounts = milestones.map((m) => parseUnits(m.amount, token.decimals));
      const total = amounts.reduce((a, b) => a + b, 0n);
      const deadline = Math.floor(new Date(`${form.deadline}T23:59:59`).getTime() / 1000);

      // friendly pre-checks (the contract enforces these anyway)
      const registry = w.readContract("PlatformRegistry");
      if (!(await registry.hasRole(ROLE_IDS.FREELANCER, form.freelancer))) {
        throw new Error("That address is not registered as a Freelancer yet.");
      }

      const terms = JSON.stringify({
        description: form.description.trim(),
        milestones: milestones.map((m, i) => ({ index: i, name: m.name.trim(), amount: m.amount, token: token.symbol })),
      });
      const { hash } = await anchorDocument("terms", form.title, terms);

      if (token.address !== ETH) {
        const erc20 = w.readContract("MockUSDC");
        const allowance = await erc20.allowance(w.account, ADDRESSES.EscrowManager);
        if (allowance < total) {
          const ok = await w.runTx({
            label: `Approve ${token.symbol} spending`,
            contract: "MockUSDC",
            method: "approve",
            args: [ADDRESSES.EscrowManager, total],
          });
          if (!ok) return;
        }
      }

      const receipt = await w.runTx({
        label: "Create & fund escrow",
        contract: "EscrowManager",
        method: "createEscrow",
        args: [form.freelancer, token.address, amounts, deadline, hash],
        value: token.address === ETH ? total : undefined,
      });
      if (!receipt) return;
      const log = receipt.logs
        .map((l) => {
          try {
            return escrowIface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((p) => p?.name === "EscrowCreated");
      nav(log ? `/escrows/${log.args.escrowId}` : "/escrows");
    } catch (err) {
      setError(decodeError(err));
    } finally {
      setBusy(false);
    }
  }

  const total = milestones.reduce((a, m) => a + (Number(m.amount) || 0), 0);

  return (
    <div className="stack narrow">
      <h1>New escrow</h1>
      {!w.signedIn && (
        <div className="alert">
          Tip: <button className="link" onClick={w.signIn}>sign in</button> first so the job description is stored
          off-chain and shown to the freelancer. Otherwise only its hash goes on-chain.
        </div>
      )}
      <Card>
        <form onSubmit={submit} className="form">
          <label>
            Job title
            <input value={form.title} onChange={set("title")} maxLength={120} required />
          </label>
          <label>
            Description / scope
            <textarea value={form.description} onChange={set("description")} rows={4} maxLength={5000} />
          </label>
          <label>
            Freelancer wallet
            <input value={form.freelancer} onChange={set("freelancer")} placeholder="0x…" spellCheck={false} required />
          </label>
          <div className="row">
            <label className="grow">
              Payment token
              <select value={form.token} onChange={set("token")}>
                {TOKENS.map((t) => (
                  <option key={t.address} value={t.address}>
                    {t.symbol}
                  </option>
                ))}
              </select>
            </label>
            <label className="grow">
              Deadline
              <input type="date" value={form.deadline} onChange={set("deadline")} min={inDays(1)} max={inDays(365)} />
            </label>
          </div>

          <fieldset>
            <legend>Milestones</legend>
            {milestones.map((m, i) => (
              <div className="row ms-row" key={i}>
                <span className="muted num">{i + 1}.</span>
                <input
                  className="grow"
                  placeholder="Deliverable"
                  value={m.name}
                  onChange={setMs(i, "name")}
                  aria-label={`Milestone ${i + 1} deliverable`}
                />
                <input
                  className="amt"
                  placeholder={`Amount (${token.symbol})`}
                  inputMode="decimal"
                  value={m.amount}
                  onChange={setMs(i, "amount")}
                  aria-label={`Milestone ${i + 1} amount`}
                />
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => setMilestones((ms) => ms.filter((_, j) => j !== i))}
                  disabled={milestones.length === 1}
                  aria-label={`Remove milestone ${i + 1}`}
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => setMilestones((ms) => [...ms, { name: "", amount: "" }])}
              disabled={milestones.length >= 20}
            >
              + Add milestone
            </button>
          </fieldset>

          <p>
            Total to lock in escrow:{" "}
            <b className="num">
              {total.toLocaleString(undefined, { maximumFractionDigits: 6 })} {token.symbol}
            </b>
          </p>
          <ErrorBox error={error} />
          <button className="btn primary" disabled={busy || !w.onRightChain}>
            {busy ? "Working…" : "Create & fund escrow"}
          </button>
        </form>
      </Card>
    </div>
  );
}
