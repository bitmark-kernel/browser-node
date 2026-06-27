// Prove the wallet's P2P broadcast path against a REAL Bitmark peer: build a signed
// legacy P2PKH tx and run the actual broadcast.js (broadcastTx) over a raw-TCP peer
// adapter shaped like RtcPeer. The browser does the same over the bridge. The tx
// spends a non-existent UTXO (no funds in CI), so the honest result is: the peer
// requests it (getdata), then rejects (notfound) — proving transport + accept/reject
// on Bitmark. A funded tx returns accepted.
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { Codec } from './engine/codec/codec.js';
import { P2pEngine } from './engine/codec/p2p.js';
import { ScriptEngine } from './engine/codec/script.js';
import { ScriptInterpreter } from './engine/codec/interpreter.js';
import { hash160, bytesToHex } from './engine/codec/hash.js';
import { mnemonicToSeed, deriveSigningKey, signEcdsa, toDer } from './wasm-keygen.js';
import { broadcastTx } from './broadcast.js';

const D = new URL('./', import.meta.url);
const jl = async (n) => JSON.parse(await readFile(new URL(`engine/schema/${n}.jsonld`, D), 'utf8'));
const codec = new Codec(await jl('core'), await jl('proof'), await jl('p2p'));
const p2p = P2pEngine.fromSchemas(codec, await jl('p2p'), await jl('chain'), 'btm:mainnet');
const se = ScriptEngine.fromSchemas(await jl('script'), await jl('chain'), 'btm:mainnet');
const interp = new ScriptInterpreter(codec, se);
const v = JSON.parse(await readFile(new URL('data/bitmark.json', D), 'utf8'));
const push = (h) => (h.length / 2).toString(16).padStart(2, '0') + h;

// a signed (unfunded) legacy P2PKH tx — the wallet.html path
const seed = await mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', '');
const key = deriveSigningKey(seed, { purpose: 44, coin: 177, change: 0, index: 0 });
const spk = '76a914' + bytesToHex(hash160(key.pub)) + '88ac';
const AMOUNT = 100000;
const tx = { version: 1, lockTime: 0, inputs: [{ prevout: { txid: 'ab'.repeat(32), vout: 0 }, scriptSig: '', sequence: 0xffffffff }], outputs: [{ value: AMOUNT - 10000, scriptPubKey: spk }] };
const sh = interp.sighashLegacy(tx, 0, spk, 0x01);
tx.inputs[0].scriptSig = push(bytesToHex(toDer(signEcdsa(sh, key.priv))) + '01') + push(bytesToHex(key.pub));
console.log('signed legacy tx', codec.txid(tx).slice(0, 16) + '…', '(' + codec.txSize(tx) + ' bytes)');

const HOST = process.env.PEER_HOST || v.peers[0], PORT = v.port;
const sock = net.connect(PORT, HOST);
let buf = Buffer.alloc(0); const waiters = [];
const drop = (w) => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); };
const peer = {
  send: (cmd, payload) => sock.write(Buffer.from(p2p.encodeMessage(cmd, payload))),
  waitFor: (commands, ms = 15000) => new Promise((res, rej) => { const w = { commands, res, rej, timer: setTimeout(() => { drop(w); rej(new Error('timeout ' + commands)); }, ms) }; waiters.push(w); }),
  close: () => { try { sock.destroy(); } catch {} },
};
const end = (c) => { try { sock.destroy(); } catch {} process.exit(c); };
const guard = setTimeout(() => { console.log('\n❌ overall timeout'); end(1); }, 60000);
let rv; sock.on('error', (e) => { console.log('socket error:', e.message); end(1); });
sock.on('connect', () => peer.send('version', p2p.buildVersion({ userAgent: '/btm-broadcast/' })));
sock.on('data', (d) => { buf = Buffer.concat([buf, d]); const r = p2p.decodeStream(new Uint8Array(buf)); buf = buf.subarray(r.consumed);
  for (const m of r.messages) {
    if (m.command === 'version') { peer.send('verack'); continue; }
    if (m.command === 'verack') { rv?.(); continue; }
    if (m.command === 'ping') { peer.send('pong', { nonce: m.payload?.nonce ?? 0 }); continue; }
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].commands.includes(m.command)) { const w = waiters.splice(i, 1)[0]; clearTimeout(w.timer); w.res(m); break; }
  }
});
await new Promise((r) => { rv = r; });
console.log('handshake ok ·', HOST);
const result = await broadcastTx(peer, tx, codec);
clearTimeout(guard);
console.log('broadcast result:', JSON.stringify(result));
const ok = result.requested === true;
if (ok && result.accepted) console.log('\n✅ P2P broadcast PROVEN on Bitmark — peer accepted the tx');
else if (ok) console.log('\n✅ P2P broadcast transport PROVEN on Bitmark — peer requested via getdata then rejected the unfunded tx (' + result.detail + '). A funded tx is accepted.');
else console.log('\n❌ peer did not request the tx');
end(ok ? 0 : 1);
