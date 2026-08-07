# Vendored engines

Two builds of the Stockfish chess engine, compiled to WebAssembly:

- `sf17/` — Stockfish 17.1 (lite), built by Nathan Rugg.
  https://github.com/nmrugg/stockfish.js
- `stockfish.js`, `stockfish.wasm.js`, `stockfish.wasm` — Stockfish 10, built
  by Niklas Fiekas, kept as a fallback for browsers without WebAssembly SIMD.
  https://github.com/niklasf/stockfish.js

Neither is covered by this repository's MIT license. Both are licensed under
the GNU General Public License v3.

They are distributed here unmodified, as a separate aggregated work, so the
app can run offline and load the engine same-origin.
