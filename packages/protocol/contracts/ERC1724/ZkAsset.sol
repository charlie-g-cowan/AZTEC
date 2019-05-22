pragma solidity >=0.5.0 <0.6.0;

import "openzeppelin-solidity/contracts/math/SafeMath.sol";

import "../ACE/NoteRegistry.sol";
import "../ACE/ACE.sol";
import "./base/ZkAssetBase.sol";

import "../libs/ProofUtils.sol";

/**
 * @title ZkAsset
 * @author AZTEC
 * @dev A contract defining the standard interface and behaviours of a confidential asset.
 * The ownership values and transfer values are encrypted.
 * Copyright Spilbury Holdings Ltd 2019. All rights reserved.
 **/
contract ZkAsset is ZkAssetBase {

    constructor(
        address _aceAddress,
        address _linkedTokenAddress,
        uint256 _scalingFactor
    ) ZkAssetBase(
        _aceAddress,
        _linkedTokenAddress,
        _scalingFactor,
        false // Can adjust supply
    ) public {
    }
}
