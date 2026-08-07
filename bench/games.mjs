/* Fetch a benchmark set of real games that Lichess has already analysed.
 *
 * Lichess publishes its own per-move judgments (Inaccuracy / Mistake /
 * Blunder) and evaluations for analysed games. That gives an outside opinion
 * to measure our classifier against, on real play rather than hand-picked
 * positions.
 *
 * Run: node bench/games.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, 'data'), { recursive: true });

/* A spread of rating bands and time controls, because a classifier tuned on
 * grandmaster games will be wrong about the blunder-strewn ones and vice
 * versa. */
const SOURCES = [
  { label: 'blitz-2000+', url: 'https://lichess.org/api/games/user/DrNykterstein?max=6&analysed=true&evals=true&perfType=blitz&pgnInJson=true' },
  { label: 'rapid-club', url: 'https://lichess.org/api/games/user/Zhigalko_Sergei?max=6&analysed=true&evals=true&perfType=rapid&pgnInJson=true' },
  { label: 'blitz-mixed', url: 'https://lichess.org/api/games/user/penguingm1?max=6&analysed=true&evals=true&perfType=blitz&pgnInJson=true' },
];

const games = [];

for (const source of SOURCES) {
  try {
    const res = await fetch(source.url, { headers: { Accept: 'application/x-ndjson' } });
    if (!res.ok) {
      console.log(`${source.label}: HTTP ${res.status}`);
      continue;
    }
    const text = await res.text();
    let kept = 0;
    for (const line of text.trim().split('\n')) {
      if (!line) continue;
      const g = JSON.parse(line);
      if (!g.analysis || !g.pgn) continue;
      games.push({
        id: g.id,
        label: source.label,
        white: g.players?.white?.user?.name ?? '?',
        black: g.players?.black?.user?.name ?? '?',
        whiteElo: g.players?.white?.rating ?? null,
        blackElo: g.players?.black?.rating ?? null,
        pgn: g.pgn,
        // One entry per ply: {eval|mate, judgment?:{name,comment}}
        analysis: g.analysis,
      });
      kept++;
    }
    console.log(`${source.label}: ${kept} analysed games`);
  } catch (err) {
    console.log(`${source.label}: ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, 500));
}

writeFileSync(join(here, 'data', 'games.json'), JSON.stringify(games, null, 1));
const plies = games.reduce((n, g) => n + g.analysis.length, 0);
const judged = games.reduce(
  (n, g) => n + g.analysis.filter((a) => a.judgment).length,
  0
);
console.log(`\nsaved ${games.length} games, ${plies} plies, ${judged} carrying a Lichess judgment`);
