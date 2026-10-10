// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title PlatformRegistry
/// @notice Single source of truth for roles, platform fee, allowed payment tokens
///         and the global circuit breaker. EscrowManager, DisputeResolution and
///         Reputation all read from this contract instead of keeping their own
///         copies, so the admin changes one place and every module follows.
contract PlatformRegistry is AccessControl, Pausable {
    /// DEFAULT_ADMIN_ROLE (from AccessControl) is the platform Admin.
    bytes32 public constant ARBITER_ROLE = keccak256("ARBITER_ROLE");
    bytes32 public constant CLIENT_ROLE = keccak256("CLIENT_ROLE");
    bytes32 public constant FREELANCER_ROLE = keccak256("FREELANCER_ROLE");

    uint16 public constant MAX_FEE_BPS = 1_000; // 10 % hard cap

    uint16 public feeBps;
    mapping(address => bool) public allowedTokens;

    event SelfRegistered(address indexed account, bytes32 indexed role);
    event PlatformFeeUpdated(uint16 oldFeeBps, uint16 newFeeBps);
    event TokenAllowed(address indexed token, bool allowed);

    error FeeTooHigh(uint16 requested, uint16 max);
    error RoleNotSelfAssignable(bytes32 role);
    error ZeroAddress();

    constructor(address admin, uint16 initialFeeBps) {
        if (admin == address(0)) revert ZeroAddress();
        if (initialFeeBps > MAX_FEE_BPS) revert FeeTooHigh(initialFeeBps, MAX_FEE_BPS);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        feeBps = initialFeeBps;
        allowedTokens[address(0)] = true; // native ETH
        emit PlatformFeeUpdated(0, initialFeeBps);
    }

    // ---------------------------------------------------------------- users

    /// @notice Anyone can onboard themselves as a Client or a Freelancer.
    ///         Arbiter and Admin are granted by an Admin only.
    function registerAs(bytes32 role) external whenNotPaused {
        if (role != CLIENT_ROLE && role != FREELANCER_ROLE) revert RoleNotSelfAssignable(role);
        if (_grantRole(role, msg.sender)) emit SelfRegistered(msg.sender, role);
    }

    // ---------------------------------------------------------------- admin

    function setPlatformFee(uint16 newFeeBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh(newFeeBps, MAX_FEE_BPS);
        emit PlatformFeeUpdated(feeBps, newFeeBps);
        feeBps = newFeeBps;
    }

    function setTokenAllowed(address token, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        allowedTokens[token] = allowed;
        emit TokenAllowed(token, allowed);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ---------------------------------------------------------------- views

    function isAdmin(address account) external view returns (bool) {
        return hasRole(DEFAULT_ADMIN_ROLE, account);
    }

    /// @notice Bitmask of roles for one account: 1=Admin 2=Client 4=Freelancer 8=Arbiter.
    ///         Lets the backend/frontend resolve all roles with one eth_call.
    function rolesOf(address account) external view returns (uint8 mask) {
        if (hasRole(DEFAULT_ADMIN_ROLE, account)) mask |= 1;
        if (hasRole(CLIENT_ROLE, account)) mask |= 2;
        if (hasRole(FREELANCER_ROLE, account)) mask |= 4;
        if (hasRole(ARBITER_ROLE, account)) mask |= 8;
    }
}
