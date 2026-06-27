// node-follow.js — the full-node follow loop, extracted from fullnode.html as a
// reusable, DOM-free module. Build engines from schemas, load a keystone, catch up
// to the peer's tip (download + fully validate every block, build the UTXO set),
// then follow new blocks as they arrive. Imported by fullnode.html and the wallet
// (so "From my node" can stay current). Node-proven in test-node-follow.mjs; the
// validation path is the same one proven in test-blocks-local / test-keystone.
import { Codec } from './engine/codec/codec.js';
import { P2pEngine } from './engine/codec/p2p.js';
import { BlockEngine } from './engine/codec/blocks.js';
import { ScriptEngine } from './engine/codec/script.js';
import { ScriptInterpreter } from './engine/codec/interpreter.js';
import { RtcPeer } from './peer-rtc.js';

const MSG_BLOCK = 2;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

// Build the consensus engines for a network from already-fetched schema objects
// ({ core, proof, p2p, chain, validate, script }). Returns { codec, p2p, be, interp }.
export function buildEngines(schemas, network = 'btm:mainnet') {
  const { core, proof, p2p, chain, validate, script } = schemas;
  const codec = new Codec(core, proof, p2p);
  return {
    codec,
    p2p: P2pEngine.fromSchemas(codec, p2p, chain, network),
    be: BlockEngine.fromSchemas(codec, chain, validate, script, network),
    interp: new ScriptInterpreter(codec, ScriptEngine.fromSchemas(script, chain, network)),
  };
}

// Parse a keystone/snapshot NDJSON (meta line + coin lines) into a UTXO Map + meta.
// Pure. The map values match what validateBlock/applyBlock expect.
export function parseKeystone(text) {
  const nl = text.indexOf('\n');
  const meta = JSON.parse(text.slice(0, nl));
  const utxo = new Map();
  let pos = nl + 1;
  while (pos < text.length) {
    let end = text.indexOf('\n', pos); if (end < 0) end = text.length;
    const line = text.slice(pos, end); pos = end + 1; if (!line) continue;
    const [k, val] = JSON.parse(line); const [s, spk, ht, cb] = val.split('\t');
    utxo.set(k, { output: { value: Number(s), scriptPubKey: spk }, height: Number(ht), coinbase: cb === '1' });
  }
  return { utxo, meta };
}

// Fully validate one block at `height` against `utxo` — structure, contextual rules
// (throws on either), then every signature (counted; the one historical checkpointed
// bad-sig block is tolerated via onAnomaly, not fatal) — and applyBlock. Mutates
// `utxo` and `times`. Returns { sigs, sigFails }.
export function validateBlock(eng, block, height, utxo, times, onAnomaly) {
  const { be, interp } = eng;
  if (!be.validateBlockStructure(block).results.every((r) => r.ok !== false)) throw new Error(`block at height ${height}: structure invalid`);
  const mtp = times.length >= 11 ? median(times.slice(-11)) : null;
  if (!be.validateBlockContext(block, { height, utxo, mtp }).results.every((r) => r.ok !== false)) throw new Error(`block at height ${height}: context invalid`);
  let sigs = 0, sigFails = 0;
  for (let t = 1; t < block.transactions.length; t++) {
    const tx = block.transactions[t];
    const prevs = tx.inputs.map((inp) => utxo.get(`${inp.prevout.txid}:${inp.prevout.vout}`)?.output);
    tx.inputs.forEach((inp, k) => { if (prevs[k]) { sigs++; if (interp.verifyInput(tx, k, prevs[k], prevs).ok !== true) { sigFails++; onAnomaly?.(height); } } });
  }
  be.applyBlock(utxo, block, height);
  times.push(block.header.time); if (times.length > 20) times.shift();
  return { sigs, sigFails };
}

// Connect to a Bitmark peer over WebRTC; returns the connected RtcPeer.
export async function connectPeer(eng, { signalUrl, room }) {
  const peer = new RtcPeer(eng.p2p, eng.codec);
  await peer.connect(signalUrl, { room });
  return peer;
}

// Download the blocks for a batch of hashes over P2P, in request order.
export async function downloadBatch(eng, peer, batch, timeoutMs = 60000) {
  const got = new Map();
  peer.send('getdata', { items: batch.map((hh) => ({ type: MSG_BLOCK, hash: hh })) });
  await peer.collect('block', batch.length, { onItem: (m) => got.set(eng.codec.blockHash(m.payload.header), m.payload), timeoutMs });
  return batch.map((hh) => { const b = got.get(hh); if (!b) throw new Error('missing block ' + hh.slice(0, 12)); return b; });
}

// Catch up from { ref.height (next to validate), ref.locator (last-validated hash) }
// to the peer's tip: getheaders forward, download + validateBlock + apply, batched.
// Stop early by setting state.running = false. Calls onProgress({ height, coins, sigs })
// per batch. Mutates `ref`, `utxo`, `times`. Returns { atTip, sigs, sigFails }.
export async function catchUp(eng, peer, { utxo, times, ref, state, onProgress, batchSize = 30 }) {
  let sigs = 0, sigFails = 0, atTip = false;
  const onAnomaly = () => { sigFails++; };
  while (state.running) {
    peer.send('getheaders', { version: 70016, blockLocator: [ref.locator], hashStop: '0'.repeat(64) });
    const hm = await peer.waitFor(['headers'], 30000);
    const hs = (hm.payload?.entries ?? []).map((e) => eng.codec.blockHash(e.header));
    if (!hs.length) { atTip = true; break; }
    for (let i = 0; i < hs.length && state.running; i += batchSize) {
      const batch = hs.slice(i, i + batchSize);
      const blocks = await downloadBatch(eng, peer, batch);
      for (const block of blocks) { const r = validateBlock(eng, block, ref.height, utxo, times, onAnomaly); sigs += r.sigs; ref.height++; }
      ref.locator = batch[batch.length - 1];
      onProgress?.({ height: ref.height - 1, coins: utxo.size, sigs });
      await new Promise((r) => setTimeout(r, 0));   // yield to the UI
    }
  }
  return { atTip, sigs, sigFails };
}

// Follow the tip: poll for new blocks from ref.locator, validateBlock + apply, stay
// current. Runs until state.running = false. Calls onBlocks({ height, coins, added })
// when new blocks apply, onError(e) on a (non-fatal) poll error. Mutates `ref`.
export async function followTip(eng, peer, { utxo, times, ref, state, onBlocks, onError, pollMs = 15000 }) {
  const poll = async () => {
    if (!state.running) return;
    try {
      peer.send('getheaders', { version: 70016, blockLocator: [ref.locator], hashStop: '0'.repeat(64) });
      const hm = await peer.waitFor(['headers'], 30000);
      const hs = (hm.payload?.entries ?? []).map((e) => eng.codec.blockHash(e.header));
      if (hs.length) {
        const blocks = await downloadBatch(eng, peer, hs);
        for (const block of blocks) { validateBlock(eng, block, ref.height, utxo, times); ref.height++; }
        ref.locator = hs[hs.length - 1];
        onBlocks?.({ height: ref.height - 1, coins: utxo.size, added: hs.length });
      }
    } catch (e) { onError?.(e); }
    if (state.running) setTimeout(poll, pollMs);
  };
  await poll();
}

// Persist the UTXO set to OPFS as one NDJSON file (meta line + coin lines, the same
// format parseKeystone reads) so the wallet can read balance from this node. Writes
// in ~1 MB chunks. Browser-only (no-op without OPFS). Caller decides how often.
export async function persistUtxo(utxo, height, network = 'btm:mainnet') {
  if (!navigator?.storage?.getDirectory) return false;
  const root = await navigator.storage.getDirectory();
  const w = await (await root.getFileHandle('btm-utxo.json', { create: true })).createWritable();
  await w.write(JSON.stringify({ network, height, coins: utxo.size }) + '\n');
  let buf = '';
  for (const [k, c] of utxo) {
    buf += JSON.stringify([k, `${c.output.value}\t${c.output.scriptPubKey}\t${c.height || 0}\t${c.coinbase ? 1 : 0}`]) + '\n';
    if (buf.length > (1 << 20)) { await w.write(buf); buf = ''; }
  }
  if (buf) await w.write(buf);
  await w.close();
  return true;
}

// Fetch a keystone over WebTorrent (infohash content-addresses the data → verified
// in transit). onProg(msg) gets human-readable progress. Browser-only. Returns text.
export async function loadViaWebTorrent(magnet, onProg = () => {}) {
  let WebTorrent;
  try { ({ default: WebTorrent } = await import('https://cdn.jsdelivr.net/npm/webtorrent@2.8.5/dist/webtorrent.min.js')); }
  catch (e1) { try { ({ default: WebTorrent } = await import('https://esm.sh/webtorrent@2.8.5')); } catch { throw new Error('WebTorrent failed to load: ' + e1.message); } }
  return new Promise((resolve, reject) => {
    const client = new WebTorrent();
    client.on('error', (e) => reject(new Error('webtorrent: ' + e.message)));
    let stall; const arm = (ms, msg) => { clearTimeout(stall); stall = setTimeout(() => { try { client.destroy(); } catch {} reject(new Error(msg)); }, ms); };
    arm(70000, 'no data in 70s — no seeder reachable?');
    client.add(magnet, (torrent) => {
      onProg(`swarm: ${torrent.name} (${(torrent.length / 1e6).toFixed(1)} MB)`);
      torrent.on('download', () => { arm(70000, 'download stalled (no data for 70s)'); onProg(`${(100 * torrent.progress).toFixed(1)}% · ${(torrent.downloaded / 1e6).toFixed(0)}/${(torrent.length / 1e6).toFixed(0)} MB · ${(torrent.downloadSpeed / 1e6).toFixed(2)} MB/s · ${torrent.numPeers} peer(s)`); });
      const file = torrent.files[0];
      const done = (buf) => { clearTimeout(stall); resolve(new TextDecoder().decode(buf)); client.destroy(() => {}); };
      if (file.arrayBuffer) file.arrayBuffer().then((b) => done(new Uint8Array(b))).catch(reject);
      else file.getBuffer((err, b) => err ? reject(err) : done(b));
    });
  });
}
