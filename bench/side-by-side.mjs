/* Print our review of a real game next to Lichess's, ply by ply.
 * The fastest way to see what a player would call wrong.
 * Usage: node bench/side-by-side.mjs [depth] [gameIndex]
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeEngine } from './engine-node.mjs';
import { parsePgn } from '../js/chess.js';
import { analysePositions, buildReport } from '../js/review.js';

const here = dirname(fileURLToPath(import.meta.url));
const depth = Number(process.argv[2]) || 16;
const index = Number(process.argv[3]) || 0;
const g = JSON.parse(readFileSync(join(here, 'data', 'games.json'), 'utf8'))[index];

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

const parsed = parsePgn(g.pgn);
const positions = await analysePositions(parsed, new SinglePool(engine), { depth, multipv: 3 });
const report = buildReport(parsed, positions);

console.log(`${g.id}  ${g.white} (${g.whiteElo}) vs ${g.black} (${g.blackElo})  depth ${depth}`);
console.log(`${report.opening.name || '?'} (${report.opening.eco || '-'})  theory to ply ${report.theory}\n`);
console.log('ply move      ourCp  lcCp   diff  ourClass     lichess     loss  best      cands');

for (let i = 0; i < report.moves.length; i++) {
  const m = report.moves[i];
  const la = g.analysis[i] || {};
  const lcCp = la.mate !== undefined ? `M${la.mate}` : (la.eval ?? '');
  const pos = positions[i + 1];
  const ourCp = pos.mateWhite !== null ? `M${pos.mateWhite}` : pos.cpWhite;
  const diff =
    typeof lcCp === 'number' && typeof ourCp === 'number' ? Math.abs(ourCp - lcCp) : '';
  const lj = la.judgment ? la.judgment.name : '';
  const flag =
    (lj && !['inaccuracy', 'mistake', 'blunder', 'miss'].includes(m.classification)) ||
    (!lj && ['inaccuracy', 'mistake', 'blunder', 'miss'].includes(m.classification))
      ? ' <<'
      : '';
  console.log(
    String(i + 1).padStart(3) + ' ' +
      m.san.padEnd(9) +
      String(ourCp).padStart(6) +
      String(lcCp).padStart(6) +
      String(diff).padStart(7) + '  ' +
      m.classification.padEnd(12) +
      lj.padEnd(12) +
      m.loss.toFixed(1).padStart(5) + '  ' +
      String(m.bestSan || '').padEnd(9) +
      String(positions[i].candidates.length) +
      flag
  );
}

console.log(`\nWhite ${report.stats.w.accuracy.toFixed(1)}  Black ${report.stats.b.accuracy.toFixed(1)}`);
for (const s of ['w', 'b']) {
  console.log(
    `  ${s}: ` +
      Object.entries(report.stats[s].counts).filter(([, v]) => v).map(([k, v]) => `${k}:${v}`).join(' ')
  );
}

engine.quit();
process.exit(0);
