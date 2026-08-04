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

// Stockfish 16 NNUE, single threaded (no SharedArrayBuffer needed).
const sf16Src = join(root, 'node_modules', 'stockfish', 'src');
if (existsSync(sf16Src)) {
  const net = readdirSync(sf16Src).find((f) => f.endsWith('.nnue'));
  copyInto(sf16Src, join(root, 'vendor', 'sf16'), [
    'stockfish-nnue-16-single.js',
    'stockfish-nnue-16-single.wasm',
    net,
  ]);
  if (net && net !== 'nn-5af11540bbfe.nnue') {
    console.warn(
      `\nNetwork file is ${net}, but js/engine.js asks for nn-5af11540bbfe.nnue.\n` +
        `Update the EvalFile option in engine.js to match.`
    );
  }
} else {
  console.error('node_modules/stockfish not found. Run: npm install stockfish@16.0.0');
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
