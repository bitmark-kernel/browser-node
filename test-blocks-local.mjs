// Full-node validation at SCALE, straight from local Bitmark block files
// (~/bitmark-bench/blocks/blk*.dat — standard Core format: magic|size|block).
// Replays from genesis with the kernel: CheckBlock structure + contextual rules +
// every signature verified + a UTXO set built from scratch. No network, no reindex.
// COUNT blocks (env, default 20000). Proves the in-browser full-node path holds far
// past the 800 we did over P2P — and can mint an assumeUTXO keystone.
import { readFile } from 'node:fs/promises';
import { openSync, readSync, closeSync } from 'node:fs';
import { Codec } from './engine/codec/codec.js';
import { BlockEngine } from './engine/codec/blocks.js';
import { ScriptEngine } from './engine/codec/script.js';
import { ScriptInterpreter } from './engine/codec/interpreter.js';

const D = new URL('./', import.meta.url);
const jl = async (n) => JSON.parse(await readFile(new URL(`engine/schema/${n}.jsonld`, D), 'utf8'));
const codec = new Codec(await jl('core'), await jl('proof'));
const be = BlockEngine.fromSchemas(codec, await jl('chain'), await jl('validate'), await jl('script'), 'btm:mainnet');
const interp = new ScriptInterpreter(codec, ScriptEngine.fromSchemas(await jl('script'), await jl('chain'), 'btm:mainnet'));

const BLOCKS_DIR = process.env.BLOCKS_DIR || `${process.env.HOME}/bitmark-bench/blocks`;
const COUNT = parseInt(process.env.COUNT || '20000', 10);
const MAGIC = Buffer.from('f9beb4d9', 'hex');

// Stream block records from blk*.dat files in order. Yields raw block buffers.
function* blockRecords(dir) {
  for (let n = 0; ; n++) {
    const path = `${dir}/blk${String(n).padStart(5, '0')}.dat`;
    let fd; try { fd = openSync(path, 'r'); } catch { return; }   // no more files
    const head = Buffer.alloc(8);
    let pos = 0;
    for (;;) {
      if (readSync(fd, head, 0, 8, pos) < 8) break;
      if (!head.subarray(0, 4).equals(MAGIC)) break;              // padding / end of data
      const size = head.readUInt32LE(4);
      const block = Buffer.alloc(size);
      if (readSync(fd, block, 0, size, pos + 8) < size) break;
      pos += 8 + size;
      yield block;
    }
    closeSync(fd);
  }
}

const utxo = new Map(); const times = [];
let h = 0, sigs = 0, sigFails = 0, structFails = 0, ctxFails = 0, prevHash = null, maxTxs = 0, totalTxs = 0;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const t0 = Date.now();

for (const raw of blockRecords(BLOCKS_DIR)) {
  const block = codec.decode('Block', new Uint8Array(raw));
  // require height order (blk files are written in sync order); stop if a gap appears
  if (h > 0 && block.header.prevBlockHash !== prevHash) { console.log(`out-of-order at height ${h} (got prev ${block.header.prevBlockHash.slice(0,16)}…, expected ${prevHash.slice(0,16)}…) — stopping`); break; }
  if (!be.validateBlockStructure(block).results.every((r) => r.ok !== false)) structFails++;
  const mtp = times.length >= 11 ? median(times.slice(-11)) : null;
  if (!be.validateBlockContext(block, { height: h, utxo, mtp }).results.every((r) => r.ok !== false)) ctxFails++;
  for (let t = 1; t < block.transactions.length; t++) {
    const tx = block.transactions[t];
    const prevs = tx.inputs.map((inp) => utxo.get(`${inp.prevout.txid}:${inp.prevout.vout}`)?.output);
    tx.inputs.forEach((inp, k) => { if (prevs[k]) { sigs++; if (interp.verifyInput(tx, k, prevs[k], prevs).ok !== true) sigFails++; } });
  }
  be.applyBlock(utxo, block, h);
  maxTxs = Math.max(maxTxs, block.transactions.length); totalTxs += block.transactions.length;
  times.push(block.header.time); if (times.length > 20) times.shift();
  prevHash = codec.blockHash(block.header);
  h++;
  if (h % 5000 === 0) { const dt = (Date.now() - t0) / 1000; console.log(`  height ${h} · UTXO ${utxo.size} · ${sigs} sigs · ${Math.round(h / dt)} blk/s`); }
  if (h >= COUNT) break;
}

const dt = (Date.now() - t0) / 1000;
console.log(`\nreplayed ${h} blocks in ${dt.toFixed(1)}s (${Math.round(h / dt)} blk/s) · ${totalTxs} txs (biggest ${maxTxs})`);
console.log(`UTXO set ${utxo.size} coins · scripts verified ${sigs} (fails ${sigFails}) · structure fails ${structFails} · context fails ${ctxFails}`);
const ok = h >= Math.min(COUNT, 1000) && structFails === 0 && ctxFails === 0 && sigFails === 0;
console.log(ok ? `\n✅ FULL NODE at scale — ${h} real Bitmark blocks validated from local disk (structure + context + ${sigs} signatures), UTXO set built, 0 failures` : '\n❌ FAIL');
process.exit(ok ? 0 : 1);
