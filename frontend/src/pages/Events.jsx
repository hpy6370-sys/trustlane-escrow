import { useState } from "react";
import { isAddress } from "ethers";
import { Api } from "../lib/api";
import { useWallet } from "../context/WalletContext";
import { Card, ErrorBox, Pager, useLoad } from "../components/ui";
import EventTable from "../components/EventTable";

const CONTRACTS = ["", "EscrowManager", "DisputeResolution", "PlatformRegistry", "Reputation"];

export default function Events() {
  const w = useWallet();
  const [f, setF] = useState({ contract: "", name: "", address: "" });
  const [page, setPage] = useState(1);
  const names = useLoad(() => Api.eventNames(), []);
  const addrOk = !f.address || isAddress(f.address);
  const ev = useLoad(
    () => Api.events({ ...f, address: addrOk ? f.address : "", page, pageSize: 25 }),
    [f.contract, f.name, addrOk ? f.address : "", page, w.refreshKey]
  );
  const set = (k) => (e) => {
    setPage(1);
    setF((x) => ({ ...x, [k]: e.target.value, ...(k === "contract" ? { name: "" } : {}) }));
  };
  const nameOptions = (names.data || []).filter((n) => !f.contract || n.contract === f.contract);

  return (
    <div className="stack">
      <h1>Event log</h1>
      <Card>
        <div className="filters">
          <label>
            Contract
            <select value={f.contract} onChange={set("contract")}>
              {CONTRACTS.map((c) => (
                <option key={c} value={c}>
                  {c || "All contracts"}
                </option>
              ))}
            </select>
          </label>
          <label>
            Event
            <select value={f.name} onChange={set("name")}>
              <option value="">All events</option>
              {nameOptions.map((n) => (
                <option key={n.contract + n.name} value={n.name}>
                  {n.name} ({n.count})
                </option>
              ))}
            </select>
          </label>
          <label className="grow">
            Address involved
            <input
              value={f.address}
              onChange={set("address")}
              placeholder="0x…"
              aria-invalid={!addrOk}
              spellCheck={false}
            />
          </label>
          {w.account && (
            <button className="btn ghost sm" onClick={() => setF((x) => ({ ...x, address: w.account }))}>
              Mine
            </button>
          )}
        </div>
        {!addrOk && <p className="err small">Not a valid address.</p>}
        <ErrorBox error={ev.error} />
        {ev.data && (
          <>
            <EventTable items={ev.data.items} />
            <Pager page={page} pageSize={25} total={ev.data.total} onPage={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
