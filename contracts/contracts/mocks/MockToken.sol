// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev A plain mintable ERC-20 for tests and the local table.
contract MockToken is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev An ERC-20 that keeps `taxBps` of every transfer, to prove the coop
///      only ever counts what actually arrived.
contract TaxedToken is ERC20 {
    uint256 public immutable taxBps;
    address public immutable sink;

    constructor(uint256 taxBps_, address sink_) ERC20("Taxed", "TAX") {
        taxBps = taxBps_;
        sink = sink_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }
        uint256 tax = (value * taxBps) / 10_000;
        super._update(from, sink, tax);
        super._update(from, to, value - tax);
    }
}
