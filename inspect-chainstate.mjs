import { ClassicLevel } from 'classic-level';
import { cp, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Never open the live node DB read-write (classic-level has no read-only mode and
// would take the lock + rewrite files). Read a throwaway copy instead.
const DIR = process.env.CHAINSTATE || process.env.HOME + '/bitmark-bench/chainstate';
const tmp = await mkdtemp(join(tmpdir(), 'btm-ldb-'));
await cp(DIR, tmp, { recursive: true });
const db = new ClassicLevel(tmp, { keyEncoding: 'buffer', valueEncoding: 'buffer', createIfMissing: false });
await db.open();
let n = 0; const prefixCount = {}; let obf = null;
for await (const [k, v] of db.iterator()) {
  const p = k[0];
  prefixCount[p] = (prefixCount[p] || 0) + 1;
  // obfuscate key entry contains ascii "obfuscate_key"
  if (k.includes(Buffer.from('obfuscate_key'))) { obf = { key: k.toString('hex'), keyAscii: k.toString('latin1'), val: v.toString('hex') }; }
  if (n < 6) console.log('key', k.toString('hex').slice(0, 80), '| vlen', v.length, '| v', v.toString('hex').slice(0, 40));
  n++; if (n >= 200000) break;
}
console.log('\nobfuscate entry:', JSON.stringify(obf));
console.log('prefix counts (first 200k):', JSON.stringify(prefixCount));
console.log('  0x43=C(per-utxo)  0x63=c(per-tx)  0x42=B(bestblock)  0x0e/0x00=meta');
await db.close();
await rm(tmp, { recursive: true, force: true });
