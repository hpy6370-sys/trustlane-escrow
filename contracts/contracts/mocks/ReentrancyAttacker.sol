// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IEscrowManager {
    function createEscrow(address, address, uint128[] calldata, uint40, bytes32) external payable returns (uint256);
    function cancelEscrow(uint256) external;
    function withdraw(address) external;
}

interface IRegistry {
    function registerAs(bytes32) external;
}

/// @notice Test-only: a malicious client whose receive() tries to re-enter
///         EscrowManager.withdraw to drain more than its balance.
contract ReentrancyAttacker {
    IEscrowManager public immutable target;
    uint256 public reentryAttempts;
    bool public reentrySucceeded;

    constructor(IEscrowManager target_, IRegistry registry) {
        target = target_;
        registry.registerAs(keccak256("CLIENT_ROLE"));
    }

    function setup(address freelancer, uint40 deadline) external payable {
        uint128[] memory amounts = new uint128[](1);
        amounts[0] = uint128(msg.value);
        uint256 id = target.createEscrow{value: msg.value}(freelancer, address(0), amounts, deadline, bytes32(0));
        target.cancelEscrow(id);
    }

    function attack() external {
        target.withdraw(address(0));
    }

    receive() external payable {
        if (reentryAttempts == 0) {
            reentryAttempts = 1;
            // Swallow the revert so we can observe whether re-entry worked.
            try target.withdraw(address(0)) {
                reentrySucceeded = true;
            } catch {}
        }
    }
}
