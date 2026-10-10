// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PlatformRegistry} from "./PlatformRegistry.sol";
import {EscrowManager} from "./EscrowManager.sol";
import {Reputation} from "./Reputation.sol";

/// @title DisputeResolution
/// @notice Either party of an active escrow can open a dispute. Evidence is kept
///         off-chain (IPFS / object storage) and only its hash is emitted. An Admin
///         assigns an Arbiter, the Arbiter rules a client/freelancer split in basis
///         points, and this contract calls back into EscrowManager to settle funds
///         and into Reputation to record the outcome.
contract DisputeResolution {
    enum DisputeStatus {
        None,
        Open, // waiting for an arbiter
        UnderReview, // arbiter assigned
        Resolved
    }

    /// 2 storage slots per dispute.
    struct Dispute {
        // slot 0: 20 + 5 + 1 + 2 + 4 = 32 bytes
        address openedBy;
        uint40 openedAt;
        DisputeStatus status;
        uint16 clientShareBps;
        uint32 evidenceCount;
        // slot 1: 20 + 8 = 28 bytes
        address arbiter;
        uint64 escrowId;
    }

    bytes32 private constant ARBITER_ROLE = keccak256("ARBITER_ROLE");

    PlatformRegistry public immutable registry;
    EscrowManager public immutable escrow;
    Reputation public immutable reputation;

    uint256 public disputeCount;
    mapping(uint256 => Dispute) private _disputes;
    mapping(uint256 => uint256) public disputeOfEscrow; // escrowId => disputeId

    event DisputeOpened(uint256 indexed disputeId, uint256 indexed escrowId, address indexed openedBy, bytes32 reasonHash);
    event EvidenceSubmitted(uint256 indexed disputeId, address indexed submitter, bytes32 evidenceHash);
    event ArbiterAssigned(uint256 indexed disputeId, address indexed arbiter);
    event DisputeResolved(
        uint256 indexed disputeId,
        uint256 indexed escrowId,
        address indexed arbiter,
        uint16 clientShareBps,
        uint256 toClient,
        uint256 toFreelancer,
        bytes32 rulingHash
    );

    error NotAuthorized(address caller);
    error PlatformPaused();
    error WrongStatus(DisputeStatus current);
    error InvalidArbiter(address arbiter);
    error InvalidParams(string reason);

    constructor(PlatformRegistry registry_, EscrowManager escrow_, Reputation reputation_) {
        registry = registry_;
        escrow = escrow_;
        reputation = reputation_;
    }

    /// @notice Tx type: A party of an Active escrow raises a dispute, freezing its funds.
    function openDispute(uint256 escrowId, bytes32 reasonHash) external returns (uint256 disputeId) {
        if (registry.paused()) revert PlatformPaused();
        (address client, address freelancer,) = escrow.partiesOf(escrowId);
        if (msg.sender != client && msg.sender != freelancer) revert NotAuthorized(msg.sender);

        escrow.markDisputed(escrowId); // reverts unless the escrow is Active

        unchecked {
            disputeId = ++disputeCount;
        }
        _disputes[disputeId] = Dispute({
            openedBy: msg.sender,
            openedAt: uint40(block.timestamp),
            status: DisputeStatus.Open,
            clientShareBps: 0,
            evidenceCount: 0,
            arbiter: address(0),
            escrowId: uint64(escrowId)
        });
        disputeOfEscrow[escrowId] = disputeId;
        emit DisputeOpened(disputeId, escrowId, msg.sender, reasonHash);
    }

    /// @notice Tx type: Either party attaches an evidence document hash.
    function submitEvidence(uint256 disputeId, bytes32 evidenceHash) external {
        Dispute storage d = _disputes[disputeId];
        if (d.status != DisputeStatus.Open && d.status != DisputeStatus.UnderReview) revert WrongStatus(d.status);
        if (evidenceHash == bytes32(0)) revert InvalidParams("hash");
        (address client, address freelancer,) = escrow.partiesOf(d.escrowId);
        if (msg.sender != client && msg.sender != freelancer) revert NotAuthorized(msg.sender);
        unchecked {
            ++d.evidenceCount;
        }
        emit EvidenceSubmitted(disputeId, msg.sender, evidenceHash);
    }

    /// @notice Tx type (Admin): assign or re-assign an Arbiter. The arbiter must hold
    ///         ARBITER_ROLE and must not be one of the parties.
    function assignArbiter(uint256 disputeId, address arbiter) external {
        if (!registry.isAdmin(msg.sender)) revert NotAuthorized(msg.sender);
        Dispute storage d = _disputes[disputeId];
        if (d.status != DisputeStatus.Open && d.status != DisputeStatus.UnderReview) revert WrongStatus(d.status);
        if (!registry.hasRole(ARBITER_ROLE, arbiter)) revert InvalidArbiter(arbiter);
        (address client, address freelancer,) = escrow.partiesOf(d.escrowId);
        if (arbiter == client || arbiter == freelancer) revert InvalidArbiter(arbiter);
        d.arbiter = arbiter;
        d.status = DisputeStatus.UnderReview;
        emit ArbiterAssigned(disputeId, arbiter);
    }

    /// @notice Tx type (Arbiter): rule the split. clientShareBps = 10000 refunds the
    ///         client fully, 0 pays the freelancer fully.
    function resolveDispute(uint256 disputeId, uint16 clientShareBps, bytes32 rulingHash) external {
        Dispute storage d = _disputes[disputeId];
        if (d.status != DisputeStatus.UnderReview) revert WrongStatus(d.status);
        if (msg.sender != d.arbiter) revert NotAuthorized(msg.sender);
        // arbiter may have been revoked after assignment
        if (!registry.hasRole(ARBITER_ROLE, msg.sender)) revert InvalidArbiter(msg.sender);
        if (clientShareBps > 10_000) revert InvalidParams("bps");

        d.status = DisputeStatus.Resolved;
        d.clientShareBps = clientShareBps;
        uint256 escrowId = d.escrowId;

        (uint256 toClient, uint256 toFreelancer) = escrow.settleDispute(escrowId, clientShareBps);
        (address client, address freelancer,) = escrow.partiesOf(escrowId);
        reputation.recordDisputeOutcome(client, freelancer, clientShareBps);

        emit DisputeResolved(disputeId, escrowId, msg.sender, clientShareBps, toClient, toFreelancer, rulingHash);
    }

    function getDispute(uint256 disputeId) external view returns (Dispute memory) {
        return _disputes[disputeId];
    }
}
