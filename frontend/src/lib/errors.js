import { Interface } from "ethers";
import { ABIS } from "../config";

const IFACES = Object.values(ABIS).map((abi) => new Interface(abi));

const FRIENDLY = {
  MissingRole: "Your wallet (or the counterparty) lacks the required role. Register on the Account page.",
  PlatformPaused: "The platform is paused by the admin. Exit actions (cancel, refund, withdraw) still work.",
  NotAuthorized: "This wallet is not allowed to perform that action.",
  WrongStatus: "The escrow is not in the right state for this action (refresh the page).",
  DeadlinePassed: "The escrow deadline has passed.",
  DeadlineNotReached: "The deadline has not passed yet.",
  MilestoneUnderReview: "A delivered milestone is awaiting review; approve it or open a dispute first.",
  NothingToWithdraw: "Nothing to withdraw.",
  AlreadyRated: "You already rated this job.",
  TokenNotAllowed: "This token is not allowed on the platform.",
  IncorrectPayment: "Payment amount does not match the milestone total.",
  ERC20InsufficientAllowance: "Token allowance too low. Approve the escrow contract first.",
  ERC20InsufficientBalance: "Token balance too low. Use the faucet on the Account page.",
  FaucetCooldown: "Faucet is limited to once per hour.",
  InvalidArbiter: "That address is not an eligible arbiter (needs ARBITER_ROLE and must not be a party).",
  AccessControlUnauthorizedAccount: "Admin role required.",
  FeeTooHigh: "Fee exceeds the 10% cap.",
};

function findData(err) {
  return err?.data ?? err?.info?.error?.data ?? err?.error?.data ?? err?.info?.error?.data?.data ?? null;
}

/** Turns an ethers / MetaMask error into one readable sentence. */
export function decodeError(err) {
  if (!err) return "Unknown error";
  if (err.code === "ACTION_REJECTED" || err.info?.error?.code === 4001) return "Request rejected in the wallet.";
  let name = err.revert?.name;
  let args = err.revert?.args;
  const data = findData(err);
  if (!name && typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
    for (const iface of IFACES) {
      try {
        const parsed = iface.parseError(data);
        if (parsed) {
          name = parsed.name;
          args = parsed.args;
          break;
        }
      } catch {
        /* try next ABI */
      }
    }
  }
  if (name) {
    const detail = args && args.length ? `(${[...args].map(String).join(", ")})` : "";
    return `${FRIENDLY[name] || "Transaction would revert."} [${name}${detail}]`;
  }
  if (err.code === "INSUFFICIENT_FUNDS") return "Not enough ETH to pay for gas and value.";
  return err.shortMessage || err.reason || err.message || String(err);
}
