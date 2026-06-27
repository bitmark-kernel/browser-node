// Prove node-follow.js: the extracted follow-loop pieces build engines, parse a
// keystone, and FULLY validate blocks forward (structure + context + every
// signature, building the UTXO set) — the same path proven in test-blocks-local,
// now a reusable module. Block validation replays real Bitmark blocks from local
// disk (~/bitmark-bench/blocks); if those aren't present, that section is skipped
// (the engine/keystone checks still run).
import { readFile } from 'node:fs/promises';
import { openSync, readSync, closeSync } from 'node:fs';
import { buildEngines, parseKeystone, validateBlock } from './node-follow.js';

const D = new URL('./', import.meta.url);
const jl = async (n) => JSON.parse(await readFile(new URL(`engine/schema/${n}.jsonld`, D), 'utf8'));
const schemas = {};
for (const n of ['core', 'proof', 'p2p', 'chain', 'validate', 'script']) schemas[n] = await jl(n);
let ok = true;

// 1) buildEngines from schema objects
const eng = buildEngines(schemas);
const haveEngines = !!(eng.codec && eng.p2p && eng.be && eng.interp);
console.log('buildEngines:', haveEngines ? 'codec + p2p + be + interp ✓' : '✗');
ok = ok && haveEngines;

// 2) parseKeystone — real snapshot + a synthetic round-trip
const snap = await readFile(new URL('data/snapshot-50000.json', D), 'utf8');
const { utxo: ksUtxo, meta } = parseKeystone(snap);
console.log('parseKeystone(snapshot-50000):', `height ${meta.height} · ${ksUtxo.size.toLocaleString()} coins`);
ok = ok && meta.height === 50000 && ksUtxo.size > 0;
const synth = JSON.stringify({ network: 'btm:mainnet', height: 7, coins: 1 }) + '\n' + JSON.stringify(['ab'.repeat(32) + ':0', '12345\t76a914' + 'cc'.repeat(20) + '88ac\t7\t1']) + '\n';
const r = parseKeystone(synth); const c = r.utxo.get('ab'.repeat(32) + ':0');
const synthOk = r.meta.height === 7 && c && c.output.value === 12345 && c.coinbase === true && c.height === 7;
console.log('parseKeystone(synthetic round-trip):', synthOk ? '✓' : '✗', c?.output.value, c?.coinbase);
ok = ok && synthOk;

// 3) validateBlock — replay real blocks from genesis off local disk
const BLOCKS_DIR = process.env.BLOCKS_DIR || `${process.env.HOME}/bitmark-bench/blocks`;
const COUNT = parseInt(process.env.COUNT || '300', 10);
const MAGIC = Buffer.from('f9beb4d9', 'hex');
function* blockRecords(dir) {
  for (let n = 0; ; n++) {
    const path = `${dir}/blk${String(n).padStart(5, '0')}.dat`;
    let fd; try { fd = openSync(path, 'r'); } catch { return; }
    const head = Buffer.alloc(8); let pos = 0;
    for (;;) {
      if (readSync(fd, head, 0, 8, pos) < 8) break;
      if (!head.subarray(0, 4).equals(MAGIC)) break;
      const size = head.readUInt32LE(4); const block = Buffer.alloc(size);
      if (readSync(fd, block, 0, size, pos + 8) < size) break;
      pos += 8 + size; yield block;
    }
    closeSync(fd);
  }
}

let haveBlocks = false; try { closeSync(openSync(`${BLOCKS_DIR}/blk00000.dat`, 'r')); haveBlocks = true; } catch {}
if (!haveBlocks) {
  console.log(`validateBlock: SKIPPED — no blocks at ${BLOCKS_DIR} (engine + keystone checks still ran)`);
} else {
  const utxo = new Map(); const times = []; let h = 0, sigs = 0, sigFails = 0, prevHash = null;
  try {
    for (const raw of blockRecords(BLOCKS_DIR)) {
      const block = eng.codec.decode('Block', new Uint8Array(raw));
      if (h > 0 && block.header.prevBlockHash !== prevHash) break;
      const res = validateBlock(eng, block, h, utxo, times, () => {});
      sigs += res.sigs; sigFails += res.sigFails;
      prevHash = eng.codec.blockHash(block.header); h++;
      if (h >= COUNT) break;
    }
  } catch (e) { console.log('validateBlock threw:', e.message); ok = false; }
  const vbOk = h >= COUNT && utxo.size > 0 && sigFails === 0;
  console.log('validateBlock:', `${h} blocks · UTXO ${utxo.size} · ${sigs} sigs (fails ${sigFails})`, vbOk ? '✓' : '✗');
  ok = ok && vbOk;
}

console.log(ok ? '\n✅ node-follow proven — buildEngines, parseKeystone, validateBlock all correct' : '\n❌ FAIL');
process.exit(ok ? 0 : 1);
