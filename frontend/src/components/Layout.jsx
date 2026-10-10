import { NavLink, Outlet } from "react-router-dom";
import { CHAIN, DEPLOYMENT } from "../config";
import { useWallet } from "../context/WalletContext";
import { short } from "../lib/format";

const NAV = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/escrows", label: "Escrows" },
  { to: "/new", label: "New escrow", role: "client" },
  { to: "/disputes", label: "Disputes" },
  { to: "/events", label: "Event log" },
  { to: "/account", label: "Account", needsWallet: true },
  { to: "/admin", label: "Admin", role: "admin" },
];

function WalletButton() {
  const w = useWallet();
  if (!w.hasWallet)
    return (
      <a className="btn" href="https://metamask.io/download/" target="_blank" rel="noreferrer">
        Install MetaMask
      </a>
    );
  if (!w.account)
    return (
      <button className="btn primary" onClick={w.connect}>
        Connect wallet
      </button>
    );
  if (!w.onRightChain)
    return (
      <button className="btn warn" onClick={w.switchChain}>
        Switch to {CHAIN?.chainName}
      </button>
    );
  return (
    <div className="wallet">
      <span className="addr-chip" title={w.account}>
        {short(w.account)}
      </span>
      {w.signedIn ? (
        <button className="btn ghost sm" onClick={w.signOut} title="End API session">
          Sign out
        </button>
      ) : (
        <button className="btn sm" onClick={w.signIn} title="Sign a message to log in to the API (no gas)">
          Sign in
        </button>
      )}
    </div>
  );
}

export default function Layout() {
  const w = useWallet();
  const visible = NAV.filter((n) => (!n.role || w.hasRole(n.role)) && (!n.needsWallet || w.account));
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            ✓
          </span>
          <span>TrustLane</span>
          <span className="net-chip">{CHAIN?.chainName || "Unknown chain"}</span>
        </div>
        <nav className="nav" aria-label="Main">
          {visible.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <WalletButton />
      </header>

      {w.account && w.onRightChain && (
        <div className="rolebar">
          Roles:{" "}
          {w.roles.length ? (
            w.roles.map((r) => (
              <span key={r} className={`role role-${r}`}>
                {r}
              </span>
            ))
          ) : (
            <span className="muted">none yet. Register as Client or Freelancer on the Account page.</span>
          )}
        </div>
      )}
      {!DEPLOYMENT && (
        <div className="alert">
          No contract deployment for this chain in <code>src/contracts/deployments.json</code>. Run the deploy script
          first (see README).
        </div>
      )}
      {w.error && (
        <div className="alert" role="alert">
          {w.error}{" "}
          <button className="link" onClick={() => w.setError(null)}>
            dismiss
          </button>
        </div>
      )}

      <main className="main">
        <Outlet />
      </main>
      <footer className="foot muted small">
        TrustLane · SC6113 group project · contracts on {CHAIN?.chainName}
      </footer>
    </div>
  );
}
