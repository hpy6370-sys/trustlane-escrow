import { formatUnits } from "ethers";
import { tokenInfo } from "../config";

export const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");

export function amount(raw, token, digits = 4) {
  const t = tokenInfo(token);
  const n = Number(formatUnits(BigInt(raw ?? 0), t.decimals));
  return `${n.toLocaleString(undefined, { maximumFractionDigits: digits })} ${t.symbol}`;
}

export const dateTime = (unix) =>
  unix ? new Date(Number(unix) * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";

export const pct = (x, digits = 1) => `${(x * 100).toFixed(digits)}%`;

export function relative(unix) {
  const diff = Number(unix) - Date.now() / 1000;
  const abs = Math.abs(diff);
  const units = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [u, s] of units) if (abs >= s) return fmt.format(Math.round(diff / s), u);
  return fmt.format(Math.round(diff), "second");
}
