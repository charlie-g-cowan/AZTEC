pragma solidity >=0.5.0 <0.6.0;

import "./PublicRangeABIEncoder.sol";
import "../../../interfaces/PublicRangeInterface.sol";

/**
 * @title PublicRange
 * @author AZTEC
 * @dev Library to validate AZTEC public range zero-knowledge proofs
 * Don't include this as an internal library. This contract uses 
 * a static memory table to cache elliptic curve primitives and hashes.
 * Calling this internally from another function will lead to memory 
 * mutation and undefined behaviour.
 * The intended use case is to call this externally via `staticcall`. External 
 * calls to OptimizedAZTEC can be treated as pure functions as this contract 
 * contains no storage and makes no external calls (other than to precompiles)
 * Copyright Spilsbury Holdings Ltd 2019. All rights reserved.
 **/
contract PublicRange {

    /**
     * @dev PublicRange.sol will take any transaction sent to it and attempt to validate a zero knowledge proof.
     * If the proof is not valid, the transaction throws.
     * @notice See PublicRangeInterface for how method calls should be constructed.
     * PublicRange.sol is written in YUL to enable manual memory management and for other efficiency savings.
     **/
    // solhint-disable payable-fallback
    function() external {
        assembly {

            // We don't check for function signatures, there's only one function that 
            // ever gets called: validatePublicRange()
            // We still assume calldata is offset by 4 bytes so that we can represent 
            // this contract through a compatible ABI
            validatePublicRange()

            // if we get to here, the proof is valid. We now 'fall through' the assembly block
            // and into PublicRange.validatePublicRange()
            // reset the free memory pointer because we're touching Solidity code again
            mstore(0x40, 0x60)
            /**
             * New calldata map
             * 0x04:0x24      = calldata location of proofData byte array 
             * 0x24:0x44      = message sender // sender
             * 0x44:0x64      = h_x     // crs
             * 0x64:0x84      = h_y     // crs
             * 0x84:0xa4      = t2_x0   // crs
             * 0xa4:0xc4      = t2_x1   // crs
             * 0xa4:0xc4      = t2_x1   // crs
             * 0xc4:0xe4      = t2_y0   // crs
             * 0xe4:0x104     = t2_y1   // crs
             * 0x104:0x124    = length of proofData byte array 
             * 0x124:0x144    = challenge
             * 0x144:0x164    = publicComparison
             * 0x164:0x184    = offset in byte array to notes
             * 0x184:0x1a4    = offset in byte array to inputOwners
             * 0x1a4:0x1c4    = offset in byte array to outputOwners
             * 0x1c4:0x1e4    = offset in byte array to metadata
             *
             *
             * Note data map (uint[6]) is
             * 0x00:0x20       = Z_p element \bar{k}_i
             * 0x20:0x40       = Z_p element \bar{a}_i
             * 0x40:0x80       = G1 element \gamma_i
             * 0x80:0xc0       = G1 element \sigma_i
             *
             * We use a hard-coded memory map to reduce gas costs - if this is not called as an 
             * external contract then terrible things will happen!
             *
             * 0x00:0x20       = scratch data to store result of keccak256 calls
             * 0x20:0x80       = scratch data to store \gamma_i and a multiplication scalar
             * 0x80:0xc0       = x-coordinate of generator h
             * 0xc0:0xe0       = y-coordinate of generator h
             * 0xe0:0x100      = scratch data to store a scalar we plan to multiply h by
             * 0x100:0x160     = scratch data to store \sigma_i and a multiplication scalar
             * 0x160:0x1a0     = stratch data to store result of G1 point additions
             * 0x1a0:0x1c0     = scratch data to store result of \sigma_i^{-cx_{i-m-1}}
             * 0x220:0x260     = scratch data to store \gamma_i^{cx_{i-m-1}}
             * 0x2e0:0x300     = msg.sender (contract should be called via delegatecall/staticcall)
             * 0x300:???       = block of memory that contains (\gamma_i, \sigma_i)_{i=0}^{n-1} 
             *                   concatenated with (B_i)_{i=0}^{n-1}
             **/
            function validatePublicRange() {
                /*
                ///////////////////////////////////////////  SETUP  //////////////////////////////////////////////
                */

                mstore(0x80, calldataload(0x44)) // h_x
                mstore(0xa0, calldataload(0x64)) // h_y
                let notes := add(0x104, calldataload(0x164)) // start position of notes
                let n := 2
                let m := 1
                let gen_order := 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001
                let challenge := mod(calldataload(0x124), gen_order)
                let publicComparison := mod(calldataload(0x144), gen_order)

                mstore(0x2e0, calldataload(0x24)) // store the msg.sender, to be hashed later
                mstore(0x300, publicComparison) 
                mstore(0x320, 0) // add kPublic = 0 to the hash
                mstore(0x340, 0) // add publicOwner to the hash
                hashCommitments(notes, n)
                let b := add(0x360, mul(n, 0x80))

                /*
                ///////////////////////////  CALCULATE BLINDING FACTORS  /////////////////////////////////////
                */

                // Iterate over every note and calculate the blinding factor B_i = \gamma_i^{kBar}h^{aBar}\sigma_i^{-c}.
                for { let i := 0 } lt(i, n) { i := add(i, 0x01) } {
                    // Get the calldata index of this note and associated parameters
                    let noteIndex := add(add(notes, 0x20), mul(i, 0xc0))
                    let k
                    let a := calldataload(add(noteIndex, 0x20))
                    let c := challenge

                    switch gt(i, 0)
                    case 1 {
                        /*
                        Enforce the condition k_2 = k_1 - c*publicComparison
                        */
                        k := addmod(
                            calldataload(sub(noteIndex, 0xc0)), // k_1
                            mulmod(sub(gen_order, c), publicComparison, gen_order), 
                            gen_order
                        )
                    } 
                        
                    case 0 {
                        k := calldataload(noteIndex)

                    }

                    // Check this commitment is well formed
                    validateCommitment(noteIndex, k, a)

                    if gt(i, 0) {
                        // Set k = kx_j, a = ax_j, c = cx_j, where j = i - (m+1)
                        let x := mod(mload(0x00), gen_order) // x is the kecca hash of the input commitments
                        k := mulmod(k, x, gen_order) // kx
                        a := mulmod(a, x, gen_order) // ax
                        c := mulmod(challenge, x, gen_order) // cx
                    }
                    
                    // Calculate the G1 element \gamma_i^{k}h^{a}\sigma_i^{-c} = B_i
                    // Memory map:
                    // 0x20: \gamma_iX
                    // 0x40: \gamma_iY
                    // 0x60: k_i
                    // 0x80: hX
                    // 0xa0: hY
                    // 0xc0: a_i
                    // 0xe0: \sigma_iX
                    // 0x100: \sigma_iY
                    // 0x120: -c


                    // * Note data map (uint[6]) is
                    // * 0x00:0x20       = Z_p element \bar{k}_i
                    // * 0x20:0x40       = Z_p element \bar{a}_i
                    // * 0x40:0x80       = G1 element \gamma_i
                    // * 0x80:0xc0       = G1 element \sigma_i

                    // loading into memory
                    calldatacopy(0xe0, add(noteIndex, 0x80), 0x40)
                    calldatacopy(0x20, add(noteIndex, 0x40), 0x40)
                    mstore(0x120, sub(gen_order, c)) 
                    mstore(0x60, k)
                    mstore(0xc0, a)

                    // Call bn128 scalar multiplication precompiles
                    // Represent point + multiplication scalar in 3 consecutive blocks of memory
                    // Store \sigma_i^{-c} at 0x1a0:0x200
                    // Store \gamma_i^{k} at 0x120:0x160
                    // Store h^{a} at 0x160:0x1a0
                    let result := staticcall(gas, 7, 0xe0, 0x60, 0x1a0, 0x40) // sigmai^-c
                    result := and(result, staticcall(gas, 7, 0x20, 0x60, 0x120, 0x40))
                    result := and(result, staticcall(gas, 7, 0x80, 0x60, 0x160, 0x40))

                    // Call bn128 group addition precompiles
                    // \gamma_i^{k} and h^{a} in memory block 0x120:0x1a0
                    // Store result of addition at 0x160:0x1a0
                    result := and(result, staticcall(gas, 6, 0x120, 0x80, 0x160, 0x40))

                    // \gamma_i^{k}h^{a} and \sigma^{-c} in memory block 0x160:0x1e0
                    // Store resulting point B at memory index b
                    result := and(result, staticcall(gas, 6, 0x160, 0x80, b, 0x40))

                    // Perform the pairing check for all notes - we do this by rolling all note coordinates into the
                    // accumulator, upon which the pairing check is performed. 
                    // We do this adding \sigma^{-c} and \sigma_{acc} and storing the result at 
                    // \sigma_{acc} (0x1e0:0x200). We then calculate \gamma^{cx} and add into \gamma_{acc}
                    mstore(0x60, c)
                    result := and(result, staticcall(gas, 7, 0x20, 0x60, 0x220, 0x40))

                    // \gamma_i^{cx} now at 0x220:0x260, \gamma_{acc} is at 0x260:0x2a0
                    result := and(result, staticcall(gas, 6, 0x220, 0x80, 0x260, 0x40))

                    // add \sigma_i^{-cx} and \sigma_{acc} into \sigma_{acc} at 0x1e0
                    result := and(result, staticcall(gas, 6, 0x1a0, 0x80, 0x1e0, 0x40))

                    // throw transaction if any calls to precompiled contracts failed
                    if iszero(result) { mstore(0x00, 400) revert(0x00, 0x20) }
                    b := add(b, 0x40) // increase B pointer by 2 words
                }

                    // Can assume by induction that k_1 is the output of a previous AZTEC transaction, and therefore 
                    // it already satisfies a range proof. Only need to perform an explicit range check on k2
                    validatePairing(0x84)
            
                /*
                ////////////////////  RECONSTRUCT INITIAL CHALLENGE AND VERIFY A MATCH  ////////////////////////////////
                */

                // We now have the note commitments and the calculated blinding factors in a block of memory
                // starting at 0x2e0, of size (b - 0x2e0).
                // Hash this block to reconstruct the initial challenge and validate that they match
                let expected := mod(keccak256(0x2e0, sub(b, 0x2e0)), gen_order)

                if iszero(eq(expected, challenge)) {

                    // No! Bad! No soup for you!
                    mstore(0x00, 404)
                    revert(0x00, 0x20)
                }
            }

            /**
             * @dev check that this note's points are on the altbn128 curve(y^2 = x^3 + 3)
             * and that signatures 'k' and 'a' are modulo the order of the curve. Transaction
             * throws if this is not the case.
             * @param note the calldata loation of the note
             **/
            function validateCommitment(note, k, a) {
                let gen_order := 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001
                let field_order := 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47
                let gammaX := calldataload(add(note, 0x40))
                let gammaY := calldataload(add(note, 0x60))
                let sigmaX := calldataload(add(note, 0x80))
                let sigmaY := calldataload(add(note, 0xa0))
                if iszero(
                    and(
                        and(
                            and(
                                eq(mod(a, gen_order), a), // a is modulo generator order?
                                gt(a, 1)                  // can't be 0 or 1 either!
                            ),
                            and(
                                eq(mod(k, gen_order), k), // k is modulo generator order?
                                gt(k, 1)                  // and not 0 or 1
                            )
                        ),
                        and(
                            eq( // y^2 ?= x^3 + 3
                                addmod(mulmod(
                                    mulmod(sigmaX, sigmaX, field_order), sigmaX, field_order), 
                                    3, 
                                    field_order),
                                mulmod(sigmaY, sigmaY, field_order)
                            ),
                            eq( // y^2 ?= x^3 + 3
                                addmod(mulmod(
                                    mulmod(gammaX, gammaX, field_order), 
                                    gammaX, 
                                    field_order), 
                                    3, field_order),
                                mulmod(gammaY, gammaY, field_order)
                            )
                        )
                    )
                ) {
                    mstore(0x00, 400)
                    revert(0x00, 0x20)
                }
            }

            /**        
             * @dev evaluate if e(P1, t2) . e(P2, g2) == 0.
             * @notice we don't hard-code t2 so that contracts that call this library can use different trusted setups.
             **/
            function validatePairing(t2) {
                let field_order := 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47
                let t2_x_1 := calldataload(t2)
                let t2_x_2 := calldataload(add(t2, 0x20))
                let t2_y_1 := calldataload(add(t2, 0x40))
                let t2_y_2 := calldataload(add(t2, 0x60))

                // check provided setup pubkey is not zero or g2
                if or(or(or(or(or(or(or(
                    iszero(t2_x_1),
                    iszero(t2_x_2)),
                    iszero(t2_y_1)),
                    iszero(t2_y_2)),
                    eq(t2_x_1, 0x1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed)),
                    eq(t2_x_2, 0x198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2)),
                    eq(t2_y_1, 0x12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa)),
                    eq(t2_y_2, 0x90689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b))
                {
                    mstore(0x00, 400)
                    revert(0x00, 0x20)
                }

                // store coords in memory
                // indices are a bit off, scipr lab's libff limb ordering (c0, c1) is opposite
                // to what precompile expects. We can overwrite the memory we used previously as this function
                // is called at the end of the validation routine.
                mstore(0x20, mload(0x1e0)) // sigma accumulator x
                mstore(0x40, mload(0x200)) // sigma accumulator y
                mstore(0x80, 0x1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed)
                mstore(0x60, 0x198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2)
                mstore(0xc0, 0x12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa)
                mstore(0xa0, 0x90689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b)
                mstore(0xe0, mload(0x260)) // gamma accumulator x
                mstore(0x100, mload(0x280)) // gamma accumulator y
                mstore(0x140, t2_x_1)
                mstore(0x120, t2_x_2)
                mstore(0x180, t2_y_1)
                mstore(0x160, t2_y_2)

                let success := staticcall(gas, 8, 0x20, 0x180, 0x20, 0x20)

                if or(iszero(success), iszero(mload(0x20))) {
                    mstore(0x00, 400)
                    revert(0x00, 0x20)
                }
            }

            /**
             * @dev Calculate the keccak256 hash of the commitments for both 
             * input notes and output notes. This is used both as an input to 
             * validate the challenge `c` and also to generate pseudorandom relationships
             * between commitments for different outputNotes, so that we can combine 
             * them into a single multi-exponentiation for the purposes of validating 
             * the bilinear pairing relationships.
             * @param notes calldata location notes
             * @param n number of notes
             **/
            function hashCommitments(notes, n) {
                for { let i := 0 } lt(i, n) { i := add(i, 0x01) } {
                let index := add(add(notes, mul(i, 0xc0)), 0x60)
                calldatacopy(add(0x360, mul(i, 0x80)), index, 0x80)
                }
                // storing at position 0x00 in memory, the kecca hash of everything from 
                // start of the commitments to the end
                mstore(0x00, keccak256(0x360, mul(n, 0x80)))
            }
        }
        // if we've reached here, we've validated the public range proof and haven't thrown an error.
        // Encode the output according to the ACE standard and exit.
        PublicRangeABIEncoder.encodeAndExit();
    }
}
