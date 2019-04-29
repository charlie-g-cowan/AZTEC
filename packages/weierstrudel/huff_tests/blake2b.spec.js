const chai = require('chai');
const path = require('path');
const BN = require('bn.js');

const blake = require('../js_snippets/blake2b_reference');
const { Runtime } = require('../../huff');
const toBytes32 = require('../js_snippets/toBytes32');

const { expect } = chai;

const pathToTestData = path.posix.resolve(__dirname, '../huff_modules');

function numberToString(num, places = -1) {
    const numStr = num.toString(16);
    const zero = places - numStr.length + 1;
    if (places > -1 && zero < 0) {
        throw new Error(`number ${num} is too large to fit ${places} characters!`);
    }
    return Array(+(zero > 0 && zero)).join('0') + numStr;
}

function uint8ToString(w) {
    return numberToString(w, 2);
}

const blake2bHelperMacros = `
#include "blake2b.huff"

#define macro MIX_SECTION__IMPL = takes(0) returns(0) {
    SLICE_M()
    MIX_SECTION<M0,M1,M2,M3,M4,M5,M6,M7,M8,M9,M10,M11,M12,M13,M14,M15>()
}

#define macro ROR__IMPL = takes(0) returns(0) {
    ROR<32>()
}

#define macro ROL__IMPL = takes(0) returns(0) {
    ROL<32>()
}

#define macro COMPRESS__IMPL = takes(0) returns(0) {
    0x00 // set t = 0 for test
    COMPRESS<NO_V_14_TRANSFORM>()
}

#define macro COMPRESS_FINAL__IMPL = takes(0) returns(0) {
    128 // set t = 128
    COMPRESS<DO_V_14_TRANSFORM>()
}
`;

function generateTestData(numBytes, outputSize = 64) {
    const inputString = [...new Array(numBytes)].map((_, i) => uint8ToString(i % 256)).join('');
    const calldata = Buffer.from(`${toBytes32(outputSize.toString(16))}${inputString}`, 'hex');
    const expected = blake.blake2bHex(Buffer.from(inputString, 'hex'), null, outputSize);
    return { calldata, expected };
}

function getDummyStack(numElements, stackMasks) {
    return [
        ...stackMasks,
        ...[...new Array(numElements)].map(() => new BN(0)),
    ];
}

describe.only('blake2b', () => {
    let blake2b;
    let blake2bHelpers;
    let V;
    let memStart;
    let vStart;
    let stackMasks;
    before(async () => {
        blake2b = new Runtime('blake2b.huff', pathToTestData, true);
        blake2bHelpers = new Runtime(blake2bHelperMacros, pathToTestData, true);

        const { stack: [v01] } = await blake2b('V_0_1', [], [], []);
        const { stack: [v23] } = await blake2b('V_2_3', [], [], []);
        const { stack: [v45] } = await blake2b('V_4_5', [], [], []);
        const { stack: [v67] } = await blake2b('V_6_7', [], [], []);
        const { stack: [m0] } = await blake2b('M0', [], [], []);
        const { stack: [v01Loc] } = await blake2b('V_0_1_LOC', [], [], []);
        const { stack: [hiMask] } = await blake2b('HI_MASK', [], [], []);
        const { stack: [loMask] } = await blake2b('LO_MASK', [], [], []);
        const { stack: [overflowMask] } = await blake2b('OVERFLOW_MASK', [], [], []);

        stackMasks = [hiMask, loMask, overflowMask];
        V = [v01, v23, v45, v67, v01, v23, v45, v67];
        memStart = m0.toNumber();
        vStart = v01Loc.toNumber();
    });

    beforeEach(() => {
        blake.reset();
    });

    it('ROR works', async () => {
        const input = new BN('000000001122334455667788000000000000000099aabbccddeeffde00000000', 16);
        const expected = '0000000055667788112233440000000000000000ddeeffde99aabbcc00000000';
        const dummyStack = getDummyStack(9, stackMasks);
        const { stack } = await blake2bHelpers('ROR__IMPL', [...dummyStack, input], [], []);
        expect(toBytes32(stack[stack.length - 1].toString(16))).to.equal(expected);
    });

    it('ROL works', async () => {
        const input = new BN('000000001122334455667788000000000000000099aabbccddeeffde00000000', 16);
        const expected = '0000000055667788112233440000000000000000ddeeffde99aabbcc00000000';
        const dummyStack = getDummyStack(9, stackMasks);
        const { stack } = await blake2bHelpers('ROL__IMPL', [...dummyStack, input], [], []);
        expect(toBytes32(stack[stack.length - 1].toString(16))).to.equal(expected);
    });

    it('U64_ADD_THREE works', async () => {
        const a = new BN('000000001011121314151617000000000000000018191a1b1c1d1e1f00000000', 16);
        const b = new BN('000000000f0e0d0c0b0a09080000000000000000070605040302010000000000', 16);
        const c = new BN('00000000ffffffffffffffff0000000000000000ffffffffffffffff00000000', 16);
        const expected = '000000001f1f1f1f1f1f1f1e00000000000000001f1f1f1f1f1f1f1e00000000';
        const dummyStack = getDummyStack(9, stackMasks);
        const { stack } = await blake2b('U64_ADD_THREE', [...dummyStack, a, b, c], [], []);
        expect(toBytes32(stack[stack.length - 1].toString(16))).to.equal(expected);
    });

    it('U64_ADD_TWO works', async () => {
        const a = new BN('0000000000000000000000020000000000000000100000000000000300000000', 16);
        const b = new BN('00000000ffffffffffffffff0000000000000000ffffffffffffffff00000000', 16);
        const expected = '0000000000000000000000010000000000000000100000000000000200000000';
        const dummyStack = getDummyStack(9, stackMasks);
        const { stack } = await blake2b('U64_ADD_TWO', [...dummyStack, a, b], [], []);
        expect(toBytes32(stack[stack.length - 1].toString(16))).to.equal(expected);
    });

    it('BSWAP_UINT64 works', async () => {
        const input = new BN('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 16);
        const expected = '07060504030201000f0e0d0c0b0a090817161514131211101f1e1d1c1b1a1918';
        const { stack } = await blake2b('BSWAP_UINT64', [input], [], []);
        expect(stack.length).to.equal(1);
        expect(toBytes32(stack[0].toString(16))).to.equal(expected);
    });

    it('SLICE_M works', async () => {
        const memString = (index, len) => {
            return [...new Array(len)].map((_, i) => uint8ToString(index + i)).join('');
        };
        const inputMemory = [
            {
                index: memStart,
                value: new BN(memString(0x00, 32), 16),
            },
            {
                index: memStart + 0x20,
                value: new BN(memString(0x20, 32), 16),
            },
            {
                index: memStart + 0x40,
                value: new BN(memString(0x40, 32), 16),
            },
            {
                index: memStart + 0x60,
                value: new BN(memString(0x60, 32), 16),
            },
        ];
        const dummyStack = getDummyStack(9, stackMasks);
        const { stack, memory } = await blake2b('SLICE_M', dummyStack, inputMemory, []);
        expect(stack.length).to.equal(12);
        const result = memory.slice(memStart, memStart + 0x200);
        for (let i = 0; i < 0x200; i += 0x20) {
            const word = result.slice(i, i + 0x20);
            const index = i / 0x04;
            const hi = word.slice(0, 8).map(uint8ToString).join('');
            const lo = word.slice(8, 32).map(uint8ToString).join('');
            const expected = [...new Array(8)].map((_, idx) => uint8ToString(index + 7 - idx)).join('');
            expect(lo).to.equal('000000000000000000000000000000000000000000000000');
            expect(hi).to.equal(expected);
        }
    });


    it('MIX_SECTION works', async () => {
        const javascriptInput = [...new Array(256)].map((_, i) => i);
        const contractInput = [...new Array(4)].map((_, i) => {
            return new BN([...new Array(32)].map((__, b) => uint8ToString(b + (i * 32))).join(''), 16);
        });
        const contractMessageInMemory = [
            { index: memStart, value: contractInput[0] },
            { index: memStart + 0x20, value: contractInput[1] },
            { index: memStart + 0x40, value: contractInput[2] },
            { index: memStart + 0x60, value: contractInput[3] },
        ];

        const contractV = V.map((vv, i) => ({ index: vStart + i * 32, value: vv }));
        const initialMemory = [
            ...contractMessageInMemory,
            ...contractV,
        ];
        const dummyStack = getDummyStack(6, stackMasks);
        const { stack: almostStack, memory } = await blake2bHelpers('MIX_SECTION__IMPL', dummyStack, initialMemory, []);
        const comparison = blake.blake2bMixSectionDebug(javascriptInput, 0);
        const expected = [];
        const stack = almostStack.slice(9);
        for (let i = 0; i < 32; i += 2) {
            const hi = comparison[i + 1].toString(16);
            const lo = comparison[i].toString(16);
            expected.push(`${numberToString(hi, 8)}${numberToString(lo, 8)}`);
        }
        const output = memory.slice(vStart, vStart + 0x100);
        const result = [];
        for (let i = 0; i < 16; i += 1) {
            const first = output.slice((i * 32) + 4, i * 32 + 12).map(uint8ToString).join('');
            const second = output.slice(i * 32 + 20, i * 32 + 28).map(uint8ToString).join('');
            result.push(first);
            result.push(second);
        }
        expect(stack.length).to.equal(0);
        for (let i = 0; i < 16; i += 1) {
            expect(result[i]).to.equal(expected[i]);
        }
    });

    it('COMPRESS works', async () => {
        // take a base string of
        // 000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f (32 bytes)
        // and iterate 4 times to create 128 bytes
        // each time increasing each byte by iterator * 32
        const javascriptInput = [...new Array(256)].map((_, i) => i);
        const contractInput = [...new Array(4)].map((_, i) => {
            return new BN([...new Array(32)].map((__, b) => uint8ToString(b + (i * 32))).join(''), 16);
        });
        const contractMessageInMemory = [
            { index: memStart, value: contractInput[0] },
            { index: memStart + 0x20, value: contractInput[1] },
            { index: memStart + 0x40, value: contractInput[2] },
            { index: memStart + 0x60, value: contractInput[3] },
        ];

        const contractV = V.map((vv, i) => ({ index: vStart + i * 32, value: vv }));

        const initialMemory = [
            ...contractMessageInMemory,
            ...contractV,
        ];
        const dummyStack = getDummyStack(1, stackMasks);
        const { stack: almostStack, memory } = await blake2bHelpers('COMPRESS__IMPL', dummyStack, initialMemory, []);
        const stack = almostStack.slice(4);
        const comparison = blake.blake2bCompressDebug(javascriptInput);
        expect(stack.length).to.equal(1);

        const expected = [];
        for (let i = 0; i < 32; i += 2) {
            const hi = comparison[i + 1].toString(16);
            const lo = comparison[i].toString(16);
            expected.push(`${numberToString(hi, 8)}${numberToString(lo, 8)}`);
        }
        const output = memory.slice(vStart, vStart + 0x100);
        const result = [];
        for (let i = 0; i < 16; i += 1) {
            const first = output.slice((i * 32) + 4, i * 32 + 12).map(uint8ToString).join('');
            const second = output.slice(i * 32 + 20, i * 32 + 28).map(uint8ToString).join('');
            result.push(first);
            result.push(second);
        }
        for (let i = 0; i < 16; i += 1) {
            expect(result[i]).to.equal(expected[i]);
        }
    });


    it('COMPRESS works if final section', async () => {
        // take a base string of
        // 000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f (32 bytes)
        // and iterate 4 times to create 128 bytes
        // each time increasing each byte by iterator * 32
        const javascriptInput = [...new Array(256)].map((_, i) => i);
        const contractInput = [...new Array(4)].map((_, i) => {
            return new BN([...new Array(32)].map((__, b) => uint8ToString(b + (i * 32))).join(''), 16);
        });
        const contractMessageInMemory = [
            { index: memStart, value: contractInput[0] },
            { index: memStart + 0x20, value: contractInput[1] },
            { index: memStart + 0x40, value: contractInput[2] },
            { index: memStart + 0x60, value: contractInput[3] },
        ];

        const contractV = V.map((vv, i) => ({ index: vStart + i * 32, value: vv }));

        const initialMemory = [
            ...contractMessageInMemory,
            ...contractV,
        ];
        const dummyStack = getDummyStack(1, stackMasks);
        const { stack: almostStack, memory } = await blake2bHelpers('COMPRESS_FINAL__IMPL', dummyStack, initialMemory, []);
        const stack = almostStack.slice(4);
        const comparison = blake.blake2bCompressDebug(javascriptInput, 128, true);
        expect(stack.length).to.equal(1);

        const expected = [];
        for (let i = 0; i < 32; i += 2) {
            const hi = comparison[i + 1].toString(16);
            const lo = comparison[i].toString(16);
            expected.push(`${numberToString(hi, 8)}${numberToString(lo, 8)}`);
        }
        const output = memory.slice(vStart, vStart + 0x100);
        const result = [];
        for (let i = 0; i < 16; i += 1) {
            const first = output.slice((i * 32) + 4, i * 32 + 12).map(uint8ToString).join('');
            const second = output.slice(i * 32 + 20, i * 32 + 28).map(uint8ToString).join('');
            result.push(first);
            result.push(second);
        }
        for (let i = 0; i < 16; i += 1) {
            expect(result[i]).to.equal(expected[i]);
        }
    });

    it('BLAKE2B__INIT_V correctly computes initial v-vectors', async () => {
        const calldata = Buffer.from(toBytes32('40'), 'hex');
        const { stack, memory } = await blake2b('BLAKE2B__INIT_V', [], [], calldata);
        expect(stack.length).to.equal(0);
        const output = memory.slice(vStart, vStart + 0x80);
        const { h: comparison } = blake.blake2bInit(64, null);
        const result = [];
        for (let i = 0; i < 8; i += 1) {
            const first = output.slice((i * 32) + 4, i * 32 + 12).map(uint8ToString).join('');
            const second = output.slice(i * 32 + 20, i * 32 + 28).map(uint8ToString).join('');
            result.push(first);
            result.push(second);
        }
        const expected = [];
        for (let i = 0; i < 16; i += 2) {
            const hi = comparison[i + 1].toString(16);
            const lo = comparison[i].toString(16);
            expected.push(`${numberToString(hi, 8)}${numberToString(lo, 8)}`);
        }
        for (let i = 0; i < 8; i += 1) {
            expect(result[i]).to.equal(expected[i]);
        }
    });

    it('BLAKE2B__MAIN correctly computes hash for 128 bytes', async () => {
        const { calldata, expected } = generateTestData(128);
        const { stack, returnValue } = await blake2b('BLAKE2B__MAIN', [], [], calldata);
        expect(stack.length).to.equal(0);
        expect(returnValue.length > 0).to.equal(true);
        expect(returnValue.toString('hex')).to.equal(expected);
    }).timeout(50000);

    it('BLAKE2B__MAIN correctly computes hash for 256 bytes', async () => {
        const { calldata, expected } = generateTestData(256);
        const { stack, returnValue } = await blake2b('BLAKE2B__MAIN', [], [], calldata);
        expect(stack.length).to.equal(0);
        expect(returnValue.length > 0).to.equal(true);
        expect(returnValue.toString('hex')).to.equal(expected);
    }).timeout(50000);

    it('BLAKE2B__MAIN correctly computes hash for 160 bytes (zero padding)', async () => {
        const { calldata, expected } = generateTestData(160);
        const { stack, returnValue } = await blake2b('BLAKE2B__MAIN', [], [], calldata);
        expect(stack.length).to.equal(0);
        expect(returnValue.length > 0).to.equal(true);
        expect(returnValue.toString('hex')).to.equal(expected);
    }).timeout(50000);

    it('BLAKE2B__MAIN correctly computes hash for length < 64', async () => {
        const { calldata, expected } = generateTestData(160, 41);
        const { stack, returnValue } = await blake2b('BLAKE2B__MAIN', [], [], calldata);
        expect(stack.length).to.equal(0);
        expect(returnValue.length > 0).to.equal(true);
        expect(returnValue.toString('hex')).to.equal(expected);
    }).timeout(50000);

    it('BLAKE2B__MAIN will compute correct hash for 0 bytes', async () => {
        const { calldata, expected } = generateTestData(0);
        const { stack, returnValue } = await blake2b('BLAKE2B__MAIN', [], [], calldata);
        expect(stack.length).to.equal(0);
        expect(returnValue.length > 0).to.equal(true);
        expect(returnValue.toString('hex')).to.equal(expected);
    }).timeout(50000);

    it('BLAKE2B__MAIN will return 0 bytes if output length = 0', async () => {
        const { calldata } = generateTestData(0, 0);
        const { stack, returnValue } = await blake2b('BLAKE2B__MAIN', [], [], calldata);
        expect(stack.length).to.equal(0);
        expect(returnValue.length).to.equal(0);
    }).timeout(50000);

    it('BLAKE2B__MAIN will throw if output length > 64', async () => {
        const { calldata: almost } = generateTestData(128);
        const calldata = Buffer.from(`${toBytes32('41')}${almost.slice(32).toString('hex')}`, 'hex');
        let errMsg = '';
        try {
            await blake2b('BLAKE2B__MAIN', [], [], calldata);
        } catch (e) {
            errMsg = e;
        }
        expect(errMsg.error).to.equal('revert');
    }).timeout(50000);

    it('BLAKE2B__MAIN will correctly hass 65536 bytes of data', async () => {
        const { calldata, expected } = generateTestData(65536);
        console.log('calldata length = ', calldata.length);
        const { stack, returnValue } = await blake2b('BLAKE2B__MAIN', [], [], calldata);
        expect(stack.length).to.equal(0);
        expect(returnValue.length > 0).to.equal(true);
        expect(returnValue.toString('hex')).to.equal(expected);
    }).timeout(50000);
});
