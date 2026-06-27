// Prove wallet-core.js: the extracted orchestration produces the right addresses,
// matches UTXOs, selects coins, and builds a spend the engine accepts — same
// behaviour as the inline wallet.html logic, now a reusable module.
import { readFile } from 'node:fs/promises';
import { Codec } from './engine/codec/codec.js';
import { ScriptEngine, addressToScript } from './engine/codec/script.js';
import { ScriptInterpreter } from './engine/codec/interpreter.js';
import { mnemonicToSeed } from './wasm-keygen.js';
import { deriveWallet, matchUtxos, selectCoins, planSpend } from './wallet-core.js';

const D = new URL('./', import.meta.url);
const jl = async (n) => JSON.parse(await readFile(new URL(`engine/schema/${n}.jsonld`, D), 'utf8'));
const codec = new Codec(await jl('core'), await jl('proof'), await jl('p2p'));
const se = ScriptEngine.fromSchemas(await jl('script'), await jl('chain'), 'btm:mainnet');
const interp = new ScriptInterpreter(codec, se);
let ok = true;

const seed = await mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', '');
const { entries, byScript } = deriveWallet(seed, se);
console.log('deriveWallet: 40 entries:', entries.length === 40, '· 0/0', entries[0].address, '· legacy b…:', entries[0].address.startsWith('b'));
ok = ok && entries.length === 40 && entries[0].address.startsWith('b') && byScript.size === 40;

// matchUtxos: a coin paying 0/2 + a foreign coin → only ours matches
const mine = entries.find((e) => e.path === '0/2');
const coins = [
  { txid: 'aa'.repeat(32), vout: 0, value: 300000, spk: mine.spk },
  { txid: 'bb'.repeat(32), vout: 1, value: 999, spk: '76a914' + 'cc'.repeat(20) + '88ac' },   // not ours
  { txid: 'aa'.repeat(32), vout: 1, value: 250000, spk: entries[0].spk },                     // 0/0
];
const { utxos, balance } = matchUtxos(coins, byScript);
console.log('matchUtxos:', utxos.length, 'mine ·', balance, 'sats (expect 2 · 550000)');
ok = ok && utxos.length === 2 && balance === 550000;

// selectCoins: cover 400000 → should pick the 300000 + 250000 (largest-first)
const { chosen, sum } = selectCoins(utxos, 400000);
console.log('selectCoins(400000):', chosen.length, 'inputs ·', sum, 'sats');
ok = ok && sum >= 400000;

// planSpend: send 500000, fee 200, change back to 0/0 — builds + verifies under the engine
const dest = se.classify('76a914' + 'dd'.repeat(20) + '88ac').address;
const plan = planSpend({ utxos, destScript: addressToScript(dest, se.params), amount: 500000, fee: 200, changeSpk: entries[0].spk, codec, interp });
console.log('planSpend: txid', plan.txid.slice(0, 16) + '…', '·', plan.chosen.length, 'in ·', plan.tx.outputs.length, 'out · change', plan.change);
ok = ok && plan.txid.length === 64 && plan.tx.outputs.length === 2 && plan.change === 550000 - 500000 - 200;

// insufficient funds throws
let threw = false; try { planSpend({ utxos, destScript: addressToScript(dest, se.params), amount: 9_000_000, fee: 200, changeSpk: entries[0].spk, codec, interp }); } catch { threw = true; }
console.log('insufficient-funds guard:', threw ? '✓' : '✗');
ok = ok && threw;

console.log(ok ? '\n✅ wallet-core proven — derive, match, select, plan+sign (engine-verified) all correct' : '\n❌ FAIL');
process.exit(ok ? 0 : 1);
