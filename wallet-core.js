// wallet-core.js — the Bitmark wallet's orchestration as pure, DOM-free functions.
// Engine pieces (ScriptEngine `se`, Codec, ScriptInterpreter) are injected, so this
// is testable in node and reusable by any UI (the clean app, a desktop/mobile shell,
// another coin). No DOM, no I/O — the UI does Electrum/OPFS/P2P and calls these.
// Node-proven in test-wallet-core.mjs; the logic is the same already proven in
// test-keys / test-sign / test-sign-multi.
import { deriveSigningKey, signEcdsa, toDer } from './wasm-keygen.js';
import { hash160, bytesToHex } from './engine/codec/hash.js';

const pushData = (hex) => (hex.length / 2).toString(16).padStart(2, '0') + hex;   // script push for data < 76 bytes

// Derive the first `gap` receiving (0/i) and change (1/i) legacy P2PKH addresses.
// Returns entries (each with its private key) + a scriptPubKey→entry map for matching.
export function deriveWallet(seed, se, { purpose = 44, coin = 177, gap = 20 } = {}) {
  const entries = [], byScript = new Map();
  for (const change of [0, 1]) for (let i = 0; i < gap; i++) {
    const key = deriveSigningKey(seed, { purpose, coin, change, index: i });
    const spk = '76a914' + bytesToHex(hash160(key.pub)) + '88ac';
    const e = { path: `${change}/${i}`, address: se.classify(spk).address, spk, key, change, index: i };
    entries.push(e); byScript.set(spk, e);
  }
  return { entries, byScript };
}

// Match a list of coins [{txid,vout,value,spk}] (from Electrum or the node's UTXO
// set) against the wallet → the wallet's spendable UTXOs + total balance (sats).
export function matchUtxos(coins, byScript) {
  const utxos = []; let balance = 0;
  for (const c of coins) {
    const e = byScript.get(c.spk);
    if (e) { utxos.push({ txid: c.txid, vout: c.vout, value: c.value, spk: c.spk, address: e.address, key: e.key }); balance += c.value; }
  }
  return { utxos, balance };
}

// Largest-first coin selection to cover `need` (amount + fee).
export function selectCoins(utxos, need) {
  const chosen = []; let sum = 0;
  for (const u of [...utxos].sort((a, b) => b.value - a.value)) { chosen.push(u); sum += u.value; if (sum >= need) break; }
  return { chosen, sum };
}

// Build + sign a legacy P2PKH tx over `chosen` inputs paying `outputs`. Signs each
// input with its own key over the legacy sighash, then verifies every input under
// the engine before returning. Returns { tx, rawHex, txid }.
export function buildSpend({ chosen, outputs, codec, interp }) {
  const tx = {
    version: 1, lockTime: 0,
    inputs: chosen.map((u) => ({ prevout: { txid: u.txid, vout: u.vout }, scriptSig: '', sequence: 0xffffffff })),
    outputs,
  };
  chosen.forEach((u, i) => {
    const sh = interp.sighashLegacy(tx, i, u.spk, 0x01);
    tx.inputs[i].scriptSig = pushData(bytesToHex(toDer(signEcdsa(sh, u.key.priv))) + '01') + pushData(bytesToHex(u.key.pub));
  });
  const prevouts = chosen.map((u) => ({ scriptPubKey: u.spk, value: u.value }));
  chosen.forEach((_, i) => { const r = interp.verifyInput(tx, i, prevouts[i], prevouts); if (r.ok !== true) throw new Error(`engine rejected input ${i}: ${JSON.stringify(r)}`); });
  return { tx, rawHex: codec.encodeHex('Transaction', tx), txid: codec.txid(tx) };
}

// Plan a spend end-to-end: select coins to cover amount+fee, add change to
// `changeSpk` (unless dust), build + sign + verify. Returns { tx, rawHex, txid,
// chosen, change }. Throws on insufficient funds.
export function planSpend({ utxos, destScript, amount, fee, changeSpk, codec, interp, dust = 1000 }) {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('amount must be a positive integer (sats)');
  if (!Number.isInteger(fee) || fee < 0) throw new Error('fee must be a non-negative integer (sats)');
  const need = amount + fee;
  const { chosen, sum } = selectCoins(utxos, need);
  if (sum < need) throw new Error(`insufficient funds: have ${sum} sats, need ${need} (amount + fee)`);
  const change = sum - need;
  const outputs = [{ value: amount, scriptPubKey: destScript }];
  if (change >= dust) outputs.push({ value: change, scriptPubKey: changeSpk });
  return { ...buildSpend({ chosen, outputs, codec, interp }), chosen, change };
}
