// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PlatformRegistry} from "./PlatformRegistry.sol";
import {Reputation} from "./Reputation.sol";

/// @title EscrowManager
/// @notice Milestone-based escrow for client/freelancer jobs, paid in ETH or an
///         allow-listed ERC20 (e.g. a USD stablecoin).
///
/// Design notes
///  - Singleton: every job is a struct in one contract instead of a contract per
///    job. Creating a job is a few SSTOREs rather than a contract deployment.
///  - Pull payments: payouts are credited to `balances` and claimed with
///    `withdraw`, so a reverting receiver can never block someone else's flow
///    and the only external value transfer happens in one guarded function.
///  - Deliverable / terms documents live off-chain; only their keccak256 hash is
///    emitted, never stored (events are ~8x cheaper than storage).
///  - Exit paths (cancel, timeout refund, withdraw) stay open while paused;
///    pause only blocks new money and new state transitions.
contract EscrowManager is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Created, // funded, waiting for freelancer to accept
        Active, // freelancer accepted, work in progress
        Disputed, // frozen, handed to DisputeResolution
        Completed, // all milestones approved
        Cancelled, // client cancelled before acceptance
        Refunded, // deadline passed, unreleased funds returned to client
        Resolved // dispute ruled by an arbiter
    }

    enum MilestoneState {
        Pending,
        Submitted,
        Approved,
        Refunded
    }

    /// 4 storage slots per job (+1 slot per milestone).
    struct Escrow {
        // slot 0: 20 + 5 + 1 + 1 + 1 + 2 = 30 bytes
        address client;
        uint40 deadline;
        Status status;
        uint8 milestoneCount;
        uint8 approvedCount;
        uint16 feeBps; // fee snapshot at creation; later fee changes don't affect live jobs
        // slot 1: 20 + 1 + 1 = 22 bytes
        address freelancer;
        bool clientRated;
        bool freelancerRated;
        // slot 2
        address token; // address(0) = native ETH
        // slot 3
        uint128 total;
        uint128 released; // amount no longer locked (paid out, refunded or settled)
    }

    struct Milestone {
        uint128 amount;
        MilestoneState state;
    }

    uint256 public constant MAX_MILESTONES = 20;
    uint256 public constant MAX_DURATION = 365 days;
    uint256 private constant BPS = 10_000;
    // Same values as PlatformRegistry; inlined so we don't pay an external call to read a constant.
    bytes32 private constant CLIENT_ROLE = keccak256("CLIENT_ROLE");
    bytes32 private constant FREELANCER_ROLE = keccak256("FREELANCER_ROLE");

    PlatformRegistry public immutable registry;
    Reputation public immutable reputation;
    address public disputeResolver;

    uint256 public escrowCount;
    mapping(uint256 => Escrow) private _escrows;
    mapping(uint256 => mapping(uint256 => Milestone)) private _milestones;

    /// account => token => claimable amount
    mapping(address => mapping(address => uint256)) public balances;
    /// token => platform fees not yet withdrawn
    mapping(address => uint256) public accruedFees;

    event EscrowCreated(
        uint256 indexed escrowId,
        address indexed client,
        address indexed freelancer,
        address token,
        uint256 total,
        uint8 milestoneCount,
        uint40 deadline,
        bytes32 termsHash
    );
    event EscrowAccepted(uint256 indexed escrowId, address indexed freelancer);
    event EscrowCancelled(uint256 indexed escrowId, uint256 refund);
    event MilestoneSubmitted(uint256 indexed escrowId, uint256 indexed index, bytes32 deliverableHash);
    event MilestoneApproved(uint256 indexed escrowId, uint256 indexed index, uint256 paidToFreelancer, uint256 fee);
    event EscrowCompleted(uint256 indexed escrowId);
    event TimeoutRefunded(uint256 indexed escrowId, uint256 refund);
    event EscrowDisputed(uint256 indexed escrowId);
    event DisputeSettled(uint256 indexed escrowId, uint256 toClient, uint256 toFreelancer, uint256 fee);
    event CounterpartyRated(uint256 indexed escrowId, address indexed rater, address indexed ratee, uint8 score);
    event Withdrawal(address indexed account, address indexed token, uint256 amount);
    event FeesWithdrawn(address indexed token, address indexed to, uint256 amount);
    event DisputeResolverSet(address indexed resolver);

    error NotAuthorized(address caller);
    error MissingRole(address account, bytes32 role);
    error PlatformPaused();
    error InvalidParams(string reason);
    error TokenNotAllowed(address token);
    error IncorrectPayment(uint256 expected, uint256 received);
    error WrongStatus(Status current);
    error WrongMilestoneState(uint256 index, MilestoneState current);
    error DeadlineNotReached(uint40 deadline);
    error DeadlinePassed(uint40 deadline);
    error MilestoneUnderReview(uint256 index);
    error NothingToWithdraw();
    error AlreadyRated();
    error TransferFailed();
    error ResolverAlreadySet();

    constructor(PlatformRegistry registry_, Reputation reputation_) {
        registry = registry_;
        reputation = reputation_;
    }

    // ------------------------------------------------------------ modifiers

    modifier whenNotPaused() {
        if (registry.paused()) revert PlatformPaused();
        _;
    }

    modifier onlyAdmin() {
        if (!registry.isAdmin(msg.sender)) revert NotAuthorized(msg.sender);
        _;
    }

    modifier onlyResolver() {
        if (msg.sender != disputeResolver) revert NotAuthorized(msg.sender);
        _;
    }

    function _requireRole(bytes32 role, address account) private view {
        if (!registry.hasRole(role, account)) revert MissingRole(account, role);
    }

    function _load(uint256 escrowId, Status expected) private view returns (Escrow storage e) {
        e = _escrows[escrowId];
        if (e.status != expected) revert WrongStatus(e.status);
    }

    // ------------------------------------------------------------ client flow

    /// @notice Tx type: Create & fund an escrow. ETH jobs send `msg.value == sum(amounts)`;
    ///         ERC20 jobs need a prior `approve` and send no ETH.
    function createEscrow(
        address freelancer,
        address token,
        uint128[] calldata amounts,
        uint40 deadline,
        bytes32 termsHash
    ) external payable nonReentrant whenNotPaused returns (uint256 escrowId) {
        _requireRole(CLIENT_ROLE, msg.sender);
        if (freelancer == address(0) || freelancer == msg.sender) revert InvalidParams("freelancer");
        _requireRole(FREELANCER_ROLE, freelancer);
        if (!registry.allowedTokens(token)) revert TokenNotAllowed(token);

        uint256 n = amounts.length;
        if (n == 0 || n > MAX_MILESTONES) revert InvalidParams("milestones");
        if (deadline <= block.timestamp || deadline > block.timestamp + MAX_DURATION) {
            revert InvalidParams("deadline");
        }

        unchecked {
            escrowId = ++escrowCount;
        }
        uint256 total;
        mapping(uint256 => Milestone) storage ms = _milestones[escrowId];
        for (uint256 i; i < n;) {
            uint128 a = amounts[i];
            if (a == 0) revert InvalidParams("amount");
            total += a; // checked: cannot silently overflow
            ms[i].amount = a; // state defaults to Pending (0)
            unchecked {
                ++i;
            }
        }
        if (total > type(uint128).max) revert InvalidParams("total");

        if (token == address(0)) {
            if (msg.value != total) revert IncorrectPayment(total, msg.value);
        } else {
            if (msg.value != 0) revert IncorrectPayment(0, msg.value);
            uint256 before = IERC20(token).balanceOf(address(this));
            IERC20(token).safeTransferFrom(msg.sender, address(this), total);
            uint256 received = IERC20(token).balanceOf(address(this)) - before;
            // rejects fee-on-transfer / rebasing tokens that would under-collateralise the job
            if (received != total) revert IncorrectPayment(total, received);
        }

        _escrows[escrowId] = Escrow({
            client: msg.sender,
            deadline: deadline,
            status: Status.Created,
            milestoneCount: uint8(n),
            approvedCount: 0,
            feeBps: registry.feeBps(),
            freelancer: freelancer,
            clientRated: false,
            freelancerRated: false,
            token: token,
            total: uint128(total),
            released: 0
        });

        emit EscrowCreated(escrowId, msg.sender, freelancer, token, total, uint8(n), deadline, termsHash);
    }

    /// @notice Tx type: Client cancels before the freelancer accepts; full refund.
    function cancelEscrow(uint256 escrowId) external {
        Escrow storage e = _load(escrowId, Status.Created);
        if (msg.sender != e.client) revert NotAuthorized(msg.sender);
        uint128 refund = e.total - e.released;
        e.status = Status.Cancelled;
        e.released = e.total;
        balances[e.client][e.token] += refund;
        emit EscrowCancelled(escrowId, refund);
    }

    /// @notice Tx type: Client approves a submitted milestone, releasing its payment.
    function approveMilestone(uint256 escrowId, uint256 index) external whenNotPaused {
        Escrow storage e = _load(escrowId, Status.Active);
        if (msg.sender != e.client) revert NotAuthorized(msg.sender);
        if (index >= e.milestoneCount) revert InvalidParams("index");
        Milestone storage m = _milestones[escrowId][index];
        if (m.state != MilestoneState.Submitted) revert WrongMilestoneState(index, m.state);

        m.state = MilestoneState.Approved;
        uint256 amount = m.amount;
        uint256 fee = (amount * e.feeBps) / BPS;
        address token = e.token;
        unchecked {
            // amount <= total - released, fee <= amount: no overflow / underflow possible
            e.released += uint128(amount);
            balances[e.freelancer][token] += amount - fee;
            accruedFees[token] += fee;
        }
        emit MilestoneApproved(escrowId, index, amount - fee, fee);

        if (++e.approvedCount == e.milestoneCount) {
            e.status = Status.Completed;
            emit EscrowCompleted(escrowId);
            reputation.recordCompletion(e.client, e.freelancer);
        }
    }

    /// @notice Tx type: After the deadline, return every milestone the freelancer
    ///         never delivered. Callable by anyone (e.g. a keeper bot) so refunds can
    ///         be triggered automatically; funds always go to the client.
    function claimTimeoutRefund(uint256 escrowId) external {
        Escrow storage e = _escrows[escrowId];
        Status s = e.status;
        if (s != Status.Created && s != Status.Active) revert WrongStatus(s);
        if (block.timestamp <= e.deadline) revert DeadlineNotReached(e.deadline);

        uint256 refund;
        uint256 n = e.milestoneCount;
        mapping(uint256 => Milestone) storage ms = _milestones[escrowId];
        for (uint256 i; i < n;) {
            MilestoneState st = ms[i].state;
            // delivered work must be approved or disputed, never silently clawed back
            if (st == MilestoneState.Submitted) revert MilestoneUnderReview(i);
            if (st == MilestoneState.Pending) {
                ms[i].state = MilestoneState.Refunded;
                refund += ms[i].amount;
            }
            unchecked {
                ++i;
            }
        }

        e.status = Status.Refunded;
        e.released += uint128(refund);
        balances[e.client][e.token] += refund;
        emit TimeoutRefunded(escrowId, refund);

        if (s == Status.Active) reputation.recordTimeout(e.freelancer);
    }

    // ------------------------------------------------------------ freelancer flow

    /// @notice Tx type: Freelancer accepts the job, locking the terms.
    function acceptEscrow(uint256 escrowId) external whenNotPaused {
        Escrow storage e = _load(escrowId, Status.Created);
        if (msg.sender != e.freelancer) revert NotAuthorized(msg.sender);
        if (block.timestamp > e.deadline) revert DeadlinePassed(e.deadline);
        e.status = Status.Active;
        emit EscrowAccepted(escrowId, msg.sender);
    }

    /// @notice Tx type: Freelancer submits (or re-submits) a deliverable hash for a milestone.
    function submitMilestone(uint256 escrowId, uint256 index, bytes32 deliverableHash) external whenNotPaused {
        Escrow storage e = _load(escrowId, Status.Active);
        if (msg.sender != e.freelancer) revert NotAuthorized(msg.sender);
        if (index >= e.milestoneCount) revert InvalidParams("index");
        if (deliverableHash == bytes32(0)) revert InvalidParams("hash");
        Milestone storage m = _milestones[escrowId][index];
        MilestoneState st = m.state;
        if (st != MilestoneState.Pending && st != MilestoneState.Submitted) revert WrongMilestoneState(index, st);
        if (st == MilestoneState.Pending) m.state = MilestoneState.Submitted;
        emit MilestoneSubmitted(escrowId, index, deliverableHash);
    }

    // ------------------------------------------------------------ both parties

    /// @notice Tx type: Rate the counterparty (1-5) once the job is closed.
    function rateCounterparty(uint256 escrowId, uint8 score) external {
        Escrow storage e = _escrows[escrowId];
        if (e.status != Status.Completed && e.status != Status.Resolved) revert WrongStatus(e.status);
        address ratee;
        if (msg.sender == e.client) {
            if (e.clientRated) revert AlreadyRated();
            e.clientRated = true;
            ratee = e.freelancer;
        } else if (msg.sender == e.freelancer) {
            if (e.freelancerRated) revert AlreadyRated();
            e.freelancerRated = true;
            ratee = e.client;
        } else {
            revert NotAuthorized(msg.sender);
        }
        reputation.submitRating(msg.sender, ratee, score);
        emit CounterpartyRated(escrowId, msg.sender, ratee, score);
    }

    /// @notice Tx type: Pull everything credited to the caller in `token`.
    function withdraw(address token) external nonReentrant {
        uint256 amount = balances[msg.sender][token];
        if (amount == 0) revert NothingToWithdraw();
        balances[msg.sender][token] = 0; // effects before interaction
        _send(token, msg.sender, amount);
        emit Withdrawal(msg.sender, token, amount);
    }

    // ------------------------------------------------------------ dispute hooks

    /// @dev Called by DisputeResolution when a party opens a dispute.
    function markDisputed(uint256 escrowId) external onlyResolver {
        Escrow storage e = _load(escrowId, Status.Active);
        e.status = Status.Disputed;
        emit EscrowDisputed(escrowId);
    }

    /// @dev Called by DisputeResolution with the arbiter's ruling. Splits all
    ///      still-locked funds; the platform fee applies to the freelancer's share only.
    function settleDispute(uint256 escrowId, uint16 clientShareBps)
        external
        onlyResolver
        returns (uint256 toClient, uint256 toFreelancer)
    {
        if (clientShareBps > BPS) revert InvalidParams("bps");
        Escrow storage e = _load(escrowId, Status.Disputed);
        uint256 remaining = e.total - e.released;
        toClient = (remaining * clientShareBps) / BPS;
        uint256 gross = remaining - toClient;
        uint256 fee = (gross * e.feeBps) / BPS;
        toFreelancer = gross - fee;

        e.status = Status.Resolved;
        e.released = e.total;
        address token = e.token;
        balances[e.client][token] += toClient;
        balances[e.freelancer][token] += toFreelancer;
        accruedFees[token] += fee;
        emit DisputeSettled(escrowId, toClient, toFreelancer, fee);
    }

    // ------------------------------------------------------------ admin

    /// @notice Tx type (admin, one-off): wire the DisputeResolution module.
    function setDisputeResolver(address resolver) external onlyAdmin {
        if (disputeResolver != address(0)) revert ResolverAlreadySet();
        if (resolver == address(0)) revert InvalidParams("resolver");
        disputeResolver = resolver;
        emit DisputeResolverSet(resolver);
    }

    /// @notice Tx type: Admin withdraws accrued platform fees.
    function withdrawFees(address token, address to) external nonReentrant onlyAdmin {
        if (to == address(0)) revert InvalidParams("to");
        uint256 amount = accruedFees[token];
        if (amount == 0) revert NothingToWithdraw();
        accruedFees[token] = 0;
        _send(token, to, amount);
        emit FeesWithdrawn(token, to, amount);
    }

    // ------------------------------------------------------------ views

    function getEscrow(uint256 escrowId) external view returns (Escrow memory) {
        return _escrows[escrowId];
    }

    function getMilestones(uint256 escrowId) external view returns (Milestone[] memory list) {
        uint256 n = _escrows[escrowId].milestoneCount;
        list = new Milestone[](n);
        for (uint256 i; i < n; ++i) {
            list[i] = _milestones[escrowId][i];
        }
    }

    function partiesOf(uint256 escrowId) external view returns (address client, address freelancer, Status status) {
        Escrow storage e = _escrows[escrowId];
        return (e.client, e.freelancer, e.status);
    }

    // ------------------------------------------------------------ internal

    function _send(address token, address to, uint256 amount) private {
        if (token == address(0)) {
            (bool ok,) = payable(to).call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }
}
