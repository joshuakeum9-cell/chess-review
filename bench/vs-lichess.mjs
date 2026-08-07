/* Score one engine build against the independent Lichess cloud evaluations.
 * Usage: node bench/vs-lichess.mjs <buildId> <depth>
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeEngine } from './engine-node.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const [buildId, depthArg] = process.argv.slice(2);
const depth = Number(depthArg) || 12;

const ref = JSON.parse(readFileSync(join(here, 'data', 'lichess-ref.json'), 'utf8')).filter(
  (r) => r.cloud && r.cloud.cp !== null && r.cloud.cp !== undefined
);

const engine = await new NodeEngine(buildId).init({ hash: 64 });
let cpError = 0;
let bestAgree = 0;
const byCategory = {};

for (const pos of ref) {
  await engine.newGame();
  const r = await engine.analyse(pos.fen, { depth, multipv: 1 });
  const mine = r.lines[0] ? r.lines[0].cp : 0;
  const err = Math.abs(mine - pos.cloud.cp);
  cpError += err;
  const agree = r.bestMove === pos.cloud.best;
  if (agree) bestAgree++;
  byCategory[pos.category] = byCategory[pos.category] || { n: 0, err: 0, ok: 0 };
  byCategory[pos.category].n++;
  byCategory[pos.category].err += err;
  if (agree) byCategory[pos.category].ok++;
}

console.log(
  JSON.stringify({
    buildId,
    depth,
    positions: ref.length,
    meanCpError: +(cpError / ref.length).toFixed(1),
    bestMoveAgreement: +((bestAgree / ref.length) * 100).toFixed(1),
    byCategory: Object.fromEntries(
      Object.entries(byCategory).map(([k, v]) => [
        k,
        { n: v.n, meanCpError: +(v.err / v.n).toFixed(1), agree: +((v.ok / v.n) * 100).toFixed(0) },
      ])
    ),
  })
);
engine.quit();
process.exit(0);
