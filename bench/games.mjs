/* Fetch a benchmark set of real games that Lichess has already analysed.
 *
 * Beyond per-ply evals and judgments, Lichess publishes a per-player summary
 * for analysed games: inaccuracy/mistake/blunder counts, average centipawn
 * loss, and its own accuracy percentage. That summary is the ground truth a
 * player can see on lichess.org, which makes it the right thing to compare
 * our numbers against when deciding whether to trust them.
 *
 * The set deliberately spans rating bands: a classifier tuned only on
 * grandmaster games is wrong about blunder-strewn club games and vice versa.
 *
 * Run: node bench/games.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, 'data'), { recursive: true });

const SOURCES = [
  // elite
  { label: 'elite-blitz', url: 'https://lichess.org/api/games/user/DrNykterstein?max=6&analysed=true&evals=true&perfType=blitz&pgnInJson=true' },
  { label: 'elite-blitz2', url: 'https://lichess.org/api/games/user/penguingm1?max=6&analysed=true&evals=true&perfType=blitz&pgnInJson=true' },
  // strong club
  { label: 'club-rapid', url: 'https://lichess.org/api/games/user/Zhigalko_Sergei?max=6&analysed=true&evals=true&perfType=rapid&pgnInJson=true' },
  // improvers / lower rated: popular streamers and teaching accounts play
  // lower-rated opponents; german11 is a famously average-rated high-volume
  // account
  { label: 'club-blitz', url: 'https://lichess.org/api/games/user/german11?max=8&analysed=true&evals=true&perfType=blitz&pgnInJson=true' },
  { label: 'club-classical', url: 'https://lichess.org/api/games/user/german11?max=6&analysed=true&evals=true&perfType=classical&pgnInJson=true' },
];

const games = [];

for (const source of SOURCES) {
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      const res = await fetch(source.url, { headers: { Accept: 'application/x-ndjson' } });
      if (res.status === 429) {
        if (attempt > 3) {
          console.log(`${source.label}: rate limited, giving up`);
          break;
        }
        console.log(`${source.label}: 429, waiting 65s (attempt ${attempt})`);
        await new Promise((r) => setTimeout(r, 65000));
        continue;
      }
      if (!res.ok) {
        console.log(`${source.label}: HTTP ${res.status}`);
        break;
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
          speed: g.speed,
          white: g.players?.white?.user?.name ?? '?',
          black: g.players?.black?.user?.name ?? '?',
          whiteElo: g.players?.white?.rating ?? null,
          blackElo: g.players?.black?.rating ?? null,
          // Lichess's own per-player verdict: {inaccuracy, mistake, blunder,
          // acpl, accuracy} where accuracy is present on newer analyses.
          whiteSummary: g.players?.white?.analysis ?? null,
          blackSummary: g.players?.black?.analysis ?? null,
          pgn: g.pgn,
          analysis: g.analysis,
        });
        kept++;
      }
      console.log(`${source.label}: ${kept} analysed games`);
      break;
    } catch (err) {
      console.log(`${source.label}: ${err.message}`);
      break;
    }
  }
  await new Promise((r) => setTimeout(r, 3000));
}

writeFileSync(join(here, 'data', 'games.json'), JSON.stringify(games, null, 1));
const plies = games.reduce((n, g) => n + g.analysis.length, 0);
const judged = games.reduce((n, g) => n + g.analysis.filter((a) => a.judgment).length, 0);
const withAccuracy = games.filter((g) => g.whiteSummary && g.whiteSummary.accuracy !== undefined).length;
const elos = games.flatMap((g) => [g.whiteElo, g.blackElo]).filter(Boolean);
console.log(
  `\nsaved ${games.length} games, ${plies} plies, ${judged} judgments, ` +
    `${withAccuracy} games carry Lichess accuracy, elo range ${Math.min(...elos)}-${Math.max(...elos)}`
);
