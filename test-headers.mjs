// Prove the node/validation path: fetch real Bitmark headers from a live peer and
// validate them with the kernel's HeaderEngine — linkage + structure, with PoW
// difficulty delegated (multiAlgoPow). This is what node.html does in the tab.
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { Codec } from './engine/codec/codec.js';
import { P2pEngine } from './engine/codec/p2p.js';
import { HeaderEngine } from './engine/codec/headers.js';

const D = new URL('./', import.meta.url);
const jl = async (n) => JSON.parse(await readFile(new URL(`engine/schema/${n}.jsonld`, D), 'utf8'));
const codec = new Codec(await jl('core'), await jl('proof'), await jl('p2p'));
const p2p = P2pEngine.fromSchemas(codec, await jl('p2p'), await jl('chain'), 'btm:mainnet');
const he = HeaderEngine.fromSchemas(codec, await jl('chain'), await jl('validate'), 'btm:mainnet');
const v = JSON.parse(await readFile(new URL('data/bitmark.json', D), 'utf8'));
const genesis = codec.decode('BlockHeader', v.genesisHeader);

const HOST = process.env.PEER_HOST || v.peers[0], PORT = v.port;
const sock = net.connect(PORT, HOST);
let buf = Buffer.alloc(0); const waiters = [];
const send = (c, p) => sock.write(Buffer.from(p2p.encodeMessage(c, p)));
const want = (cmd, ms = 30000) => new Promise((res, rej) => { const w = { cmd, res, rej, timer: setTimeout(() => rej(new Error('timeout ' + cmd)), ms) }; waiters.push(w); });
const end = (c) => { try { sock.destroy(); } catch {} process.exit(c); };
const guard = setTimeout(() => { console.log('❌ timeout'); end(1); }, 45000);
sock.on('error', (e) => { console.log('socket error', e.message); end(1); });
sock.on('connect', () => send('version', p2p.buildVersion({ userAgent: '/btm-headers/' })));
sock.on('data', (d) => { buf = Buffer.concat([buf, d]); const r = p2p.decodeStream(new Uint8Array(buf)); buf = buf.subarray(r.consumed);
  for (const m of r.messages) {
    if (m.command === 'version') { send('verack'); continue; }
    if (m.command === 'verack') { console.log('handshake ok'); send('getheaders', { version: 70016, blockLocator: [v.genesisHash], hashStop: '0'.repeat(64) }); continue; }
    if (m.command === 'ping') { send('pong', { nonce: m.payload?.nonce ?? 0 }); continue; }
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].cmd === m.command) { const w = waiters.splice(i, 1)[0]; clearTimeout(w.timer); w.res(m); }
  }
});

const msg = await want('headers');
const headers = (msg.payload?.entries ?? []).map((e) => e.header);
clearTimeout(guard);
console.log('fetched', headers.length, 'real Bitmark headers from', HOST);

// validate the batch against the kernel, with genesis as prevContext
const rows = he.validateChain(headers, { startHeight: 1, prevContext: [genesis], now: Math.floor(Date.now() / 1000) + 7200 });
const okCount = rows.filter((r) => r.ok).length;
// linkage spot-check: header[0] must point at genesis; header[k] at header[k-1]
let linked = headers[0].prevBlockHash === codec.blockHash(genesis);
for (let i = 1; i < headers.length; i++) if (headers[i].prevBlockHash !== codec.blockHash(headers[i - 1])) linked = false;
const firstFail = rows.find((r) => !r.ok);
console.log('validated:', okCount, '/', headers.length, '· linkage', linked ? '✓' : '✗');
if (firstFail) console.log('  a failing rule:', JSON.stringify(firstFail.results.filter((x) => x.ok === false)));
console.log('  height 1 hash:', codec.blockHash(headers[0]));

const ok = headers.length > 100 && okCount === headers.length && linked;
console.log(ok ? `\n✅ node/validation proven — ${okCount} real Bitmark headers validated by the kernel (linkage + structure; difficulty delegated)` : '\n❌ FAIL');
end(ok ? 0 : 1);
