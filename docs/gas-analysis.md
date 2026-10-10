# Gas Estimation and Optimisation Analysis (draft)

All numbers in this document were **measured**, not estimated, unless a line is
explicitly marked *(EVM constant)* or *(estimate)*. Sources:

| Source | How to reproduce | What it gives |
|---|---|---|
| `contracts/gas-report.txt` | `cd contracts && npx hardhat test` (hardhat-gas-reporter 2.3, solc 0.8.28, optimizer 200 runs, evm `cancun`) | min / max / avg per method across all 64 tests |
| `docs/gas-benchmark.json` | `cd contracts && REPORT_GAS=false npx hardhat run scripts/gas-benchmark.js` | one controlled scenario per row (fixed milestone counts, cold vs warm storage) |
| Frontend transaction dialog | create an escrow in the UI against a local node | estimate vs actual (`receipt.gasUsed`) |

Measurements were taken on the Hardhat in-process network on 2026-10-10. Gas
*units* are deterministic and identical on Sepolia/mainnet for the same EVM
version; only the price per unit differs.

## 1. Deployment cost

| Contract | Deploy gas | Runtime bytecode | % of 24,576-byte limit |
|---|---:|---:|---:|
| PlatformRegistry | 688,536 | 2,570 B | 10.5 % |
| Reputation | 718,102 | 3,069 B | 12.5 % |
| EscrowManager | 2,540,176 | 11,396 B | 46.4 % |
| DisputeResolution | 1,049,452 | 4,604 B | 18.7 % |
| MockUSDC (test token) | 552,576 | 2,068 B | 8.4 % |
| Wiring (setDisputeResolver + 2× setUpdater + setTokenAllowed) | 50,921 + 51,407 + 51,407 + 48,015 | | |
| **Total one-off** | **5,750,592** | | |

Cost formula: `cost (ETH) = gas × gasPrice`. At an assumed 1 gwei (typical
Sepolia) the full deployment is 5,750,592 × 1e-9 ≈ **0.00575 ETH**; at 20 gwei
≈ 0.115 ETH. (Gas prices here are assumptions for illustration; the
measured quantity is gas.)

## 2. Per-transaction cost (controlled benchmark)

From `docs/gas-benchmark.json`:

| Transaction type | Gas used | Notes |
|---|---:|---|
| registerAs (first time) | 50,237 | one new role slot |
| registerAs (already registered) | 26,473 | no-op path: no SSTORE, no event |
| createEscrow ETH, 1 milestone | 159,879 | first escrow ever also pays `escrowCount` 0→1 |
| createEscrow ETH, 3 milestones | 188,377 | |
| createEscrow ETH, 5 milestones | 233,975 | |
| createEscrow ETH, 10 milestones | 347,970 | |
| createEscrow ETH, 20 milestones (max) | 575,960 | ~1 % of a 60M block: the 20-milestone cap keeps it bounded |
| createEscrow mUSDC, 1 milestone | 203,367 | + `safeTransferFrom` and two `balanceOf` checks |
| createEscrow mUSDC, 3 milestones | 231,793 | |
| mUSDC approve (prerequisite) | 46,342 | separate ERC20 tx |
| acceptEscrow | 35,901 | one warm slot update |
| submitMilestone (first) | 39,292 | |
| submitMilestone (re-submit) | 36,311 | state unchanged, event only |
| approveMilestone (first payout to this freelancer) | 94,449 | creates freelancer balance + fee slots |
| approveMilestone (balances already non-zero) | 60,261 | |
| approveMilestone (last → Completed + Reputation call) | 113,324 | cross-contract call |
| cancelEscrow | 58,242 | |
| claimTimeoutRefund, 2 milestones, never accepted | 52,699 | |
| claimTimeoutRefund, 10 milestones, accepted | 110,898 | loops milestones + Reputation call |
| rateCounterparty | 44,414 | Escrow → Reputation |
| withdraw ETH | 33,414 | |
| openDispute | 134,372 | Dispute → Escrow, 3 new slots |
| submitEvidence | 39,334 | |
| assignArbiter | 50,834 | |
| resolveDispute | 113,782 | Dispute → Escrow → Reputation |
| setPlatformFee / pause / unpause | 30,464 / 29,985 / 29,965 | |
| withdrawFees ETH | 39,530 | |

**Scaling of `createEscrow`.** A least-squares fit over the 3, 5, 10 and 20
milestone runs gives **≈ 22,799 gas per extra milestone** with an intercept of
≈ 119,980. That slope matches one fresh 32-byte storage slot per milestone
(zero→non-zero SSTORE = 20,000 + 2,100 cold access *(EVM constant, EIP-2929/2200)*)
plus loop overhead, i.e. the `Milestone` struct is genuinely one slot.

**Typical job cost to users** (3 ETH milestones, happy path, measured rows
summed): create 188,377 + accept 35,901 + 3× submit (39,292 each) +
approvals (94,449 + 60,261 + 113,324) + withdraw 33,414 = **643,602 gas**,
≈ 0.00064 ETH at 1 gwei for the whole lifecycle split across two parties.

**Gas estimate accuracy in the UI.** The frontend calls `estimateGas` before
every transaction, shows the expected network fee, and sets
`gasLimit = estimate × 1.2`. In the end-to-end UI run, "Create & fund escrow"
(2 milestones, ETH) was estimated at 170,752 gas and used 165,578 (97 %).

## 3. Test-suite averages (hardhat-gas-reporter)

Selected rows from `contracts/gas-report.txt` (64 tests, mixed scenarios, so
averages blend cold/warm and ETH/ERC20 paths):

| Method | Min | Max | Avg | Calls |
|---|---:|---:|---:|---:|
| EscrowManager.createEscrow | 142,767 | 591,860 | 183,403 | 45 |
| EscrowManager.approveMilestone | 60,261 | 147,512 | 113,164 | 22 |
| EscrowManager.claimTimeoutRefund | 64,255 | 97,538 | 81,289 | 7 |
| EscrowManager.withdraw | 33,414 | 59,522 | 40,534 | 11 |
| DisputeResolution.openDispute | 134,372 | 134,403 | 134,385 | 7 |
| DisputeResolution.resolveDispute | 103,490 | 182,194 | 137,968 | 10 |
| PlatformRegistry.registerAs | 26,473 | 50,251 | 48,082 | 22 |

## 4. Optimisations applied

1. **Singleton escrow instead of a contract per job.** Every job is a struct in
   `EscrowManager`. A per-job contract would pay CREATE (32,000) plus
   200 gas per byte of deployed code *(EVM constants)* on every job, on top of
   the same storage writes. With the singleton, job creation is only storage
   writes (intercept ≈ 120k gas measured above).
2. **Storage packing.** `Escrow` uses 4 slots (client + deadline + status +
   counters + feeBps share slot 0; freelancer + 2 rating flags share slot 1;
   `total` and `released` are `uint128` sharing slot 3). `Milestone` is 1 slot,
   `Dispute` is 2 slots, Reputation's `Record` (6 counters) is exactly 1 slot,
   so each reputation update is a single SSTORE (`recordTimeout` 30,245 gas min
   in the report).
3. **Hashes in events, not storage.** Terms, deliverables, evidence and rulings
   are stored off-chain (backend `documents` table, content-addressed by
   keccak256) and only their hash is emitted. Storing a `bytes32` per
   submission would add a fresh slot each time (≈ 22,100 gas *(EVM constant)*);
   `submitMilestone` costs 39,292 instead.
4. **Pull payments.** Payouts are credited to `balances[user][token]` and claimed
   with `withdraw` (33,414 gas for ETH). Several payouts can be collected in
   one withdraw, a reverting receiver can't block other users, and only one
   function performs external value transfers.
5. **Inlined role constants.** `EscrowManager` uses `keccak256("CLIENT_ROLE")` as a
   compile-time constant instead of calling `registry.CLIENT_ROLE()`, saving an
   external call per check.
6. **Custom errors** instead of revert strings (smaller bytecode, cheaper reverts,
   and the frontend decodes them into readable messages).
7. **`unchecked` arithmetic** only where bounds are proven (counters,
   `released + amount ≤ total`, `fee ≤ amount`), and `calldata` arrays for
   milestone amounts.
8. **Bounded loops.** `MAX_MILESTONES = 20` caps the only loops
   (`createEscrow`, `claimTimeoutRefund`, `getMilestones`); worst case measured
   575,960 gas.
9. **No-op detection.** `registerAs` for an existing role skips the SSTORE and
   event (26,473 vs 50,237).

## 5. Further optimisations considered (not yet applied)

| Idea | Expected effect | Trade-off |
|---|---|---|
| Store the payment token as a `uint8` index in slot 0 instead of a full `address` slot | saves one fresh slot per job, ≈ 22,100 gas on `createEscrow` *(estimate from SSTORE cost)* | needs a token registry/index; slightly less readable |
| Drop `disputeOfEscrow` mapping (backend can index it) | ≈ 22,100 gas off `openDispute` *(estimate)* | on-chain lookup escrow→dispute is lost |
| One combined registry call (`validateCreate`) instead of 4 view calls (`paused`, 2× `hasRole`, `allowedTokens`, `feeBps`) | fewer CALL overheads (100 gas warm each, 2,600 for the first cold access *(EVM constants)*) | less modular registry API |
| Permit (EIP-2612) for the stablecoin | removes the separate 46,342-gas `approve` tx for ERC20 jobs | needs a permit-capable token |
| `viaIR` compilation | may reduce runtime gas | slower compile; must be re-measured |

Each of these must be re-measured with `scripts/gas-benchmark.js` before it is
claimed in the final report.

## 6. Security–gas trade-offs we kept on purpose

- `nonReentrant` on `createEscrow`, `withdraw`, `withdrawFees` (one extra warm
  SSTORE pair) even though the functions already follow checks-effects-interactions.
- `createEscrow` for ERC20 reads `balanceOf` before and after the transfer and
  rejects fee-on-transfer tokens; this is part of the 203,367 vs 159,879 gap
  between the mUSDC and ETH paths.
- Every write re-checks `registry.paused()` (cross-contract read) so a single
  admin action stops all modules.
