// Prove the Bitmark foundation: the bundled genesis header bytes decode and hash
// (SHA256d, the block-identity hash) to Bitmark's consensus genesis, and the
// btm:mainnet network params load. This is the smallest fact the whole node rests
// on — get the genesis + params right and everything else is built on solid ground.
import { readFile } from 'node:fs/promises';
import { Codec } from './engine/codec/codec.js';
import { ScriptEngine } from './engine/codec/script.js';

const D = new URL('./', import.meta.url);
const jl = async (n) => JSON.parse(await readFile(new URL(`engine/schema/${n}.jsonld`, D), 'utf8'));
const codec = new Codec(await jl('core'), await jl('proof'), await jl('p2p'));
const se = ScriptEngine.fromSchemas(await jl('script'), await jl('chain'), 'btm:mainnet');
const v = JSON.parse(await readFile(new URL('data/bitmark.json', D), 'utf8'));

const header = codec.decode('BlockHeader', v.genesisHeader);
const hash = codec.blockHash(header);
console.log('btm:mainnet params:', `magic ${se.params.magic} · port ${se.params.port} · p2pkh v${se.params.p2pkhVersion} · halving ${se.params.halvingInterval}`);
console.log('genesis header:', JSON.stringify(header));
console.log('computed hash:', hash);
console.log('consensus hash:', v.genesisHash);

let ok = hash === v.genesisHash && se.params.magic === 'f9beb4d9' && se.params.p2pkhVersion === 85;
// the genesis coinbase pays a P2PK output (20 BTM); merkleRoot must match the header
ok = ok && header.merkleRoot === 'd4715adf41222fae3d4bf41af30c675bc27228233d0f3cfd4ae0ae1d3e760ba8';
console.log(ok ? '\n✅ Bitmark foundation verified — genesis hashes correctly (SHA256d identity), btm:mainnet params load' : '\n❌ FAIL');
process.exit(ok ? 0 : 1);
