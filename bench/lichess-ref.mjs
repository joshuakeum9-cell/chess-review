/* Independent reference: Lichess cloud evaluations.
 *
 * Grading Stockfish against a deeper Stockfish of the same family flatters
 * whichever build shares the reference's evaluation function. Lichess cloud
 * evals come from their own deep analysis on real hardware, so they are an
 * outside opinion. Coverage is limited to positions someone has already
 * analysed, which is why this is a cross-check rather than the main harness.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUITE } from './positions.mjs';

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, 'data'), { recursive: true });

const out = [];
let hits = 0;

for (const pos of SUITE) {
  const url = `https://lichess.org/api/cloud-eval?fen=${encodeURIComponent(pos.fen)}&multiPv=1`;
  try {
    const res = await fetch(url);
    if (res.status === 404) {
      out.push({ ...pos, cloud: null });
      process.stdout.write('.');
    } else if (res.ok) {
      const j = await res.json();
      const pv = j.pvs && j.pvs[0];
      out.push({
        ...pos,
        cloud: pv
          ? { cp: pv.cp ?? null, mate: pv.mate ?? null, best: pv.moves.split(' ')[0], depth: j.depth }
          : null,
      });
      if (pv) hits++;
      process.stdout.write('#');
    } else {
      out.push({ ...pos, cloud: null });
      process.stdout.write('?');
    }
  } catch {
    out.push({ ...pos, cloud: null });
    process.stdout.write('!');
  }
  await new Promise((r) => setTimeout(r, 250)); // be polite to the API
}

process.stdout.write('\n');
writeFileSync(join(here, 'data', 'lichess-ref.json'), JSON.stringify(out, null, 1));
console.log(`cloud evals found for ${hits} / ${SUITE.length} positions`);
