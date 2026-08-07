/* Copies the Stockfish builds out of node_modules into vendor/ so the app runs
 * fully offline and same-origin.
 *
 * Two engines are vendored:
 *   vendor/sf16/  Stockfish 16 with NNUE, the one actually used. Needs the
 *                 38 MB network file alongside the wasm.
 *   vendor/       Stockfish 10, kept as a fallback for browsers without
 *                 WebAssembly SIMD.
 *
 * Run: npm run vendor
 */
import { mkdirSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function copyInto(srcDir, destDir, files) {
  if (!existsSync(srcDir)) return false;
  mkdirSync(destDir, { recursive: true });
  let copied = 0;
  for (const file of files) {
    const from = join(srcDir, file);
    if (existsSync(from)) {
      copyFileSync(from, join(destDir, file));
      console.log(`vendored ${file}`);
      copied++;
    }
  }
  return copied > 0;
}

// Stockfish 17.1 lite: single threaded, network baked into the wasm, so no
// SharedArrayBuffer and no separate 38 MB net file.
const sf17Src = join(root, 'node_modules', 'stockfish', 'src');
if (existsSync(sf17Src)) {
  const files = readdirSync(sf17Src).filter((f) => f.startsWith('stockfish-17.1-lite-single'));
  if (files.length) {
    copyInto(sf17Src, join(root, 'vendor', 'sf17'), files);
    const js = files.find((f) => f.endsWith('.js'));
    console.log(`\nIf the build hash changed, update the sf17 entry in js/engine.js to ${js}`);
  } else {
    console.error('no stockfish-17.1-lite-single files found');
  }
} else {
  console.error('node_modules/stockfish not found. Run: npm install stockfish@17.1.0');
}

// Stockfish 10 fallback.
const sf10Src = join(root, 'node_modules', 'stockfish.js');
if (!copyInto(sf10Src, join(root, 'vendor'), [
  'stockfish.js',
  'stockfish.wasm.js',
  'stockfish.wasm',
])) {
  console.error('node_modules/stockfish.js not found. Run: npm install stockfish.js@10.0.2');
}

console.log('\nDone.');
