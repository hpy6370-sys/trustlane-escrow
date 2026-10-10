import { useState } from "react";
import { Api } from "../lib/api";
import { pct } from "../lib/format";
import { useWallet } from "../context/WalletContext";
import { Address, Card, ErrorBox, StatTile, useLoad } from "../components/ui";
import { ActivityChart, StatusChart, VolumeCharts } from "../components/Charts";
import EventTable from "../components/EventTable";

const RANGES = [7, 30, 90];

export default function Dashboard() {
  const w = useWallet();
  const [days, setDays] = useState(30);
  const stats = useLoad(() => Api.stats(days), [days, w.refreshKey]);
  const recent = useLoad(() => Api.events({ pageSize: 8 }), [w.refreshKey]);
  const mine = useLoad(
    () => (w.account ? Api.events({ address: w.account, pageSize: 8 }) : Promise.resolve(null)),
    [w.account, w.refreshKey]
  );

  const s = stats.data;
  return (
    <div className="stack">
      <div className="page-head">
        <h1>Dashboard</h1>
        <div className="seg" role="group" aria-label="Date range">
          {RANGES.map((d) => (
            <button key={d} className={d === days ? "on" : ""} onClick={() => setDays(d)} aria-pressed={d === days}>
              {d}d
            </button>
          ))}
        </div>
      </div>
      <ErrorBox error={stats.error && `Could not load stats: ${stats.error.message}`} />

      {s && (
        <>
          <div className="tiles">
            <StatTile label="Escrows" value={s.totals.escrows} sub={`${s.totals.events} on-chain events indexed`} />
            {s.tokens.map((t) => (
              <StatTile
                key={t.token}
                label={`Locked · ${t.symbol}`}
                value={t.lockedUnits.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                sub={`${t.escrowedUnits.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${t.symbol} escrowed all-time`}
              />
            ))}
            <StatTile
              label="Dispute rate"
              value={pct(s.totals.disputeRate)}
              sub={`${s.totals.disputes} disputes · ${s.totals.disputesResolved} resolved`}
            />
            <StatTile label="Registered users" value={s.totals.users} />
          </div>

          <div className="grid-2">
            <Card title={`Activity · last ${days} days`}>
              <ActivityChart series={s.series} />
            </Card>
            <Card title="Escrows by status">
              <StatusChart byStatus={s.byStatus} />
            </Card>
          </div>

          <Card title={`Escrowed volume · last ${days} days`}>
            <VolumeCharts series={s.series} symbols={s.tokens.map((t) => t.symbol)} />
          </Card>
        </>
      )}

      <div className="grid-2">
        {w.account && (
          <Card title="My transaction history">
            {mine.data && <EventTable items={mine.data.items} compact />}
          </Card>
        )}
        <Card title="Latest platform events">{recent.data && <EventTable items={recent.data.items} compact />}</Card>
        {s?.topFreelancers?.length > 0 && (
          <Card title="Top freelancers (completed jobs)">
            <ol className="rank">
              {s.topFreelancers.map((f) => (
                <li key={f.address}>
                  <Address value={f.address} /> <span className="num">{f.completed}</span>
                </li>
              ))}
            </ol>
          </Card>
        )}
      </div>
    </div>
  );
}
