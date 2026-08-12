/* Tune the classification thresholds against Lichess's judgments.
 *
 * Reads the per-ply dump produced by classify-bench.mjs and sweeps the
 * error-band boundaries, scoring each combination by how well it reproduces
 * Lichess's calls. Optimising against a held-out opinion beats picking round
 * numbers, which is what the thresholds were before.
 *
 * The objective balances three things: catching the errors Lichess caught
 * (recall), not inventing errors it did not (precision), and landing in the
 * same band when we both flag a move (exact agreement). Precision is weighted
 * a little higher because a false blunder is more corrosive to trust than a
 * missed inaccuracy.
 *
 * Run: node bench/tune.mjs [depth]
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const depth = Number(process.argv[2]) || 14;
const plies = JSON.parse(readFileSync(join(here, 'data', `plies-d${depth}.json`), 'utf8'));

const SEVERITY = { inaccuracy: 1, mistake: 2, blunder: 3, miss: 3 };

/* Re-label a ply from its stored measurements under candidate thresholds.
 * Mirrors classifyMove's error ladder; the non-error branches are untouched
 * because Lichess never disagrees about those. */
function label(p, t) {
  if (p.legalCount === 1) return 'forced';
  if (p.isBook) return 'book';
  if (p.playedBest) return 'best';
  if (p.decided) return p.loss < t.good ? 'excellent' : 'good';

  const wasWinning = p.expectedBefore >= 85;
  const stillWinning = p.expectedAfter >= 85;
  if (wasWinning && !stillWinning && p.loss >= t.good) return 'miss';

  if (p.loss < t.excellent) return 'excellent';
  if (p.loss < t.good) return 'good';
  if (p.loss < t.inaccuracy) return 'inaccuracy';
  if (p.loss < t.mistake) return 'mistake';
  return 'blunder';
}

function score(t) {
  let both = 0;
  let onlyUs = 0;
  let onlyThem = 0;
  let exact = 0;

  for (const p of plies) {
    const ours = label(p, t);
    const oursSev = SEVERITY[ours] || 0;
    const theirsSev = p.theirs ? SEVERITY[p.theirs] : 0;
    if (oursSev && theirsSev) {
      both++;
      if (ours === p.theirs) exact++;
    } else if (oursSev) onlyUs++;
    else if (theirsSev) onlyThem++;
  }

  const recall = both / (both + onlyThem || 1);
  const precision = both / (both + onlyUs || 1);
  const agreement = exact / (both || 1);
  const f1 = (2 * recall * precision) / (recall + precision || 1);
  return { recall, precision, agreement, f1, both, onlyUs, onlyThem, exact,
    objective: 0.45 * precision + 0.35 * recall + 0.20 * agreement };
}

const grid = [];
for (const excellent of [1, 1.5, 2, 3]) {
  for (const good of [3, 4, 5, 6, 8]) {
    for (const inaccuracy of [8, 10, 12, 15, 18]) {
      for (const mistake of [18, 20, 25, 30, 35]) {
        if (excellent >= good || good >= inaccuracy || inaccuracy >= mistake) continue;
        grid.push({ excellent, good, inaccuracy, mistake });
      }
    }
  }
}

const scored = grid
  .map((t) => ({ t, s: score(t) }))
  .sort((a, b) => b.s.objective - a.s.objective);

// Keep in sync with LOSS in js/classify.js, or the baseline row lies.
const current = { excellent: 2, good: 6, inaccuracy: 12, mistake: 18 };
const cur = score(current);

console.log(`tuning on ${plies.length} plies at depth ${depth}\n`);
console.log('current thresholds  ' + JSON.stringify(current));
console.log(
  `  recall ${p(cur.recall)}  precision ${p(cur.precision)}  exact ${p(cur.agreement)}  F1 ${p(cur.f1)}\n`
);

console.log('best combinations:');
console.log('exc  good  inacc  mist |  recall  precis   exact      F1   objective');
for (const { t, s } of scored.slice(0, 10)) {
  console.log(
    `${String(t.excellent).padStart(3)}${String(t.good).padStart(6)}${String(t.inaccuracy).padStart(7)}${String(t.mistake).padStart(6)} |` +
      `${p(s.recall).padStart(8)}${p(s.precision).padStart(8)}${p(s.agreement).padStart(8)}${p(s.f1).padStart(8)}` +
      `${s.objective.toFixed(4).padStart(12)}`
  );
}

const best = scored[0];
console.log('\nrecommended: ' + JSON.stringify(best.t));
console.log(
  `  recall ${p(best.s.recall)} (was ${p(cur.recall)}), ` +
    `precision ${p(best.s.precision)} (was ${p(cur.precision)}), ` +
    `exact ${p(best.s.agreement)} (was ${p(cur.agreement)})`
);

function p(x) {
  return `${(x * 100).toFixed(1)}%`;
}
