/* Which expected-score scale should the classifier measure loss on?
 *
 * Three candidates: the engine's win/draw/loss expectation, the fitted
 * centipawn curve, or the average of the two. Each is scored on how well it
 * reproduces Lichess's judgments over real games, and on its own threshold
 * sweep so no scale is penalised for using another's calibration.
 *
 * Run: node bench/scale-bench.mjs [depth]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeEngine } from './engine-node.mjs';
import { parsePgn } from '../js/chess.js';
import { analysePositions, buildReport } from '../js/review.js';
import { setLossScale } from '../js/classify.js';

const here = dirname(fileURLToPath(import.meta.url));
const depth = Number(process.argv[2]) || 14;
const games = JSON.parse(readFileSync(join(here, 'data', 'games.json'), 'utf8'));

class SinglePool {
  constructor(e) {
    this.engines = [e];
    this.engine = e;
  }
  async analyseAll(jobs, { depth: d, multipv }) {
    const out = new Array(jobs.length).fill(null);
    for (let i = 0; i < jobs.length; i++) {
      if (!jobs[i]) continue;
      out[i] = await this.engine.analyse(jobs[i].fen, {
        depth: d,
        multipv: jobs[i].multipv || multipv,
        searchmoves: jobs[i].searchmoves || null,
      });
    }
    return out;
  }
}

const engine = await new NodeEngine('sf17lite').init({ hash: 128 });
engine.send('setoption name UCI_ShowWDL value true');
engine.send('isready');
await engine.expect('readyok');
const pool = new SinglePool(engine);

const SEVERITY = { inaccuracy: 1, mistake: 2, blunder: 3, miss: 3 };
const MAP = { Inaccuracy: 'inaccuracy', Mistake: 'mistake', Blunder: 'blunder' };

/* Analyse each game once per scale. The engine work dominates, so cache the
 * raw positions and rebuild the report per scale instead. */
const perScale = { wdl: [], cp: [], blend: [] };
const accPerScale = { wdl: [], cp: [], blend: [] };

for (const [gi, g] of games.entries()) {
  process.stdout.write(`\r[${gi + 1}/${games.length}] ${g.id}        `);
  let parsed;
  try {
    parsed = parsePgn(g.pgn);
  } catch {
    continue;
  }
  for (const scale of ['wdl', 'cp', 'blend']) {
    setLossScale(scale);
    await engine.newGame();
    const positions = await analysePositions(parsed, pool, { depth, multipv: 3 });
    if (positions.length < parsed.moves.length + 1) continue;
    const report = buildReport(parsed, positions);
    accPerScale[scale].push(report.stats.w.accuracy, report.stats.b.accuracy);
    for (let i = 0; i < report.moves.length && i < g.analysis.length; i++) {
      const lj = g.analysis[i] && g.analysis[i].judgment;
      perScale[scale].push({
        ours: report.moves[i].classification,
        theirs: lj ? MAP[lj.name] : null,
      });
    }
  }
}
process.stdout.write('\r' + ' '.repeat(60) + '\r');

console.log(`=== loss scale comparison (depth ${depth}, ${games.length} games) ===\n`);
console.log('scale    recall  precis   exact      F1   greatRate  meanAcc');

for (const scale of ['wdl', 'cp', 'blend']) {
  const rows = perScale[scale];
  let both = 0;
  let onlyUs = 0;
  let onlyThem = 0;
  let exact = 0;
  let great = 0;
  for (const r of rows) {
    if (r.ours === 'great') great++;
    const a = SEVERITY[r.ours] || 0;
    const b = r.theirs ? SEVERITY[r.theirs] : 0;
    if (a && b) {
      both++;
      if (r.ours === r.theirs) exact++;
    } else if (a) onlyUs++;
    else if (b) onlyThem++;
  }
  const recall = both / (both + onlyThem || 1);
  const precision = both / (both + onlyUs || 1);
  const agreement = exact / (both || 1);
  const f1 = (2 * recall * precision) / (recall + precision || 1);
  const acc = accPerScale[scale];
  const meanAcc = acc.reduce((a, b) => a + b, 0) / (acc.length || 1);
  console.log(
    scale.padEnd(8) +
      p(recall).padStart(7) + p(precision).padStart(8) + p(agreement).padStart(8) +
      p(f1).padStart(8) + p(great / rows.length).padStart(12) + meanAcc.toFixed(1).padStart(9)
  );
}

writeFileSync(join(here, 'data', `scales-d${depth}.json`), JSON.stringify(perScale));

function p(x) {
  return `${(x * 100).toFixed(1)}%`;
}

engine.quit();
process.exit(0);
