// Prove Bitmark legacy P2PKH signing: build a non-segwit tx, compute the LEGACY
// sighash, sign with the WASM secp, put <sig> <pubkey> in scriptSig, and confirm
// the engine's own verifier (ScriptInterpreter.verifyInput) accepts it. Bitmark
// has no SegWit, so this — not BIP143 — is how the wallet signs.
import { readFile } from 'node:fs/promises';
import { Codec } from './engine/codec/codec.js';
import { ScriptEngine, addressToScript } from './engine/codec/script.js';
import { ScriptInterpreter } from './engine/codec/interpreter.js';
import { hash160, bytesToHex, hexToBytes } from './engine/codec/hash.js';
import { mnemonicToSeed, deriveSigningKey, signEcdsa, toDer } from './wasm-keygen.js';

const D = new URL('./', import.meta.url);
const jl = async (n) => JSON.parse(await readFile(new URL(`engine/schema/${n}.jsonld`, D), 'utf8'));
const codec = new Codec(await jl('core'), await jl('proof'), await jl('p2p'));
const se = ScriptEngine.fromSchemas(await jl('script'), await jl('chain'), 'btm:mainnet');
const interp = new ScriptInterpreter(codec, se);

const seed = await mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', '');
const key = deriveSigningKey(seed, { purpose: 44, coin: 177, change: 0, index: 0 });
const pkh = bytesToHex(hash160(key.pub));
const scriptPubKey = '76a914' + pkh + '88ac';                 // P2PKH (the funding output)
const myAddr = se.classify(scriptPubKey).address;

// push a byte-string onto a script (data < 76 bytes → single length byte)
const push = (hex) => (hex.length / 2).toString(16).padStart(2, '0') + hex;

const AMOUNT = 1_000_000, FEE = 10_000;                        // sats (1 BTM = 1e8)
const DEST = se.classify('76a914' + 'bb'.repeat(20) + '88ac').address;
const tx = {
  version: 1, lockTime: 0,
  inputs: [{ prevout: { txid: 'cc'.repeat(32), vout: 0 }, scriptSig: '', sequence: 0xffffffff }],
  outputs: [
    { value: AMOUNT - FEE - 400000, scriptPubKey: addressToScript(DEST, se.params) },
    { value: 400000, scriptPubKey },                          // change back to ourselves
  ],
};

// LEGACY sighash over the prevout's scriptPubKey, SIGHASH_ALL → sign → scriptSig
const sighash = interp.sighashLegacy(tx, 0, scriptPubKey, 0x01);
const sigHex = bytesToHex(toDer(signEcdsa(sighash, key.priv))) + '01';
tx.inputs[0].scriptSig = push(sigHex) + push(bytesToHex(key.pub));

const prevout = { scriptPubKey, value: AMOUNT };
const r = interp.verifyInput(tx, 0, prevout, [prevout]);
const rawHex = codec.encodeHex('Transaction', tx);
const roundtrip = codec.encodeHex('Transaction', codec.decode('Transaction', hexToBytes(rawHex))) === rawHex;
console.log('from', myAddr, '· spend P2PKH · type', r.type);
console.log('scriptSig:', tx.inputs[0].scriptSig.slice(0, 24) + '…');
console.log('txid', codec.txid(tx), '·', rawHex.length / 2, 'bytes · re-decodes', roundtrip ? '✓' : '✗');
console.log('verifyInput:', r.ok);

const ok = r.ok === true && roundtrip && !rawHex.startsWith('01000000000101');   // NOT segwit-serialized
console.log(ok ? '\n✅ Bitmark legacy P2PKH signing proven — verifies under the engine, serializes as a legacy (non-witness) tx' : '\n❌ FAIL');
process.exit(ok ? 0 : 1);
