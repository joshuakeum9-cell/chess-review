/* Benchmark: which Stockfish build should the app ship, and at what depth?
 *
 * Each build runs in its own process (emscripten module state is not
 * reusable). Strength is measured as agreement with a deep reference search
 * plus mean centipawn error against it.
 *
 * Run: node bench/engines.mjs
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function run(args, { quiet = true } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, 'measure-build.mjs'), ...args], {
      cwd: join(here, '..'),
      stdio: ['ignore', 'pipe', quiet ? 'ignore' : 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('close', () => {
      // The engine prints banner lines before our JSON; take the last line
      // that parses.
      const lines = out.trim().split('\n').reverse();
      for (const line of lines) {
        try {
          return resolve(JSON.parse(line));
        } catch {
          /* keep looking */
        }
      }
      resolve({ ok: false, error: out.trim().split('\n').slice(-1)[0] || 'no output' });
    });
  });
}

const PLAN = process.env.BENCH_PLAN
  ? JSON.parse(process.env.BENCH_PLAN)
  : [
      ['sf17lite', [10, 12, 14]],
      ['sf17', [10, 12, 14]],
    ];
const REFERENCE_DEPTH = 20;

console.log(`Building reference: sf17 @ depth ${REFERENCE_DEPTH}`);
const ref = await run(['sf17', 'reference', String(REFERENCE_DEPTH)]);
if (!ref.ok) {
  console.error('reference failed:', ref.error);
  process.exit(1);
}
console.log(`  ${ref.positions} positions\n`);

const rows = [];
for (const [id, depths] of PLAN) {
  for (const depth of depths) {
    process.stdout.write(`${id} @ depth ${depth} ... `);
    const r = await run([id, 'measure', String(depth)]);
    if (!r.ok) {
      console.log(`skipped (${r.error})`);
      continue;
    }
    rows.push(r);
    console.log(
      `agree ${r.agreement.toFixed(1)}%  cp-err ${r.meanCpError.toFixed(0)}  ${r.msPerPosition}ms/pos`
    );
  }
}

console.log('\n=== summary ===');
console.log('build      depth  agree%  cp-err  ms/pos   knps');
for (const r of rows) {
  console.log(
    r.buildId.padEnd(10) +
      String(r.depth).padStart(5) +
      r.agreement.toFixed(1).padStart(8) +
      r.meanCpError.toFixed(0).padStart(8) +
      String(r.msPerPosition).padStart(8) +
      String(r.knps).padStart(7)
  );
}

const cats = ['opening', 'middlegame', 'tactics', 'endgame', 'sacrifice'];
console.log('\n=== agreement by category ===');
console.log('build/depth'.padEnd(18) + cats.map((c) => c.slice(0, 9).padStart(11)).join(''));
for (const r of rows) {
  const label = `${r.buildId}@${r.depth}`;
  console.log(
    label.padEnd(18) +
      cats
        .map((c) => {
          const b = r.byCategory[c];
          return (b ? `${((b.ok / b.n) * 100).toFixed(0)}%` : '-').padStart(11);
        })
        .join('')
  );
}
