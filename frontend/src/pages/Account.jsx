import { useEffect, useState } from "react";
import { formatUnits } from "ethers";
import { ROLE_IDS, TOKENS } from "../config";
import { Api } from "../lib/api";
import { decodeError } from "../lib/errors";
import { useWallet } from "../context/WalletContext";
import { Card, ErrorBox, StatTile, useLoad } from "../components/ui";

export default function Account() {
  const w = useWallet();
  const [balances, setBalances] = useState([]);
  const [profile, setProfile] = useState({ displayName: "", email: "", bio: "", skills: "" });
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);

  const user = useLoad(() => (w.account ? Api.user(w.account) : Promise.resolve(null)), [w.account, w.refreshKey]);

  // wallet + escrow balances, read live from chain
  useEffect(() => {
    if (!w.account || !w.onRightChain) return;
    const escrow = w.readContract("EscrowManager");
    Promise.all(
      TOKENS.map(async (t) => ({
        ...t,
        wallet: t.symbol === "ETH" ? await w.getEthBalance() : await w.getTokenBalance(t.address, t.decimals),
        claimable: await escrow.balances(w.account, t.address),
      }))
    )
      .then(setBalances)
      .catch((e) => setErr(decodeError(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w.account, w.onRightChain, w.refreshKey]);

  useEffect(() => {
    if (w.signedIn && w.account) {
      // /auth/me returns the private fields (email) that the public profile hides
      Api.me()
        .then(({ profile: p }) =>
          setProfile({
            displayName: p?.display_name || "",
            email: p?.email || "",
            bio: p?.bio || "",
            skills: (p?.skills ? JSON.parse(p.skills) : []).join(", "),
          })
        )
        .catch(() => {});
    }
  }, [w.signedIn, w.account]);

  if (!w.account) return <Card>Connect your wallet to see your account.</Card>;

  const register = (role, label) =>
    w.runTx({ label: `Register as ${label}`, contract: "PlatformRegistry", method: "registerAs", args: [ROLE_IDS[role]] });

  async function saveProfile(e) {
    e.preventDefault();
    setErr(null);
    setMsg(null);
    try {
      await Api.updateProfile({
        displayName: profile.displayName,
        email: profile.email || null,
        bio: profile.bio,
        skills: profile.skills
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      });
      setMsg("Profile saved.");
      user.reload();
    } catch (e2) {
      setErr(e2.message);
    }
  }

  const rep = user.data?.reputation;
  return (
    <div className="stack">
      <h1>My account</h1>
      <ErrorBox error={err} />

      <div className="grid-2">
        <Card title="Roles">
          <p>
            Current:{" "}
            {w.roles.length ? w.roles.map((r) => <span key={r} className={`role role-${r}`}>{r}</span>) : <span className="muted">none</span>}
          </p>
          <div className="actions">
            {!w.hasRole("client") && (
              <button className="btn" onClick={() => register("CLIENT", "Client")}>
                Register as Client
              </button>
            )}
            {!w.hasRole("freelancer") && (
              <button className="btn" onClick={() => register("FREELANCER", "Freelancer")}>
                Register as Freelancer
              </button>
            )}
          </div>
          <p className="muted small">Arbiter and Admin roles are granted by an Admin.</p>
        </Card>

        <Card title="Reputation (on-chain)">
          {rep && !rep.error ? (
            <div className="tiles compact">
              <StatTile label="Score" value={rep.score} sub="0–1000, base 500" />
              <StatTile label="Completed jobs" value={rep.completedJobs} />
              <StatTile
                label="Avg rating"
                value={rep.averageRating ? rep.averageRating.toFixed(2) : "—"}
                sub={`${rep.ratingCount} ratings`}
              />
              <StatTile label="Disputes won / lost" value={`${rep.disputesWon} / ${rep.disputesLost}`} sub={`${rep.timeouts} timeouts`} />
            </div>
          ) : (
            <p className="muted">{rep?.error || "Loading…"}</p>
          )}
        </Card>
      </div>

      <Card title="Balances">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Token</th>
                <th className="num">In wallet</th>
                <th className="num">Claimable from escrow</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {balances.map((b) => (
                <tr key={b.address}>
                  <td>{b.symbol}</td>
                  <td className="num">{Number(b.wallet).toLocaleString(undefined, { maximumFractionDigits: 6 })}</td>
                  <td className="num">{Number(formatUnits(b.claimable, b.decimals)).toLocaleString(undefined, { maximumFractionDigits: 6 })}</td>
                  <td className="actions-cell">
                    <button
                      className="btn sm primary"
                      disabled={b.claimable === 0n}
                      onClick={() => w.runTx({ label: `Withdraw ${b.symbol}`, contract: "EscrowManager", method: "withdraw", args: [b.address] })}
                    >
                      Withdraw
                    </button>
                    {b.symbol === "mUSDC" && (
                      <button
                        className="btn sm ghost"
                        onClick={() => w.runTx({ label: "Claim 10,000 test mUSDC", contract: "MockUSDC", method: "faucet" })}
                      >
                        Faucet
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">
          Payouts and refunds are credited here first (pull payments) and you withdraw them in one transaction.
        </p>
      </Card>

      <Card title="Public profile (off-chain)">
        {!w.signedIn ? (
          <p>
            <button className="btn" onClick={w.signIn}>
              Sign in
            </button>{" "}
            <span className="muted">to edit your profile (signature only, no gas).</span>
          </p>
        ) : (
          <form className="form" onSubmit={saveProfile}>
            <label>
              Display name
              <input value={profile.displayName} maxLength={60} onChange={(e) => setProfile({ ...profile, displayName: e.target.value })} />
            </label>
            <label>
              Email (private)
              <input type="email" value={profile.email} onChange={(e) => setProfile({ ...profile, email: e.target.value })} />
            </label>
            <label>
              Bio
              <textarea rows={3} value={profile.bio} maxLength={1000} onChange={(e) => setProfile({ ...profile, bio: e.target.value })} />
            </label>
            <label>
              Skills (comma separated)
              <input value={profile.skills} onChange={(e) => setProfile({ ...profile, skills: e.target.value })} />
            </label>
            {msg && <p className="ok">{msg}</p>}
            <button className="btn primary">Save profile</button>
          </form>
        )}
      </Card>
    </div>
  );
}
