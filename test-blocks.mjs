// Prove the FULL NODE (no Electrum): download real Bitmark blocks over P2P and
// replay them from genesis — CheckBlock structure, contextual rules (bip34, amounts,
// maturity, fees) via BlockEngine, full script/signature verification of every spend
// via ScriptInterpreter, and build our OWN UTXO set. This is the trust-nothing path
// the wallet will eventually read its balance from.
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { Codec } from './engine/codec/codec.js';
import { P2pEngine } from './engine/codec/p2p.js';
import { BlockEngine } from './engine/codec/blocks.js';
import { ScriptEngine } from './engine/codec/script.js';
import { ScriptInterpreter } from './engine/codec/interpreter.js';

const D = new URL('./', import.meta.url);
const jl = async (n) => JSON.parse(await readFile(new URL(`engine/schema/${n}.jsonld`, D), 'utf8'));
const core = await jl('core'), proof = await jl('proof'), p2pS = await jl('p2p'), chain = await jl('chain'), validate = await jl('validate'), script = await jl('script');
const codec = new Codec(core, proof, p2pS);
const p2p = P2pEngine.fromSchemas(codec, p2pS, chain, 'btm:mainnet');
const be = BlockEngine.fromSchemas(codec, chain, validate, script, 'btm:mainnet');
const se = ScriptEngine.fromSchemas(script, chain, 'btm:mainnet');
const interp = new ScriptInterpreter(codec, se);
const v = JSON.parse(await readFile(new URL('data/bitmark.json', D), 'utf8'));

const COUNT = parseInt(process.env.COUNT || '800', 10);
const MSG_BLOCK = 2;
const HOST = process.env.PEER_HOST || v.peers[0], PORT = v.port;
const sock = net.connect(PORT, HOST);
let buf = Buffer.alloc(0); const waiters = [];
const send = (c, p) => sock.write(Buffer.from(p2p.encodeMessage(c, p)));
const want = (cmd, ms = 30000) => new Promise((res, rej) => { const w = { cmd, res, rej, timer: setTimeout(() => rej(new Error('timeout ' + cmd)), ms) }; waiters.push(w); });
const blocks = new Map();   // hash → block
const end = (c) => { try { sock.destroy(); } catch {} process.exit(c); };
const guard = setTimeout(() => { console.log('❌ overall timeout'); end(1); }, 180000);
sock.on('error', (e) => { console.log('socket error', e.message); end(1); });
sock.on('connect', () => send('version', p2p.buildVersion({ userAgent: '/btm-fullnode/' })));
sock.on('data', (d) => { buf = Buffer.concat([buf, d]); const r = p2p.decodeStream(new Uint8Array(buf)); buf = buf.subarray(r.consumed);
  for (const m of r.messages) {
    if (m.command === 'version') { send('verack'); continue; }
    if (m.command === 'verack') { resolveVerack?.(); continue; }
    if (m.command === 'ping') { send('pong', { nonce: m.payload?.nonce ?? 0 }); continue; }
    if (m.command === 'block') { blocks.set(codec.blockHash(m.payload.header), m.payload); continue; }
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].cmd === m.command) { const w = waiters.splice(i, 1)[0]; clearTimeout(w.timer); w.res(m); }
  }
});

let resolveVerack;
await new Promise((r) => { resolveVerack = r; });
console.log('handshake ok ·', HOST);

// 1) collect block hashes from headers (genesis + the first COUNT)
send('getheaders', { version: 70016, blockLocator: [v.genesisHash], hashStop: '0'.repeat(64) });
const headersMsg = await want('headers');
const hashes = [v.genesisHash, ...headersMsg.payload.entries.map((e) => codec.blockHash(e.header)).slice(0, COUNT)];
console.log('fetching', hashes.length, 'blocks (genesis + first', COUNT + ')…');

// 2) download blocks in batches
for (let i = 0; i < hashes.length; i += 50) {
  const batch = hashes.slice(i, i + 50);
  send('getdata', { items: batch.map((h) => ({ type: MSG_BLOCK, hash: h })) });
  const t0 = Date.now();
  while (batch.some((h) => !blocks.has(h))) { if (Date.now() - t0 > 30000) throw new Error('block batch timeout'); await new Promise((r) => setTimeout(r, 100)); }
}
clearTimeout(guard);
console.log('downloaded', blocks.size, 'blocks · replaying + validating…');

// 3) replay from genesis: structure + context + script/sig + UTXO build
const utxo = new Map(); const times = [];
let structFails = 0, ctxFails = 0, sigChecked = 0, sigFails = 0, spendsBlocks = 0, maxTxs = 0;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
for (let h = 0; h < hashes.length; h++) {
  const block = blocks.get(hashes[h]); if (!block) throw new Error('missing block ' + h);
  maxTxs = Math.max(maxTxs, block.transactions.length);
  if (!be.validateBlockStructure(block).results.every((r) => r.ok !== false)) structFails++;
  const mtp = times.length >= 11 ? median(times.slice(-11)) : null;
  if (!be.validateBlockContext(block, { height: h, utxo, mtp }).results.every((r) => r.ok !== false)) ctxFails++;
  // full script/sig verification of every spend, against our own UTXO set
  for (let t = 1; t < block.transactions.length; t++) {
    const tx = block.transactions[t]; spendsBlocks++;
    const prevs = tx.inputs.map((inp) => utxo.get(`${inp.prevout.txid}:${inp.prevout.vout}`)?.output);
    tx.inputs.forEach((inp, k) => { const po = prevs[k]; if (!po) return; sigChecked++; if (interp.verifyInput(tx, k, po, prevs).ok !== true) sigFails++; });
  }
  be.applyBlock(utxo, block, h);
  times.push(block.header.time);
}

console.log(`replayed ${hashes.length} blocks · UTXO set ${utxo.size} coins · biggest block ${maxTxs} txs`);
console.log(`structure fails ${structFails} · context fails ${ctxFails} · scripts verified ${sigChecked} (fails ${sigFails}) over ${spendsBlocks} non-coinbase txs`);
const ok = structFails === 0 && ctxFails === 0 && sigFails === 0 && utxo.size > 0;
console.log(ok ? `\n✅ FULL NODE proven on Bitmark — ${hashes.length} real blocks fully validated (structure + context + every signature) and a self-built UTXO set, no Electrum` : '\n❌ FAIL');
end(ok ? 0 : 1);
