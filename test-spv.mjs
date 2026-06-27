// Prove SPV inclusion for Bitmark via ElectrumX: take a confirmed txid, fetch its
// merkle branch (blockchain.transaction.get_merkle), fold it with the txid, and
// check the reconstructed root equals the block header's merkleRoot. That proves
// the tx is in that block — verified locally, the server only supplies the branch.
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { Codec } from './engine/codec/codec.js';
import { ScriptEngine, addressToScript } from './engine/codec/script.js';
import { dsha256, hexToBytes, bytesToHex } from './engine/codec/hash.js';

const D = new URL('./', import.meta.url);
const jl = async (n) => JSON.parse(await readFile(new URL(`engine/schema/${n}.jsonld`, D), 'utf8'));
const codec = new Codec(await jl('core'), await jl('proof'), await jl('p2p'));
const se = ScriptEngine.fromSchemas(await jl('script'), await jl('chain'), 'btm:mainnet');
const cfg = JSON.parse(await readFile(new URL('data/bitmark.json', D), 'utf8')).electrum;
const rev = (h) => bytesToHex(hexToBytes(h).reverse());

const sock = net.connect(cfg.tcp, cfg.host);
let buf = '', id = 0; const pend = new Map();
sock.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue; const m = JSON.parse(l); const p = pend.get(m.id); if (p) { pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } } });
const call = (method, params = []) => new Promise((res, rej) => { const x = id++; pend.set(x, { res, rej }); sock.write(JSON.stringify({ id: x, method, params }) + '\n'); setTimeout(() => { if (pend.has(x)) { pend.delete(x); rej(new Error('timeout ' + method)); } }, 15000); });
await new Promise((r) => sock.on('connect', r));
await call('server.version', ['spv', '1.4']);

// pick a confirmed UTXO of a known funded address to get (txid, height)
const ADDR = process.env.ADDR || 'bSA2XJA4NAnUYLZ2wH9r6zWRFHuK8jkp9i';
const sh = bytesToHex((await import('./engine/codec/hash.js')).sha256(hexToBytes(addressToScript(ADDR, se.params))).reverse());
const utxos = await call('blockchain.scripthash.listunspent', [sh]);
const u = utxos.find((x) => x.height > 0);
if (!u) { console.log('no confirmed utxo for', ADDR); process.exit(1); }
console.log('proving inclusion of', u.tx_hash.slice(0, 16) + '…', 'at height', u.height);

// merkle branch + the block header
const proof = await call('blockchain.transaction.get_merkle', [u.tx_hash, u.height]);
const headerHex = await call('blockchain.block.header', [u.height]);
const header = codec.decode('BlockHeader', headerHex);

// fold the branch: work in internal (LE) byte order, then compare display roots
let h = hexToBytes(rev(u.tx_hash));   // txid internal
let pos = proof.pos;
for (const branch of proof.merkle) { const b = hexToBytes(rev(branch)); h = pos & 1 ? dsha256(new Uint8Array([...b, ...h])) : dsha256(new Uint8Array([...h, ...b])); pos >>= 1; }
const rootDisplay = rev(bytesToHex(h));
console.log('reconstructed root:', rootDisplay);
console.log('header merkleRoot :', header.merkleRoot);
console.log('block hash @height:', codec.blockHash(header), '(branch len', proof.merkle.length + ')');

sock.destroy();
const ok = rootDisplay === header.merkleRoot;
console.log(ok ? `\n✅ SPV inclusion PROVEN — tx is in block ${u.height}, merkle root reconstructed locally from the branch` : '\n❌ root mismatch');
process.exit(ok ? 0 : 1);
