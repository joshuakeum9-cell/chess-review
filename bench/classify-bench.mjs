/* Benchmark the whole review pipeline against Lichess on real games.
 *
 * Three levels of comparison, strictest first:
 *   1. Per-player summary: our inaccuracy/mistake/blunder counts, average
 *      centipawn loss, and accuracy versus the numbers Lichess shows on the
 *      game page. This is what a player checks when deciding whether to
 *      trust the review.
 *   2. Per-ply judgments: which moves each of us flags, and how severely.
 *   3. Invariants: properties that must hold regardless of engine output.
 *
 * Usage: node bench/classify-bench.mjs [depth] [verify]
 *   verify = 1 runs the deep re-check pass on flagged moves, as the app does.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeEngine } from './engine-node.mjs';
import { parsePgn } from '../js/chess.js';
import { analysePositions, verifyFlaggedMoves, buildReport } from '../js/review.js';
import { accuracyFromSeries } from '../js/classify.js';

const here = dirname(fileURLToPath(import.meta.url));
const depth = Number(process.argv[2]) || 14;
const verify = process.argv[3] === '1';
const games = JSON.parse(readFileSync(join(here, 'data', 'games.json'), 'utf8'));

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

const MAP = { Inaccuracy: 'inaccuracy', Mistake: 'mistake', Blunder: 'blunder' };
const SEVERITY = { inaccuracy: 1, mistake: 2, blunder: 3, miss: 3 };
const bandOf = (g) => {
  const e = Math.min(g.whiteElo || 9999, g.blackElo || 9999);
  return e < 1500 ? 'under1500' : e < 2200 ? '1500-2200' : '2200+';
};

const plies = [];
const players = [];
const counts = {};
const perBand = {};
let totalPlies = 0;
let invariantFailures = [];

for (const [gi, g] of games.entries()) {
  process.stdout.write(`\r[${gi + 1}/${games.length}] ${g.id} (${g.label})          `);
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
  if (verify) await verifyFlaggedMoves(parsed, positions, pool, { depth, extraDepth: 4 });
  const report = buildReport(parsed, positions);

  const band = bandOf(g);

  // ---- invariants ---------------------------------------------------
  for (const m of report.moves) {
    if (!m.classification) invariantFailures.push(`${g.id} ply ${m.index + 1}: no classification`);
    if (!Number.isFinite(m.loss) || !Number.isFinite(m.accuracy))
      invariantFailures.push(`${g.id} ply ${m.index + 1}: NaN in loss/accuracy`);
    if (m.playedBest && m.loss > 0)
      invariantFailures.push(`${g.id} ply ${m.index + 1}: playedBest with loss ${m.loss.toFixed(2)}`);
    if (/undefined|NaN|\[object/.test(m.explanation || ''))
      invariantFailures.push(`${g.id} ply ${m.index + 1}: broken explanation "${(m.explanation || '').slice(0, 60)}"`);
    if (m.classification !== 'book' && !(m.explanation || '').length)
      invariantFailures.push(`${g.id} ply ${m.index + 1}: empty explanation`);
  }
  if (!Number.isFinite(report.stats.w.accuracy) || !Number.isFinite(report.stats.b.accuracy))
    invariantFailures.push(`${g.id}: NaN game accuracy`);

  // ---- per-player summary vs Lichess --------------------------------
  const lichessSeries = [{ cp: 15, mate: null }].concat(
    g.analysis.map((a) => ({ cp: a.eval ?? 0, mate: a.mate ?? null }))
  );
  // "From Position" games can start with Black to move; the mover parity of
  // the eval series has to follow the game, not an assumption.
  const startTurn = parsed.startFen.split(' ')[1] === 'b' ? 'b' : 'w';
  const lichessAcc = accuracyFromSeries(lichessSeries, startTurn);

  for (const side of ['w', 'b']) {
    const summary = side === 'w' ? g.whiteSummary : g.blackSummary;
    if (!summary) continue;
    const mine = report.moves.filter((m) => m.color === side);
    const ourCounts = {
      inaccuracy: mine.filter((m) => m.classification === 'inaccuracy').length,
      mistake: mine.filter((m) => m.classification === 'mistake').length,
      blunder: mine.filter((m) => ['blunder', 'miss'].includes(m.classification)).length,
    };
    // acpl the way Lichess computes it: evals clamped to [-1000, 1000] FIRST,
    // then mean cp lost per move. Clamping after differencing instead lets a
    // mate score (+99xxx) that resolves to an ordinary +8 register as a
    // 1000cp loss, which tripled acpl on mate-heavy games.
    const clamp = (x) => Math.max(-1000, Math.min(1000, x));
    const acpl =
      mine.reduce((sum, m) => {
        const before = clamp(m.evalBeforeWhite);
        const after = clamp(m.evalAfterWhite);
        const loss = side === 'w' ? Math.max(0, before - after) : Math.max(0, after - before);
        return sum + loss;
      }, 0) / (mine.length || 1);

    players.push({
      id: g.id,
      band,
      side,
      elo: side === 'w' ? g.whiteElo : g.blackElo,
      ourAcc: report.stats[side].accuracy,
      lichessAcc: side === 'w' ? lichessAcc.white : lichessAcc.black,
      ourAcpl: acpl,
      lichessAcpl: summary.acpl,
      ourCounts,
      lichessCounts: {
        inaccuracy: summary.inaccuracy ?? 0,
        mistake: summary.mistake ?? 0,
        blunder: summary.blunder ?? 0,
      },
    });
  }

  // ---- per-ply -------------------------------------------------------
  for (let i = 0; i < report.moves.length && i < g.analysis.length; i++) {
    const m = report.moves[i];
    counts[m.classification] = (counts[m.classification] || 0) + 1;
    totalPlies++;
    const lj = g.analysis[i] && g.analysis[i].judgment;
    plies.push({
      game: g.id,
      band,
      ply: i,
      ours: m.classification,
      theirs: lj ? MAP[lj.name] : null,
      loss: m.loss,
      expectedBefore: m.expectedBefore,
      expectedAfter: m.expectedAfter,
      playedBest: m.playedBest,
      decided: m.decided,
      isBook: m.classification === 'book',
      legalCount: positions[i].legalCount,
      phase: m.phase,
    });
  }
}
process.stdout.write('\r' + ' '.repeat(70) + '\r');

/* ---- report ---------------------------------------------------------- */

console.log(`=== pipeline vs Lichess (depth ${depth}${verify ? ' + verify pass' : ''}, ${games.length} games, ${totalPlies} plies) ===`);

console.log('\n--- invariants ---');
if (invariantFailures.length) {
  console.log(`${invariantFailures.length} FAILURES`);
  for (const f of invariantFailures.slice(0, 12)) console.log('  ' + f);
} else {
  console.log('all hold');
}

console.log('\n--- per-player summary vs the numbers Lichess shows ---');
const accDiffs = players.map((p) => Math.abs(p.ourAcc - p.lichessAcc));
const acplDiffs = players.map((p) => Math.abs(p.ourAcpl - p.lichessAcpl));
const countDiffs = players.map(
  (p) =>
    Math.abs(p.ourCounts.inaccuracy - p.lichessCounts.inaccuracy) +
    Math.abs(p.ourCounts.mistake - p.lichessCounts.mistake) +
    Math.abs(p.ourCounts.blunder - p.lichessCounts.blunder)
);
console.log(`players compared        ${players.length}`);
console.log(`accuracy   mean abs diff ${mean(accDiffs).toFixed(1)} points  (median ${median(accDiffs).toFixed(1)}, worst ${Math.max(...accDiffs).toFixed(1)})`);
console.log(`acpl       mean abs diff ${mean(acplDiffs).toFixed(1)} cp     (median ${median(acplDiffs).toFixed(1)}, worst ${Math.max(...acplDiffs).toFixed(0)})`);
console.log(`I/M/B      mean abs diff ${mean(countDiffs).toFixed(1)} per player`);

console.log('\nby band:');
for (const band of ['2200+', '1500-2200', 'under1500']) {
  const rows = players.filter((p) => p.band === band);
  if (!rows.length) continue;
  console.log(
    `  ${band.padEnd(10)} n=${String(rows.length).padStart(2)}  acc diff ${mean(rows.map((p) => Math.abs(p.ourAcc - p.lichessAcc))).toFixed(1)}  acpl diff ${mean(rows.map((p) => Math.abs(p.ourAcpl - p.lichessAcpl))).toFixed(1)}`
  );
}

console.log('\n--- per-ply judgments ---');
let both = 0, onlyUs = 0, onlyThem = 0, exact = 0, within1 = 0;
for (const p of plies) {
  const a = SEVERITY[p.ours] || 0;
  const b = p.theirs ? SEVERITY[p.theirs] : 0;
  if (a && b) {
    both++;
    if (p.ours === p.theirs || (p.ours === 'miss' && p.theirs === 'blunder')) exact++;
    if (Math.abs(a - b) <= 1) within1++;
  } else if (a) onlyUs++;
  else if (b) onlyThem++;
}
console.log(`recall ${pct(both, both + onlyThem)}   precision ${pct(both, both + onlyUs)}   exact ${pct(exact, both)}   within one step ${pct(within1, both)}`);

console.log('\nby band (recall / precision):');
for (const band of ['2200+', '1500-2200', 'under1500']) {
  const rows = plies.filter((p) => p.band === band);
  let b2 = 0, ou = 0, ot = 0;
  for (const p of rows) {
    const a = SEVERITY[p.ours] || 0;
    const t = p.theirs ? SEVERITY[p.theirs] : 0;
    if (a && t) b2++;
    else if (a) ou++;
    else if (t) ot++;
  }
  console.log(`  ${band.padEnd(10)} ${pct(b2, b2 + ot)} / ${pct(b2, b2 + ou)}   (${rows.length} plies)`);
}

console.log('\n--- label distribution ---');
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`${k.padEnd(12)} ${String(v).padStart(5)}  ${pct(v, totalPlies)}`);
}

writeFileSync(join(here, 'data', `plies-d${depth}${verify ? 'v' : ''}.json`), JSON.stringify(plies));
writeFileSync(join(here, 'data', `players-d${depth}${verify ? 'v' : ''}.json`), JSON.stringify(players, null, 1));

function mean(a) { return a.reduce((x, y) => x + y, 0) / (a.length || 1); }
function median(a) { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0; }
function pct(a, b) { return b ? `${((a / b) * 100).toFixed(1)}%` : 'n/a'; }

engine.quit();
process.exit(invariantFailures.length ? 1 : 0);
