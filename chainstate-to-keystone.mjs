// Read Bitmark's chainstate (LevelDB, legacy per-tx CCoins format, no obfuscation)
// and emit a browser keystone: one line per UTXO, "txid:vout \t value\tspk\theight\tcb".
// This is the assumeUTXO set at the node's tip — exported without dumptxoutset (this
// build lacks it). VERIFY=1 just counts + sums (checks against gettxoutsetinfo);
// otherwise writes OUT. Run: node --max-old-space-size=8192 chainstate-to-keystone.mjs
import { ClassicLevel } from 'classic-level';
import { createWriteStream } from 'node:fs';
import { cp, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Open a node LevelDB WITHOUT touching it: classic-level has no real read-only mode —
// opening the live dir takes the lock and can rewrite/compact sstables, which can
// corrupt a node database. So copy the dir to a throwaway temp and open the COPY.
// (Stop bitmarkd before running anyway, so the copy is a consistent snapshot.)
async function openReadOnly(dir) {
  const tmp = await mkdtemp(join(tmpdir(), 'btm-ldb-'));
  await cp(dir, tmp, { recursive: true });
  const db = new ClassicLevel(tmp, { keyEncoding: 'buffer', valueEncoding: 'buffer', createIfMissing: false });
  await db.open();
  return { db, cleanup: async () => { try { await db.close(); } catch {} await rm(tmp, { recursive: true, force: true }); } };
}

const DIR = process.env.CHAINSTATE || process.env.HOME + '/bitmark-bench/chainstate';
const OUT = process.env.OUT || process.env.HOME + '/bitmark-bench/keystone-tip.json';
const VERIFY = !!process.env.VERIFY;
// keystone meta (from gettxoutsetinfo): height + best block hash (display order)
const HEIGHT = Number(process.env.HEIGHT || 2403652);
const BESTHASH = process.env.BESTHASH || '773f3df42ac0fc4a3ab6ccc8ecb7a8bcc868ddb883e9b8399f7a01710b57cf74';

const P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
function modpow(b, e, m) { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = r * b % m; e >>= 1n; b = b * b % m; } return r; }
function uncompressPub(nSize, xBuf) { // nSize 4|5 → even|odd y
  const x = BigInt('0x' + xBuf.toString('hex'));
  let y = modpow((x * x % P * x % P + 7n) % P, (P + 1n) / 4n, P);
  const wantOdd = nSize === 5;
  if ((y & 1n) !== (wantOdd ? 1n : 0n)) y = P - y;
  return '04' + xBuf.toString('hex') + y.toString(16).padStart(64, '0');
}
function readVarInt(buf, o) { let n = 0n; for (;;) { const ch = buf[o++]; n = (n << 7n) | BigInt(ch & 0x7f); if (ch & 0x80) n += 1n; else return [n, o]; } }
function decompressAmount(x) { x = Number(x); if (x === 0) return 0; x--; let e = x % 10; x = Math.floor(x / 10); let n; if (e < 9) { const d = (x % 9) + 1; x = Math.floor(x / 9); n = x * 10 + d; } else { n = x + 1; } while (e-- > 0) n *= 10; return n; }
function decompressScript(buf, o) {
  let nSize; [nSize, o] = readVarInt(buf, o); nSize = Number(nSize);
  if (nSize === 0) return ['76a914' + buf.slice(o, o + 20).toString('hex') + '88ac', o + 20];
  if (nSize === 1) return ['a914' + buf.slice(o, o + 20).toString('hex') + '87', o + 20];
  if (nSize === 2 || nSize === 3) return ['21' + (nSize === 2 ? '02' : '03') + buf.slice(o, o + 32).toString('hex') + 'ac', o + 32];
  if (nSize === 4 || nSize === 5) return ['41' + uncompressPub(nSize, buf.slice(o, o + 32)) + 'ac', o + 32];
  const len = nSize - 6; return [buf.slice(o, o + len).toString('hex'), o + len];
}
function decodeCoins(buf) {
  let o = 0, v;
  [v, o] = readVarInt(buf, o);                    // version (unused)
  let code; [code, o] = readVarInt(buf, o); code = Number(code);
  const coinbase = code & 1;
  const vAvail = [(code & 2) !== 0, (code & 4) !== 0];
  let nMaskCode = (code >> 3) + ((code & 6) ? 0 : 1);
  while (nMaskCode > 0) { const ch = buf[o++]; for (let p = 0; p < 8; p++) vAvail.push((ch & (1 << p)) !== 0); if (ch !== 0) nMaskCode--; }
  const outs = [];
  for (let i = 0; i < vAvail.length; i++) if (vAvail[i]) { let amt; [amt, o] = readVarInt(buf, o); const amount = decompressAmount(amt); let spk; [spk, o] = decompressScript(buf, o); outs.push([i, amount, spk]); }
  let height; [height, o] = readVarInt(buf, o); height = Number(height);
  return { coinbase, height, outs };
}

const { db, cleanup } = await openReadOnly(DIR);   // read a COPY — never the live DB
let txs = 0, coins = 0, total = 0, kinds = {};
const out = VERIFY ? null : createWriteStream(OUT);
if (out) out.write(JSON.stringify({ network: 'btm:mainnet', height: HEIGHT, hash: BESTHASH, coins: 794548 }) + '\n');
const t0 = Date.now();
for await (const [k, val] of db.iterator()) {
  if (k[0] !== 0x63) continue;                    // only 'c' coin records
  const txidDisplay = Buffer.from(k.slice(1, 33)).reverse().toString('hex');
  let dec; try { dec = decodeCoins(val); } catch (e) { console.log('decode fail', txidDisplay, e.message); continue; }
  txs++;
  for (const [vout, amount, spk] of dec.outs) {
    coins++; total += amount;
    const kind = spk.startsWith('76a914') ? 'p2pkh' : spk.startsWith('a914') ? 'p2sh' : spk.endsWith('ac') ? 'p2pk' : 'other';
    kinds[kind] = (kinds[kind] || 0) + 1;
    if (out) out.write(JSON.stringify([`${txidDisplay}:${vout}`, `${amount}\t${spk}\t${dec.height}\t${dec.coinbase ? 1 : 0}`]) + '\n');
  }
  if (txs % 100000 === 0) console.log(`  ${txs} txs · ${coins} coins · ${Math.round(txs / ((Date.now() - t0) / 1000))} tx/s`);
}
if (out) await new Promise((r) => out.end(r));
await cleanup();   // close + delete the temp copy
console.log(`\ntxs ${txs} · coins ${coins} · total ${(total / 1e8).toFixed(8)} BTM · kinds ${JSON.stringify(kinds)}`);
console.log('expected: coins 794548 · total 21093089.79041634 BTM');
const ok = coins === 794548 && Math.abs(total / 1e8 - 21093089.79041634) < 0.001;
console.log(ok ? `\n✅ chainstate parsed CORRECTLY — keystone ${VERIFY ? '(verify only)' : 'written to ' + OUT}` : '\n❌ MISMATCH — format wrong');
process.exit(ok ? 0 : 1);
