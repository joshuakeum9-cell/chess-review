/* Measure one engine build, in its own process.
 *
 * The emscripten builds keep module-level state, so instantiating two of them
 * in a single process gives wrong answers or crashes. Each build therefore
 * gets a fresh process and reports JSON on stdout.
 *
 * Usage: node bench/measure-build.mjs <buildId> <mode> [depth]
 *   mode = reference | measure
 */
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeEngine } from './engine-node.mjs';
import { SUITE } from './positions.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, 'data');
const [buildId, mode, depthArg] = process.argv.slice(2);
const depth = Number(depthArg) || 12;

mkdirSync(dataDir, { recursive: true });

const engine = await new NodeEngine(buildId).init({ hash: mode === 'reference' ? 256 : 64 });

if (mode === 'reference') {
  const out = [];
  for (const pos of SUITE) {
    await engine.newGame();
    const r = await engine.analyse(pos.fen, { depth, multipv: 1 });
    out.push({ ...pos, best: r.bestMove, cp: r.lines[0] ? r.lines[0].cp : 0 });
  }
  writeFileSync(join(dataDir, 'reference.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ ok: true, positions: out.length }));
} else {
  const reference = JSON.parse(readFileSync(join(dataDir, 'reference.json'), 'utf8'));
  let agree = 0;
  let totalMs = 0;
  let totalNodes = 0;
  const byCategory = {};
  let cpError = 0;

  for (const pos of reference) {
    await engine.newGame();
    const r = await engine.analyse(pos.fen, { depth, multipv: 3 });
    const ok = r.bestMove === pos.best;
    if (ok) agree++;
    byCategory[pos.category] = byCategory[pos.category] || { n: 0, ok: 0 };
    byCategory[pos.category].n++;
    if (ok) byCategory[pos.category].ok++;
    // How far the shallow evaluation sits from the deep one, in centipawns.
    if (r.lines[0]) cpError += Math.abs(r.lines[0].cp - pos.cp);
    totalMs += r.ms;
    totalNodes += r.nodes;
  }

  console.log(
    JSON.stringify({
      ok: true,
      buildId,
      depth,
      agreement: (agree / reference.length) * 100,
      meanCpError: cpError / reference.length,
      msPerPosition: Math.round(totalMs / reference.length),
      knps: Math.round(totalNodes / (totalMs || 1)),
      byCategory,
    })
  );
}

engine.quit();
process.exit(0);
