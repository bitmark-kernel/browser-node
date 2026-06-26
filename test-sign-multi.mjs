// Prove multi-input legacy signing (coin selection): a tx spending TWO P2PKH UTXOs
// from two different addresses, each input signed with its own key over the LEGACY
// sighash, both verifying under the engine. This is what the wallet does when it
// combines coins to cover an amount.
import { readFile } from 'node:fs/promises';
import { Codec } from './engine/codec/codec.js';
import { ScriptEngine, addressToScript } from './engine/codec/script.js';
import { ScriptInterpreter } from './engine/codec/interpreter.js';
import { hash160, bytesToHex } from './engine/codec/hash.js';
import { mnemonicToSeed, deriveSigningKey, signEcdsa, toDer } from './wasm-keygen.js';

const D = new URL('./', import.meta.url);
const jl = async (n) => JSON.parse(await readFile(new URL(`engine/schema/${n}.jsonld`, D), 'utf8'));
const codec = new Codec(await jl('core'), await jl('proof'), await jl('p2p'));
const se = ScriptEngine.fromSchemas(await jl('script'), await jl('chain'), 'btm:mainnet');
const interp = new ScriptInterpreter(codec, se);
const push = (hex) => (hex.length / 2).toString(16).padStart(2, '0') + hex;

const seed = await mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', '');
const coin = (i) => { const key = deriveSigningKey(seed, { purpose: 44, coin: 177, change: 0, index: i }); return { key, spk: '76a914' + bytesToHex(hash160(key.pub)) + '88ac' }; };
const a = coin(0), b = coin(1);

// two inputs (300000 from 0/0, 250000 from 0/1) → send 500000, fee 10000, change 40000 back to 0/0
const ins = [{ ...a, value: 300000, txid: 'aa'.repeat(32), vout: 0 }, { ...b, value: 250000, txid: 'bb'.repeat(32), vout: 1 }];
const DEST = se.classify('76a914' + 'cc'.repeat(20) + '88ac').address;
const tx = {
  version: 1, lockTime: 0,
  inputs: ins.map((u) => ({ prevout: { txid: u.txid, vout: u.vout }, scriptSig: '', sequence: 0xffffffff })),
  outputs: [{ value: 500000, scriptPubKey: addressToScript(DEST, se.params) }, { value: 40000, scriptPubKey: a.spk }],
};
// sign each input independently over the legacy sighash with its own key
ins.forEach((u, i) => {
  const sh = interp.sighashLegacy(tx, i, u.spk, 0x01);
  tx.inputs[i].scriptSig = push(bytesToHex(toDer(signEcdsa(sh, u.key.priv))) + '01') + push(bytesToHex(u.key.pub));
});
const prevouts = ins.map((u) => ({ scriptPubKey: u.spk, value: u.value }));
let ok = true;
tx.inputs.forEach((_, i) => { const r = interp.verifyInput(tx, i, prevouts[i], prevouts); console.log(`input ${i} (${ins[i].value} sats): verifyInput ${r.ok} · ${r.type}`); ok = ok && r.ok === true; });
console.log('txid', codec.txid(tx), '·', codec.txSize(tx), 'bytes');

console.log(ok ? '\n✅ multi-input legacy signing proven — coin selection works (each input signed with its own key, all verify)' : '\n❌ FAIL');
process.exit(ok ? 0 : 1);
