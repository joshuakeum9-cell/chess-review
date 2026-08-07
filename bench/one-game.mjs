/* Analyse a single game and print every move's measurements.
 * Used to see exactly where an accuracy number comes from.
 * Usage: node bench/one-game.mjs [depth] [pgnFile]
 */
import { readFileSync } from 'node:fs';
import { NodeEngine } from './engine-node.mjs';
import { parsePgn } from '../js/chess.js';
import { analysePositions, buildReport } from '../js/review.js';

const depth = Number(process.argv[2]) || 14;
const pgnFile = process.argv[3];

const IMMORTAL = `[White "Anderssen"]
[Black "Kieseritzky"]
1. e4 e5 2. f4 exf4 3. Bc4 Qh4+ 4. Kf1 b5 5. Bxb5 Nf6 6. Nf3 Qh6 7. d3 Nh5
8. Nh4 Qg5 9. Nf5 c6 10. g4 Nf6 11. Rg1 cxb5 12. h4 Qg6 13. h5 Qg5 14. Qf3 Ng8
15. Bxf4 Qf6 16. Nc3 Bc5 17. Nd5 Qxb2 18. Bd6 Bxg1 19. e5 Qxa1+ 20. Ke2 Na6
21. Nxg7+ Kd8 22. Qf6+ Nxf6 23. Be7# 1-0`;

const pgn = pgnFile ? readFileSync(pgnFile, 'utf8') : IMMORTAL;

class SinglePool {
  constructor(engine) {
    this.engines = [engine];
    this.engine = engine;
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

const game = parsePgn(pgn);
const positions = await analysePositions(game, new SinglePool(engine), { depth, multipv: 3 });
const report = buildReport(game, positions);

console.log(`depth ${depth}  |  ${report.opening.name || 'unnamed'} (${report.opening.eco || '-'})  |  theory to ply ${report.theory}\n`);
console.log('ply  move      class        loss   acc   expBefore expAfter  vol');
for (const m of report.moves) {
  console.log(
    String(m.index + 1).padStart(3) +
      '  ' + m.san.padEnd(9) +
      m.classification.padEnd(12) +
      m.loss.toFixed(1).padStart(6) +
      m.accuracy.toFixed(0).padStart(6) +
      m.expectedBefore.toFixed(1).padStart(10) +
      m.expectedAfter.toFixed(1).padStart(9) +
      m.volatility.toFixed(0).padStart(6)
  );
}

console.log(`\nWhite accuracy ${report.stats.w.accuracy.toFixed(1)}   Black accuracy ${report.stats.b.accuracy.toFixed(1)}`);
for (const side of ['w', 'b']) {
  const s = report.stats[side];
  const counts = Object.entries(s.counts).filter(([, v]) => v).map(([k, v]) => `${k}:${v}`).join(' ');
  console.log(`  ${side}: ${counts}`);
}

engine.quit();
process.exit(0);
