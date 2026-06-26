// ElectrumX client over a WebRTC data channel. A browser tab can't open raw TCP to
// an Electrum server, so it connects to a byte-pipe bridge (bridge-webrtc.mjs with
// PEER_HOST=electrum.bitmark.rocks PEER_PORT=50001) in a signaling room, and speaks
// Electrum's line-delimited JSON-RPC over the channel. The bridge is pure transport
// — it can't forge a reply (and we re-verify everything that matters against keys we
// hold). Browser-only (WebSocket + RTCPeerConnection); the protocol is node-proven
// in test-electrum.mjs.
import { sha256, bytesToHex, hexToBytes } from './engine/codec/hash.js';

// Electrum scripthash: sha256(scriptPubKey) byte-reversed, hex.
export function scripthashOf(scriptPubKeyHex) { return bytesToHex(sha256(hexToBytes(scriptPubKeyHex)).reverse()); }

export class ElectrumClient {
  constructor() { this.buf = ''; this.id = 0; this.pending = new Map(); this.closed = false; }

  async connect(signalUrl, { room, connectTimeout = 20000, iceServers = [{ urls: 'stun:stun.l.google.com:19302' }] } = {}) {
    await this.#establish(signalUrl, room, iceServers, connectTimeout);
    return this;
  }

  #establish(signalUrl, room, iceServers, timeout) {
    return new Promise((resolve, reject) => {
      const ws = this.ws = new WebSocket(signalUrl);
      const pc = this.pc = new RTCPeerConnection({ iceServers });
      const dc = this.dc = pc.createDataChannel('electrum');
      dc.binaryType = 'arraybuffer';
      const offerId = 'o' + Math.random().toString(36).slice(2);
      let settled = false, offerSdp = null, timer = null;
      const stop = () => { clearTimeout(to); clearInterval(timer); };
      const to = setTimeout(() => { if (!settled) { settled = true; stop(); this.#fail(new Error('rtc connect timeout')); reject(new Error('rtc connect timeout')); } }, timeout);
      const announce = () => { if (offerSdp && ws.readyState === 1) ws.send(JSON.stringify({ type: 'announce', resource: room, offers: [{ sdp: offerSdp, offer_id: offerId }] })); };

      dc.onopen = () => { if (settled) return; settled = true; stop(); resolve(); };
      dc.onmessage = (ev) => this.#onData(ev.data);
      dc.onclose = () => this.#fail(new Error('bridge closed'));
      pc.oniceconnectionstatechange = () => { if (['failed', 'disconnected', 'closed'].includes(pc.iceConnectionState)) { if (!settled) { settled = true; stop(); reject(new Error('ice ' + pc.iceConnectionState)); } this.#fail(new Error('ice ' + pc.iceConnectionState)); } };

      ws.onopen = announce;
      ws.onmessage = async (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'answer' && m.resource === room && m.offer_id === offerId && m.sdp && !pc.currentRemoteDescription) {
          try { await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }); } catch { /* stale */ }
        }
      };
      ws.onerror = () => { if (!settled) { settled = true; stop(); reject(new Error('signaling error')); } };

      (async () => {
        await pc.setLocalDescription(await pc.createOffer());
        await this.#iceComplete(pc);
        offerSdp = pc.localDescription.sdp;
        announce();
        timer = setInterval(announce, 2500);
      })().catch((e) => { if (!settled) { settled = true; stop(); reject(e); } });
    });
  }

  #iceComplete(pc) {
    return new Promise((res) => {
      if (pc.iceGatheringState === 'complete') return res();
      const check = () => { if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', check); res(); } };
      pc.addEventListener('icegatheringstatechange', check);
    });
  }

  #onData(data) {
    this.buf += typeof data === 'string' ? data : new TextDecoder().decode(new Uint8Array(data));
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      const p = this.pending.get(msg.id);
      if (p) { this.pending.delete(msg.id); msg.error ? p.rej(new Error(typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error))) : p.res(msg.result); }
    }
  }

  call(method, params = [], timeoutMs = 20000) {
    return new Promise((res, rej) => {
      if (this.closed || this.dc?.readyState !== 'open') return rej(new Error('not connected'));
      const myId = this.id++;
      this.pending.set(myId, { res, rej });
      this.dc.send(JSON.stringify({ id: myId, method, params }) + '\n');
      setTimeout(() => { if (this.pending.has(myId)) { this.pending.delete(myId); rej(new Error('timeout ' + method)); } }, timeoutMs);
    });
  }

  // --- the wallet's queries (by scriptPubKey hex) ---
  version() { return this.call('server.version', ['bitmark-browser-node', '1.4']); }
  tip() { return this.call('blockchain.headers.subscribe'); }
  relayfee() { return this.call('blockchain.relayfee'); }
  getBalance(spk) { return this.call('blockchain.scripthash.get_balance', [scripthashOf(spk)]); }
  listUnspent(spk) { return this.call('blockchain.scripthash.listunspent', [scripthashOf(spk)]); }
  getHistory(spk) { return this.call('blockchain.scripthash.get_history', [scripthashOf(spk)]); }
  getTx(txid, verbose = false) { return this.call('blockchain.transaction.get', [txid, verbose]); }
  broadcast(rawHex) { return this.call('blockchain.transaction.broadcast', [rawHex]); }

  #fail(err) { if (this.closed) return; this.closed = true; for (const p of this.pending.values()) p.rej(err); this.pending.clear(); }
  close() { this.closed = true; try { this.dc?.close(); } catch {} try { this.pc?.close(); } catch {} try { this.ws?.close(); } catch {} }
}
