// Seed an assumeUTXO snapshot over WebTorrent so browsers can swarm it (big
// snapshots don't belong on gh-pages). The infohash is content-addressed, so
// anyone seeding the same file produces the same magnet, and downloaders verify
// every piece against it. Run a persistent seeder on a desktop/server:
//   npm i webtorrent && node seed-snapshot.mjs data/snapshot-50000.json
// or just drop the file into the WebTorrent Desktop app. Paste the printed magnet
// into fullnode.html's keystone field.
import WebTorrent from 'webtorrent';

const FILE = process.argv[2] || 'data/snapshot-50000.json';
const TRACKERS = ['wss://tracker.openwebtorrent.com', 'wss://tracker.webtorrent.dev', 'wss://tracker.btorrent.xyz'];

const client = new WebTorrent();
client.on('error', (e) => console.error('webtorrent error:', e.message));
client.seed(FILE, { announce: TRACKERS }, (torrent) => {
  console.log('seeding   :', FILE);
  console.log('infohash  :', torrent.infoHash);
  console.log('magnet    :', torrent.magnetURI);
  console.log('\nkeep this running; paste the magnet into fullnode.html → keystone source.');
  setInterval(() => console.log(`  ${torrent.numPeers} peer(s) · uploaded ${(torrent.uploaded / 1e6).toFixed(1)} MB`), 30000);
});
