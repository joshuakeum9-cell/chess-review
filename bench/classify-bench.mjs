/* Benchmark the classifier against Lichess's own judgments on real games.
 *
 * Lichess marks a ply Inaccuracy / Mistake / Blunder using its own analysis.
 * We run our whole pipeline over the same games and compare. Perfect
 * agreement is not the goal, and would in fact be suspicious: Lichess uses
 * fixed centipawn bands on a different engine at a different depth. What
 * matters is that we agree on which moves are errors and roughly how bad,
 * and that we do not invent errors that are not there.
 *
 * Reports the confusion between the two, plus false-positive rates for the
 * categories most prone to them.
 *
 * Run: node bench/classify-bench.mjs [depth]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeEngine } from './engine-node.mjs';
import { parsePgn } from '../js/chess.js';
import { analysePositions, buildReport } from '../js/review.js';

const here = dirname(fileURLToPath(import.meta.url));
const depth = Number(process.argv[2]) || 12;
const games = JSON.parse(readFileSync(join(here, 'data', 'games.json'), 'utf8'));

/* Adapter: the review pipeline expects the browser's EnginePool interface. */
class SinglePool {
  constructor(engine) {
    this.engines = [engine];
    this.engine = engine;
  }
  async analyseAll(jobs, { depth: d, multipv, onResult }) {
    const out = new Array(jobs.length).fill(null);
    let done = 0;
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      done++;
      if (!job) continue;
      out[i] = await this.engine.analyse(job.fen, {
        depth: d,
        multipv: job.multipv || multipv,
        searchmoves: job.searchmoves || null,
      });
      if (onResult) onResult(i, out[i], done);
    }
    return out;
  }
}

const engine = await new NodeEngine('sf17lite').init({ hash: 128 });
engine.send('setoption name UCI_ShowWDL value true');
engine.send('isready');
await engine.expect('readyok');
const pool = new SinglePool(engine);

const LICHESS_TO_OURS = {
  Inaccuracy: 'inaccuracy',
  Mistake: 'mistake',
  Blunder: 'blunder',
};
const SEVERITY = { inaccuracy: 1, mistake: 2, blunder: 3, miss: 3 };

const confusion = {};
let bothFlagged = 0;
let onlyLichess = 0;
let onlyOurs = 0;
let agreeExact = 0;
let agreeWithin1 = 0;
let cleanBoth = 0;
const counts = {};
let totalPlies = 0;
const plies = [];
const accuracies = [];

for (const [gi, g] of games.entries()) {
  process.stdout.write(`\r[${gi + 1}/${games.length}] ${g.id} (${g.label})            `);
  let parsed;
  try {
    parsed = parsePgn(g.pgn);
  } catch {
    continue;
  }
  if (!parsed.moves.length) continue;

  await engine.newGame();
  const positions = await analysePositions(parsed, pool, { depth, multipv: 3 });
  if (positions.length < parsed.moves.length + 1) continue;
  const report = buildReport(parsed, positions);
  accuracies.push({
    id: g.id,
    label: g.label,
    white: +report.stats.w.accuracy.toFixed(1),
    black: +report.stats.b.accuracy.toFixed(1),
    whiteElo: g.whiteElo,
    blackElo: g.blackElo,
    plies: report.moves.length,
  });

  for (let i = 0; i < report.moves.length && i < g.analysis.length; i++) {
    const m = report.moves[i];
    const ours = m.classification;
    counts[ours] = (counts[ours] || 0) + 1;
    totalPlies++;

    const lj = g.analysis[i] && g.analysis[i].judgment;
    const theirs = lj ? LICHESS_TO_OURS[lj.name] : null;

    // Everything a threshold sweep needs, so tuning does not require
    // re-running the engine over every game.
    plies.push({
      game: g.id,
      ply: i,
      ours,
      theirs,
      loss: m.loss,
      expectedBefore: m.expectedBefore,
      expectedAfter: m.expectedAfter,
      volatility: m.volatility,
      playedBest: m.playedBest,
      viable: m.viable,
      alternativeCost: m.alternativeCost,
      decided: m.decided,
      sacrificed: m.sacrificed,
      isBook: ours === 'book',
      legalCount: positions[i].legalCount,
      phase: m.phase,
      cpBefore: m.evalBeforeWhite,
      cpAfter: m.evalAfterWhite,
    });

    const key = `${theirs || 'none'} -> ${ours}`;
    confusion[key] = (confusion[key] || 0) + 1;

    const oursSev = SEVERITY[ours] || 0;
    const theirsSev = theirs ? SEVERITY[theirs] : 0;

    if (theirs && oursSev) {
      bothFlagged++;
      if (theirs === ours) agreeExact++;
      if (Math.abs(oursSev - theirsSev) <= 1) agreeWithin1++;
    } else if (theirs && !oursSev) onlyLichess++;
    else if (!theirs && oursSev) onlyOurs++;
    else cleanBoth++;
  }
}

process.stdout.write('\r' + ' '.repeat(70) + '\r');

const flaggedByLichess = bothFlagged + onlyLichess;
const flaggedByUs = bothFlagged + onlyOurs;

console.log(`=== classifier vs Lichess (depth ${depth}, ${games.length} games, ${totalPlies} plies) ===\n`);
console.log(`Lichess flagged an error on   ${flaggedByLichess} plies`);
console.log(`We flagged an error on        ${flaggedByUs} plies`);
console.log(`Both flagged the same ply     ${bothFlagged}`);
console.log(`  exact category match        ${agreeExact} (${pct(agreeExact, bothFlagged)})`);
console.log(`  within one severity step    ${agreeWithin1} (${pct(agreeWithin1, bothFlagged)})`);
console.log(`Missed by us (Lichess only)   ${onlyLichess} (${pct(onlyLichess, flaggedByLichess)} of theirs)`);
console.log(`Extra errors we invented      ${onlyOurs} (${pct(onlyOurs, flaggedByUs)} of ours)`);
console.log(`Both agree the move is fine   ${cleanBoth}`);

console.log('\nRecall  (errors of theirs we caught):  ' + pct(bothFlagged, flaggedByLichess));
console.log('Precision (our errors that are real): ' + pct(bothFlagged, flaggedByUs));

console.log('\n=== our label distribution ===');
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`${k.padEnd(12)} ${String(v).padStart(5)}  ${pct(v, totalPlies)}`);
}

console.log('\n=== where we differ (lichess -> ours), top 12 ===');
for (const [k, v] of Object.entries(confusion)
  .filter(([k]) => {
    const [l, o] = k.split(' -> ');
    return l !== 'none' || SEVERITY[o];
  })
  .sort((a, b) => b[1] - a[1])
  .slice(0, 12)) {
  console.log(`${k.padEnd(28)} ${v}`);
}

const allAcc = accuracies.flatMap((a) => [a.white, a.black]).sort((a, b) => a - b);
if (allAcc.length) {
  const mean = allAcc.reduce((a, b) => a + b, 0) / allAcc.length;
  const median = allAcc[Math.floor(allAcc.length / 2)];
  console.log('\n=== accuracy over these games (strong players, expect 80-95) ===');
  console.log(
    `mean ${mean.toFixed(1)}  median ${median.toFixed(1)}  ` +
      `min ${allAcc[0].toFixed(1)}  max ${allAcc[allAcc.length - 1].toFixed(1)}`
  );
  const below70 = allAcc.filter((a) => a < 70).length;
  console.log(`scores under 70: ${below70} of ${allAcc.length}`);
  for (const a of accuracies) {
    console.log(
      `  ${a.id.padEnd(10)} ${String(a.plies).padStart(3)} plies  ` +
        `W ${String(a.white).padStart(5)} (${a.whiteElo ?? '?'})  B ${String(a.black).padStart(5)} (${a.blackElo ?? '?'})`
    );
  }
}

writeFileSync(join(here, 'data', `acc-d${depth}.json`), JSON.stringify(accuracies, null, 1));
writeFileSync(join(here, 'data', `plies-d${depth}.json`), JSON.stringify(plies));
console.log(`\nwrote bench/data/plies-d${depth}.json (${plies.length} plies) for threshold tuning`);

function pct(a, b) {
  return b ? `${((a / b) * 100).toFixed(1)}%` : 'n/a';
}

engine.quit();
process.exit(0);
