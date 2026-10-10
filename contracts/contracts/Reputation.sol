// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PlatformRegistry} from "./PlatformRegistry.sol";

/// @title Reputation
/// @notice On-chain track record for every platform user. Only trusted modules
///         (EscrowManager, DisputeResolution) may write; anyone may read.
///         All counters for one user live in a single storage slot so each
///         update costs one SSTORE.
contract Reputation {
    struct Record {
        uint32 completedJobs;
        uint32 disputesWon;
        uint32 disputesLost;
        uint32 timeouts;
        uint32 ratingCount;
        uint32 ratingSum;
        uint64 reserved; // keeps the struct at exactly 256 bits for future fields
    }

    uint256 public constant BASE_SCORE = 500;
    uint256 public constant MAX_SCORE = 1_000;

    PlatformRegistry public immutable registry;
    mapping(address => bool) public isUpdater;
    mapping(address => Record) private _records;

    event UpdaterSet(address indexed module, bool allowed);
    event CompletionRecorded(address indexed client, address indexed freelancer);
    event DisputeRecorded(address indexed client, address indexed freelancer, uint16 clientShareBps);
    event TimeoutRecorded(address indexed freelancer);
    event Rated(address indexed rater, address indexed ratee, uint8 score);

    error NotUpdater(address caller);
    error NotAdmin(address caller);
    error InvalidScore(uint8 score);

    modifier onlyUpdater() {
        if (!isUpdater[msg.sender]) revert NotUpdater(msg.sender);
        _;
    }

    constructor(PlatformRegistry registry_) {
        registry = registry_;
    }

    /// @notice Admin authorises a module (EscrowManager / DisputeResolution) to write.
    function setUpdater(address module, bool allowed) external {
        if (!registry.isAdmin(msg.sender)) revert NotAdmin(msg.sender);
        isUpdater[module] = allowed;
        emit UpdaterSet(module, allowed);
    }

    function recordCompletion(address client, address freelancer) external onlyUpdater {
        unchecked {
            ++_records[client].completedJobs;
            ++_records[freelancer].completedJobs;
        }
        emit CompletionRecorded(client, freelancer);
    }

    /// @dev clientShareBps > 5000 counts as a client win, < 5000 as a freelancer
    ///      win, exactly 5000 (even split) changes nobody's win/loss record.
    function recordDisputeOutcome(address client, address freelancer, uint16 clientShareBps)
        external
        onlyUpdater
    {
        unchecked {
            if (clientShareBps > 5_000) {
                ++_records[client].disputesWon;
                ++_records[freelancer].disputesLost;
            } else if (clientShareBps < 5_000) {
                ++_records[freelancer].disputesWon;
                ++_records[client].disputesLost;
            }
        }
        emit DisputeRecorded(client, freelancer, clientShareBps);
    }

    function recordTimeout(address freelancer) external onlyUpdater {
        unchecked {
            ++_records[freelancer].timeouts;
        }
        emit TimeoutRecorded(freelancer);
    }

    function submitRating(address rater, address ratee, uint8 score) external onlyUpdater {
        if (score == 0 || score > 5) revert InvalidScore(score);
        Record storage r = _records[ratee];
        unchecked {
            ++r.ratingCount;
            r.ratingSum += score;
        }
        emit Rated(rater, ratee, score);
    }

    // ---------------------------------------------------------------- views

    function recordOf(address user) external view returns (Record memory) {
        return _records[user];
    }

    /// @notice 0..1000 score. 500 base, +20 per completed job, +10 per dispute won,
    ///         -40 per dispute lost, -30 per timeout, average rating shifts by
    ///         (avg - 3) * 50, i.e. -100..+100.
    function scoreOf(address user) public view returns (uint256) {
        Record memory r = _records[user];
        int256 s = int256(BASE_SCORE);
        s += int256(uint256(r.completedJobs)) * 20;
        s += int256(uint256(r.disputesWon)) * 10;
        s -= int256(uint256(r.disputesLost)) * 40;
        s -= int256(uint256(r.timeouts)) * 30;
        if (r.ratingCount > 0) {
            // (sum/count - 3) * 50, kept in integer math
            s += (int256(uint256(r.ratingSum)) * 50) / int256(uint256(r.ratingCount)) - 150;
        }
        if (s < 0) return 0;
        if (uint256(s) > MAX_SCORE) return MAX_SCORE;
        return uint256(s);
    }
}
