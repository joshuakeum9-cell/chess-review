/* Copies the Stockfish build out of node_modules into vendor/ so the app runs
 * fully offline (and faster — the local copy is the WebAssembly build).
 * Run: npm run vendor
 */
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'stockfish.js');
const dest = join(root, 'vendor');

if (!existsSync(src)) {
  console.error('node_modules/stockfish.js not found. Run: npm install stockfish.js@10.0.2');
  process.exit(1);
}

mkdirSync(dest, { recursive: true });
for (const file of ['stockfish.js', 'stockfish.wasm.js', 'stockfish.wasm']) {
  const from = join(src, file);
  if (existsSync(from)) {
    copyFileSync(from, join(dest, file));
    console.log(`vendored ${file}`);
  }
}
console.log('Done. The app will now prefer the local WebAssembly engine.');
