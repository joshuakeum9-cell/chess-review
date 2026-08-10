/* Compare our per-ply evaluation against Lichess's, on real games.
 *
 * This is what drives the eval bar and the graph, so if it is off the whole
 * review feels wrong regardless of how good the classifier is. Lichess stores
 * a centipawn (or mate) score for every ply of an analysed game, which is a
 * direct like-for-like reference.
 *
 * Run: node bench/eval-bench.mjs [depth] [maxGames]
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeEngine } from './engine-node.mjs';
import { parsePgn } from '../js/chess.js';
import { analysePositions } from '../js/review.js';
import { expectedFromCp, expectedScore } from '../js/classify.js';

const here = dirname(fileURLToPath(import.meta.url));
const depth = Number(process.argv[2]) || 16;
const maxGames = Number(process.argv[3]) || 6;
const games = JSON.parse(readFileSync(join(here, 'data', 'games.json'), 'utf8')).slice(0, maxGames);

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
const pool = new SinglePool(engine);

const cpErrors = [];
const barBuckets = [];
const signFlips = [];
let compared = 0;
let mateDisagree = 0;

for (const [gi, g] of games.entries()) {
  process.stdout.write(`\r[${gi + 1}/${games.length}] ${g.id}          `);
  let parsed;
  try {
    parsed = parsePgn(g.pgn);
  } catch {
    continue;
  }
  await engine.newGame();
  const positions = await analysePositions(parsed, pool, { depth, multipv: 3 });

  // Lichess analysis[i] is the evaluation of the position AFTER ply i+1,
  // always from White's point of view.
  for (let i = 0; i < g.analysis.length && i + 1 < positions.length; i++) {
    const theirs = g.analysis[i];
    const pos = positions[i + 1];
    if (!pos) continue;

    if (theirs.mate !== undefined || pos.mateWhite !== null) {
      if ((theirs.mate !== undefined) !== (pos.mateWhite !== null)) mateDisagree++;
      continue; // mate scores are not comparable in centipawns
    }
    if (theirs.eval === undefined) continue;

    compared++;
    const err = Math.abs(pos.cpWhite - theirs.eval);
    cpErrors.push(err);

    // What the eval bar actually shows, both ways.
    barBuckets.push({
      cp: pos.cpWhite,
      wdlBar: pos.expectedWhite,
      cpBar: expectedFromCp(pos.cpWhite),
    });

    // Disagreeing about who is better is the most visible failure.
    if (Math.sign(pos.cpWhite) !== Math.sign(theirs.eval) && Math.abs(theirs.eval) > 50 && Math.abs(pos.cpWhite) > 50) {
      signFlips.push({ game: g.id, ply: i + 1, ours: pos.cpWhite, theirs: theirs.eval });
    }
  }
}

process.stdout.write('\r' + ' '.repeat(60) + '\r');

const sorted = [...cpErrors].sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)];
const mean = cpErrors.reduce((a, b) => a + b, 0) / cpErrors.length;
const p90 = sorted[Math.floor(sorted.length * 0.9)];

console.log(`=== evaluation vs Lichess (depth ${depth}, ${games.length} games, ${compared} plies) ===\n`);
console.log(`centipawn error   mean ${mean.toFixed(0)}  median ${median}  p90 ${p90}`);
console.log(`within 50cp       ${pct(cpErrors.filter((e) => e <= 50).length, cpErrors.length)}`);
console.log(`within 100cp      ${pct(cpErrors.filter((e) => e <= 100).length, cpErrors.length)}`);
console.log(`sign disagreements (who is better): ${signFlips.length} (${pct(signFlips.length, compared)})`);
console.log(`mate/no-mate disagreements: ${mateDisagree}`);

/* Averaging bar error over every ply is misleading, because most plies sit
 * near equal where both curves agree. What matters is the response across the
 * range where games are decided: a bar that pins to one end at +2.5 and stops
 * moving reads as broken even though its average error looks small. So report
 * the curve itself, bucketed by evaluation. */
console.log('\n=== eval BAR response curve (bar height for a given score) ===');
console.log('   cp     WDL bar   centipawn bar   plies');
const buckets = new Map();
for (const b of barBuckets) {
  const k = Math.max(-400, Math.min(400, Math.round(b.cp / 100) * 100));
  if (!buckets.has(k)) buckets.set(k, []);
  buckets.get(k).push(b);
}
for (const k of [...buckets.keys()].sort((a, b) => a - b)) {
  const rows = buckets.get(k);
  const wdl = rows.reduce((s, r) => s + r.wdlBar, 0) / rows.length;
  const cp = rows.reduce((s, r) => s + r.cpBar, 0) / rows.length;
  console.log(
    String(k).padStart(5) + wdl.toFixed(1).padStart(11) + cp.toFixed(1).padStart(16) + String(rows.length).padStart(8)
  );
}
const saturated = barBuckets.filter((b) => Math.abs(b.cp) < 400 && (b.wdlBar > 99 || b.wdlBar < 1));
console.log(
  `\nplies under 4 pawns where the WDL bar is already pinned: ${saturated.length} of ${barBuckets.filter((b) => Math.abs(b.cp) < 400).length}`
);

if (signFlips.length) {
  console.log('\nworst sign disagreements:');
  for (const f of signFlips.slice(0, 8)) {
    console.log(`  ${f.game} ply ${f.ply}: ours ${f.ours} vs lichess ${f.theirs}`);
  }
}

function pct(a, b) {
  return b ? `${((a / b) * 100).toFixed(1)}%` : 'n/a';
}

engine.quit();
process.exit(0);
