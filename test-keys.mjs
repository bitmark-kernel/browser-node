// Prove Bitmark legacy P2PKH key derivation: a BIP39 mnemonic → BIP44 account
// (m/44'/177'/0') → P2PKH addresses that encode as Bitmark base58 'b…' (version 85).
// No segwit on Bitmark, so this is the address type the wallet uses.
import { readFile } from 'node:fs/promises';
import { ScriptEngine } from './engine/codec/script.js';
import { hash160, bytesToHex } from './engine/codec/hash.js';
import { mnemonicToSeed, deriveSigningKey } from './wasm-keygen.js';

const D = new URL('./', import.meta.url);
const jl = async (n) => JSON.parse(await readFile(new URL(`engine/schema/${n}.jsonld`, D), 'utf8'));
const se = ScriptEngine.fromSchemas(await jl('script'), await jl('chain'), 'btm:mainnet');

const COIN = 177;   // Bitmark SLIP-44
const seed = await mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', '');

function addrAt(change, index) {
  const key = deriveSigningKey(seed, { purpose: 44, coin: COIN, change, index });
  const spk = '76a914' + bytesToHex(hash160(key.pub)) + '88ac';   // P2PKH
  return { ...se.classify(spk), spk, key };
}

console.log('Bitmark legacy P2PKH addresses (m/44′/177′/0′/0/i):');
let ok = true;
for (let i = 0; i < 5; i++) {
  const a = addrAt(0, i);
  const isP2pkh = a.type === 'p2pkh' && typeof a.address === 'string' && a.address.startsWith('b');
  ok = ok && isP2pkh;
  console.log(`  0/${i}  ${a.address}  ${isP2pkh ? '✓' : '✗ ' + JSON.stringify(a)}`);
}
// round-trip: the address must decode back to the same scriptPubKey
const { addressToScript } = await import('./engine/codec/script.js');
const a0 = addrAt(0, 0);
const back = addressToScript(a0.address, se.params);
const rt = back === a0.spk;
console.log('round-trip address→script:', rt ? '✓' : `✗ ${back} != ${a0.spk}`);
ok = ok && rt;

console.log(ok ? '\n✅ Bitmark P2PKH keygen proven: BIP44 → base58 b… addresses, address↔script round-trips' : '\n❌ FAIL');
process.exit(ok ? 0 : 1);
