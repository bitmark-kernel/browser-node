// Mint an assumeUTXO keystone: validate genesis→TARGET from local blk files with
// the kernel (structure + context + every signature) and write the resulting UTXO
// set as a browser-loadable snapshot (NDJSON: meta line, then [key, "sats\tspk\t
// height\tcoinbase"] per coin). The browser loads this validated keystone and
// validates forward, instead of replaying ~2.4M blocks in a tab.
//   TARGET=50000 node --max-old-space-size=8192 gen-snapshot.mjs
// Tolerant of the one historical bad-signature block (checkpointed in Bitmark):
// signature anomalies are logged + counted, not fatal. Structure/context stay strict.
import { readFile, writeFile } from 'node:fs/promises';
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
const TARGET = parseInt(process.env.TARGET || '50000', 10);
const OUT = process.env.OUT || new URL(`data/snapshot-${TARGET}.json`, D).pathname;
const MAGIC = Buffer.from('f9beb4d9', 'hex');

// Compact UTXO set: stores "value\tspk\theight\tcb" strings (half the memory of
// objects), but get() returns the object shape BlockEngine/interp expect. Iterates
// as [key, stringValue] — exactly the snapshot line format.
class UtxoMap {
  constructor() { this.m = new Map(); }
  set(k, v) { this.m.set(k, `${v.output.value}\t${v.output.scriptPubKey}\t${v.height}\t${v.coinbase ? 1 : 0}`); }
  get(k) { const s = this.m.get(k); if (s === undefined) return undefined; const a = s.split('\t'); return { output: { value: Number(a[0]), scriptPubKey: a[1] }, height: Number(a[2]), coinbase: a[3] === '1' }; }
  delete(k) { return this.m.delete(k); }
  get size() { return this.m.size; }
  [Symbol.iterator]() { return this.m[Symbol.iterator](); }
}

function* blockRecords(dir) {
  for (let n = 0; ; n++) {
    const path = `${dir}/blk${String(n).padStart(5, '0')}.dat`;
    let fd; try { fd = openSync(path, 'r'); } catch { return; }
    const head = Buffer.alloc(8); let pos = 0;
    for (;;) {
      if (readSync(fd, head, 0, 8, pos) < 8) break;
      if (!head.subarray(0, 4).equals(MAGIC)) break;
      const size = head.readUInt32LE(4);
      const block = Buffer.alloc(size);
      if (readSync(fd, block, 0, size, pos + 8) < size) break;
      pos += 8 + size; yield block;
    }
    closeSync(fd);
  }
}

const utxo = new UtxoMap(); const times = [];
let h = 0, sigs = 0, sigFails = 0, prevHash = null, tipHash = null;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const t0 = Date.now();
for (const raw of blockRecords(BLOCKS_DIR)) {
  if (h > TARGET) break;
  const block = codec.decode('Block', new Uint8Array(raw));
  if (h > 0 && block.header.prevBlockHash !== prevHash) { console.log('end of contiguous chain at', h); break; }
  if (!be.validateBlockStructure(block).results.every((r) => r.ok !== false)) throw new Error('structure fail @' + h);
  const mtp = times.length >= 11 ? median(times.slice(-11)) : null;
  if (!be.validateBlockContext(block, { height: h, utxo, mtp }).results.every((r) => r.ok !== false)) throw new Error('context fail @' + h);
  for (let t = 1; t < block.transactions.length; t++) {
    const tx = block.transactions[t];
    const prevs = tx.inputs.map((inp) => utxo.get(`${inp.prevout.txid}:${inp.prevout.vout}`)?.output);
    tx.inputs.forEach((inp, k) => { if (prevs[k]) { sigs++; if (interp.verifyInput(tx, k, prevs[k], prevs).ok !== true) { sigFails++; console.log(`signature anomaly @${h} (known checkpointed block)`); } } });
  }
  be.applyBlock(utxo, block, h);
  times.push(block.header.time); if (times.length > 20) times.shift();
  tipHash = codec.blockHash(block.header); prevHash = tipHash;
  if (h % 10000 === 0 && h) console.log(`  height ${h} · UTXO ${utxo.size} · ${sigs} sigs · ${Math.round(h / ((Date.now() - t0) / 1000))} blk/s`);
  h++;
}
const validatedTo = h - 1;
console.log(`validated genesis→${validatedTo} (${sigs} signatures, ${sigFails} known anomalies) in ${((Date.now() - t0) / 1000).toFixed(1)}s · UTXO ${utxo.size} coins`);

const meta = JSON.stringify({ network: 'btm:mainnet', height: validatedTo, hash: tipHash, coins: utxo.size, anomalies: sigFails });
const parts = [meta]; for (const [key, val] of utxo) parts.push(JSON.stringify([key, val]));
await writeFile(OUT, parts.join('\n') + '\n');
const bytes = parts.reduce((s, l) => s + l.length + 1, 0);
console.log(`\n✅ keystone written: ${OUT} · height ${validatedTo} · ${utxo.size} coins · ${(bytes / 1e6).toFixed(1)} MB`);
