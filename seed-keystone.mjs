import WebTorrent from 'webtorrent';
const FILE = '/home/melvin/bitmark-bench/keystone-tip.json';
const trackers = ['wss://tracker.openwebtorrent.com', 'wss://tracker.webtorrent.dev', 'wss://tracker.btorrent.xyz'];
const client = new WebTorrent();
client.on('error', e => console.log('error', e.message));
client.seed(FILE, { name: 'btm-keystone-2403652.json', announce: trackers }, t => {
  console.log('SEEDING', FILE, '(' + (t.length/1e6).toFixed(0) + ' MB)');
  console.log('INFOHASH', t.infoHash);
  console.log('MAGNET', t.magnetURI);
});
