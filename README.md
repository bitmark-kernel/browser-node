# bitmark-kernel / browser-node

A **Bitmark (BTM) node + wallet that runs in a browser tab** — the
[`bitcoin-kernel/browser-node`](https://github.com/bitcoin-kernel/browser-node)
stack pointed at a **live coin**. Same consensus engine, validated against Bitmark's
chain parameters; the wallet is backed by an **ElectrumX** server so it needs no
full-block scan.

Live: https://bitmark-kernel.github.io/browser-node/

## Why Bitmark

It's a small, old, live Bitcoin-derived coin — a real network to exercise the
in-browser node and wallet end-to-end (real funds, real broadcast) without the
risks of mainnet BTC. Its blocks are nearly empty, so even at ~2.4M blocks the
UTXO set is tiny (chainstate ~97 MB).

## What's reused vs. Bitmark-specific

- **Reused unchanged:** the whole `engine/` (codec, p2p, script + `sighashLegacy`,
  interpreter, headers, spv), the WebRTC↔TCP bridge, signaling, WASM secp.
- **Bitmark-specific:** `btm:mainnet` in `engine/schema/chain.jsonld`
  (magic `f9beb4d9`, port `9265`, P2PKH v85, P2SH v5, 2-min blocks, halving 788000),
  `data/bitmark.json` (genesis + peers + Electrum), an ElectrumX client, and a
  **legacy P2PKH** wallet (no SegWit on Bitmark).

## Cut corners (honest)

- **Multi-algo PoW** (scrypt/sha256d/yescrypt/…): the block-identity hash is SHA256d
  (validated), but PoW *difficulty* is not checked — delegated, as the reference
  bitmark-kernel does. `multiAlgoPow: true`.
- Wallet UTXO/balance/broadcast go through ElectrumX (trusted index) rather than a
  from-scratch chain scan.

## Proofs (node, no browser)

- `test-genesis.mjs` — genesis header hashes to the consensus genesis; params load.

Generated with [Claude Code](https://claude.com/claude-code).
