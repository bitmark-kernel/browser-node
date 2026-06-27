// Prove assumeUTXO: load the validated keystone snapshot, then validate blocks
// FORWARD from it against the kernel — without replaying from genesis. This is what
// fullnode.html's keystone mode does (and how a tab reaches the tip).
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { Codec } from './engine/codec/codec.js';
import { P2pEngine } from './engine/codec/p2p.js';
import { BlockEngine } from './engine/codec/blocks.js';
import { ScriptEngine } from './engine/codec/script.js';
import { ScriptInterpreter } from './engine/codec/interpreter.js';

const D = new URL('./', import.meta.url);
const jl = async (n) => JSON.parse(await readFile(new URL(`engine/schema/${n}.jsonld`, D), 'utf8'));
const codec = new Codec(await jl('core'), await jl('proof'), await jl('p2p'));
const p2p = P2pEngine.fromSchemas(codec, await jl('p2p'), await jl('chain'), 'btm:mainnet');
const be = BlockEngine.fromSchemas(codec, await jl('chain'), await jl('validate'), await jl('script'), 'btm:mainnet');
const interp = new ScriptInterpreter(codec, ScriptEngine.fromSchemas(await jl('script'), await jl('chain'), 'btm:mainnet'));
const v = JSON.parse(await readFile(new URL('data/bitmark.json', D), 'utf8'));

// load the keystone snapshot into a UTXO map (object values)
const SNAP = process.env.SNAP || 'data/snapshot-50000.json';
const lines = (await readFile(new URL(SNAP, D), 'utf8')).split('\n').filter(Boolean);
const meta = JSON.parse(lines[0]);
const utxo = new Map();
for (let i = 1; i < lines.length; i++) { const [k, val] = JSON.parse(lines[i]); const [s, spk, ht, cb] = val.split('\t'); utxo.set(k, { output: { value: Number(s), scriptPubKey: spk }, height: Number(ht), coinbase: cb === '1' }); }
console.log(`keystone loaded: ${utxo.size} coins at height ${meta.height} (${meta.hash.slice(0, 16)}…)`);

const FORWARD = parseInt(process.env.FORWARD || '500', 10);
const MSG_BLOCK = 2;
const sock = net.connect(v.port, process.env.PEER_HOST || v.peers[0]);
let buf = Buffer.alloc(0); const waiters = []; const blocks = new Map();
const send = (c, p) => sock.write(Buffer.from(p2p.encodeMessage(c, p)));
const want = (cmd, ms = 30000) => new Promise((res, rej) => { const w = { cmd, res, rej, timer: setTimeout(() => rej(new Error('timeout ' + cmd)), ms) }; waiters.push(w); });
const end = (c) => { try { sock.destroy(); } catch {} process.exit(c); };
const guard = setTimeout(() => { console.log('❌ timeout'); end(1); }, 90000);
let rv; sock.on('error', (e) => { console.log('socket', e.message); end(1); });
sock.on('connect', () => send('version', p2p.buildVersion({ userAgent: '/btm-keystone/' })));
sock.on('data', (d) => { buf = Buffer.concat([buf, d]); const r = p2p.decodeStream(new Uint8Array(buf)); buf = buf.subarray(r.consumed);
  for (const m of r.messages) {
    if (m.command === 'version') { send('verack'); continue; }
    if (m.command === 'verack') { rv?.(); continue; }
    if (m.command === 'ping') { send('pong', { nonce: m.payload?.nonce ?? 0 }); continue; }
    if (m.command === 'block') { blocks.set(codec.blockHash(m.payload.header), m.payload); continue; }
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].cmd === m.command) { const w = waiters.splice(i, 1)[0]; clearTimeout(w.timer); w.res(m); }
  }
});
await new Promise((r) => { rv = r; });

// headers forward from the keystone tip
const hashes = []; let locator = meta.hash;
while (hashes.length < FORWARD) { send('getheaders', { version: 70016, blockLocator: [locator], hashStop: '0'.repeat(64) }); const hm = await want('headers'); const hs = (hm.payload?.entries ?? []).map((e) => codec.blockHash(e.header)); if (!hs.length) break; hashes.push(...hs); locator = hs[hs.length - 1]; }
const want2 = hashes.slice(0, FORWARD);
console.log(`validating ${want2.length} blocks forward from height ${meta.height + 1}…`);
for (let i = 0; i < want2.length; i += 30) { const batch = want2.slice(i, i + 30); send('getdata', { items: batch.map((h) => ({ type: MSG_BLOCK, hash: h })) }); const t0 = Date.now(); while (batch.some((h) => !blocks.has(h))) { if (Date.now() - t0 > 30000) throw new Error('batch timeout'); await new Promise((r) => setTimeout(r, 80)); } }
clearTimeout(guard);

let h = meta.height + 1, sigs = 0, sigFails = 0, structFails = 0, ctxFails = 0;
for (const hh of want2) {
  const block = blocks.get(hh);
  if (!be.validateBlockStructure(block).results.every((r) => r.ok !== false)) structFails++;
  if (!be.validateBlockContext(block, { height: h, utxo, mtp: null }).results.every((r) => r.ok !== false)) ctxFails++;
  for (let t = 1; t < block.transactions.length; t++) { const tx = block.transactions[t]; const prevs = tx.inputs.map((inp) => utxo.get(`${inp.prevout.txid}:${inp.prevout.vout}`)?.output); tx.inputs.forEach((inp, k) => { if (prevs[k]) { sigs++; if (interp.verifyInput(tx, k, prevs[k], prevs).ok !== true) sigFails++; } }); }
  be.applyBlock(utxo, block, h); h++;
}
console.log(`validated forward to height ${h - 1} · UTXO now ${utxo.size} · ${sigs} sigs (${sigFails} fails) · struct ${structFails} · ctx ${ctxFails}`);
const ok = want2.length > 100 && structFails === 0 && ctxFails === 0 && sigFails === 0;
console.log(ok ? `\n✅ assumeUTXO proven — loaded a validated keystone at ${meta.height} and validated ${want2.length} blocks forward against it, no genesis replay` : '\n❌ FAIL');
end(ok ? 0 : 1);
