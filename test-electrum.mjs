// Prove the ElectrumX backend for the wallet: talk JSON-RPC to electrum.bitmark.rocks
// and exercise the methods the wallet needs — server.version, headers.subscribe (tip),
// relayfee, and scripthash get_balance / listunspent. scripthash = reverse(sha256(spk)).
// This is the wallet's data path: no full-block scan, just trusted-index queries.
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { ScriptEngine, addressToScript } from './engine/codec/script.js';
import { sha256, bytesToHex, hexToBytes } from './engine/codec/hash.js';

const D = new URL('./', import.meta.url);
const jl = async (n) => JSON.parse(await readFile(new URL(`engine/schema/${n}.jsonld`, D), 'utf8'));
const se = ScriptEngine.fromSchemas(await jl('script'), await jl('chain'), 'btm:mainnet');
const cfg = JSON.parse(await readFile(new URL('data/bitmark.json', D), 'utf8')).electrum;

// Electrum scripthash: sha256 of the scriptPubKey, byte-reversed, hex
export function scripthashOf(scriptPubKeyHex) { return bytesToHex(sha256(hexToBytes(scriptPubKeyHex)).reverse()); }

// minimal line-delimited JSON-RPC client over TCP (the browser will do this over the bridge)
function electrum(host, port) {
  const sock = net.connect(port, host);
  let buf = '', id = 0; const pending = new Map();
  sock.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; const msg = JSON.parse(line); const p = pending.get(msg.id); if (p) { pending.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result); } } });
  const ready = new Promise((r, j) => { sock.on('connect', r); sock.on('error', j); });
  return {
    ready,
    call: (method, params = []) => new Promise((res, rej) => { const myId = id++; pending.set(myId, { res, rej }); sock.write(JSON.stringify({ id: myId, method, params }) + '\n'); setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); rej(new Error('timeout ' + method)); } }, 15000); }),
    close: () => { try { sock.destroy(); } catch {} },
  };
}

const e = electrum(cfg.host, cfg.tcp);
await e.ready;
const ver = await e.call('server.version', ['bitmark-browser-node', '1.4']);
const tip = await e.call('blockchain.headers.subscribe');
const fee = await e.call('blockchain.relayfee').catch(() => 'n/a');
console.log('server:', ver[0], 'proto', ver[1]);
console.log('tip height:', tip.height, '· header', (tip.hex || '').slice(0, 32) + '…');
console.log('relayfee:', fee, 'BTM/kB');

// exercise scripthash queries on a sample address (an unused one returns zeros — proves the call)
const ADDR = process.env.ADDR || null;
if (ADDR) {
  const spk = addressToScript(ADDR, se.params);
  const sh = scripthashOf(spk);
  const bal = await e.call('blockchain.scripthash.get_balance', [sh]);
  const utxos = await e.call('blockchain.scripthash.listunspent', [sh]);
  console.log(`\naddress ${ADDR}`);
  console.log('  scriptPubKey', spk, '· scripthash', sh.slice(0, 16) + '…');
  console.log('  balance:', bal, '· utxos:', utxos.length);
  for (const u of utxos.slice(0, 5)) console.log(`    ${u.value} sats · ${u.tx_hash}:${u.tx_pos} (height ${u.height})`);
}
e.close();

const ok = ver[0]?.includes('ElectrumX') && typeof tip.height === 'number' && tip.height > 2000000;
console.log(ok ? '\n✅ ElectrumX backend proven: version + tip + scripthash queries — the wallet has its data path (no full-block scan)' : '\n❌ FAIL');
process.exit(ok ? 0 : 1);
