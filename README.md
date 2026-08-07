# Game Review

A post-game chess analyser: load a game, get an evaluation bar, a verdict on
every move, and the line you should have played instead. Stockfish runs in a
Web Worker inside your browser. No server, no account, nothing uploaded.

**Live version: https://joshuakeum9-cell.github.io/chess-review/**

Built from scratch: the chess rules, the PGN parser, the board renderer, the
static exchange evaluator and the move-classification logic are all in this
repo. The only outside components are the Stockfish binary and the opening
dataset.

## Running it

The app uses ES modules, so it needs to be served over HTTP. Opening
`index.html` off the disk will not work.

```bash
python -m http.server 8130
```

Then open http://localhost:8130.

### The engine

**Stockfish 17.1** (lite build), vendored in `vendor/sf17/` under GPL-3, so the
app runs offline out of the box. 7 MB, single threaded, no SharedArrayBuffer
required, which is what makes it work on GitHub Pages.

Analysis is parallel: a pool of workers, one per CPU core, each analysing
different positions at the same time. Work is split up front rather than
pulled off a shared queue, so every worker sees the same positions in the same
order on every run and the review is reproducible.

Stockfish 16 and 10 remain as automatic fallbacks for browsers without
WebAssembly SIMD. `npm run vendor` regenerates all of them.

### Tests

```bash
npm test
```

Runs perft against the standard reference positions, which proves move
generation correct, plus unit tests for static exchange evaluation, sacrifice
detection, expected score, the accuracy curve, opening recognition and every
classification branch.

### Benchmarks

```bash
node bench/engines.mjs          # compare engine builds and depths
node bench/vs-lichess.mjs sf17lite 14   # evaluation error vs Lichess cloud evals
node bench/games.mjs            # fetch Lichess-analysed games as ground truth
node bench/classify-bench.mjs 14   # classifier agreement with Lichess judgments
node bench/tune.mjs 14          # sweep classification thresholds
node bench/one-game.mjs 14      # per-move trace of a single game
```

## Loading a game

- **Paste PGN** from Chess.com, Lichess, or a database.
- **Chess.com / Lichess** by username, pulling recent public games.
- **Upload a .pgn** file; multi-game files give you a list.

## How a move gets its verdict

### Expected score, not centipawns

Centipawns answer "who is better and by how much", which is not the question a
review asks. A move that drops the evaluation from +9.0 to +6.0 loses 300
centipawns and changes nothing. A move that drops +0.3 to -0.5 loses less and
throws the game away.

So everything is denominated in **expected score**: 100 means you score a full
point with best play, 50 a draw, 0 a loss. The cost of a move is how much of
the *result* it gave up.

Expected score comes from Stockfish's own win/draw/loss statistics
(`UCI_ShowWDL`) rather than a curve fitted to centipawns. That difference
carries real information. Both of these positions evaluate to 0.00:

| Position | Engine says | Fitted curve says |
| --- | --- | --- |
| Sharp balanced middlegame | 8% win / 90% draw / 9% loss | 50% |
| Opposite-coloured bishops | 0.3% win / 99.4% draw / 0.3% loss | 50% |

Only the second is a position where nothing you do matters. A sigmoid on
centipawns cannot tell them apart; the engine's own statistics can, and the
classifier uses that to stop grading moves in dead positions.

### Two passes, so the comparison is fair

1. **Every position** is searched with MultiPV, giving the engine's choice and
   how close the alternatives were.
2. **Every played move pass 1 did not already score** gets its own search with
   `searchmoves`, at the same depth, in the same position.

Both numbers therefore always come from the same search of the same position.
Measuring against the *next* position instead looks reasonable but is quietly
biased: that position sits a ply deeper, so ordinary moves come out looking
like mistakes.

Two further rules keep the figures honest:

- Candidate scores are only compared **within one search iteration**. The
  engine reports candidate 1 at depth 16 while candidate 3 is still at depth
  15, and mixing those is meaningless.
- A move that **ties** with the engine's pick is marked Best too. Positions
  routinely have several equally good moves and which one the engine lists
  first is arbitrary.

### The ladder

With `loss` = expected-score points given up:

| Verdict | When |
| --- | --- |
| **Forced** | Only one legal move |
| **Book** | Position is still in the opening dataset |
| **Brilliant !!** | A sound sacrifice: at least 150cp invested by static exchange, still the best move, still fine afterwards, and you were not already winning |
| **Great !** | The only move that held, where it mattered: every alternative gives up 10+ points and the position was not already decided |
| **Best ★** | The engine's first choice, or level with it |
| **Excellent** | `loss` < 2 |
| **Good** | `loss` < 6 |
| **Inaccuracy ?!** | `loss` < 12 |
| **Mistake ?** | `loss` < 18 |
| **Miss ⨯** | You had a forced mate or a won position and gave it up |
| **Blunder ??** | Everything worse |

Those thresholds are not round numbers picked by feel. They were swept against
Lichess's own judgments over 1419 plies of real games (`bench/tune.mjs`),
scoring each combination on how well it reproduces an outside opinion.

**Decided positions are exempt.** If the result is already settled both before
and after the move, nothing is graded as an error. This is the single largest
source of false blunders elsewhere: throwing away a second queen while still
mating is not the same mistake as losing a drawn game.

### Sacrifices

Sacrifice detection uses **static exchange evaluation**, not a walk down the
engine's principal variation. Walking the line cannot work: in any capture
sequence you are transiently down material, so every recapture reads as a
sacrifice. SEE answers the real question, which is whether the material comes
back. On a Greek gift it reports exactly 230 centipawns invested, a bishop for
a pawn.

## Accuracy

Per-move accuracy is `103.1668 · e^(-0.04354 · loss) - 3.1669`, clamped to
0-100.

Game accuracy is **not** a plain mean. A plain mean treats a mistake in a dead
drawn endgame the same as one in a razor-sharp middlegame, and lets a long tail
of trivial moves bury a decisive error. Instead each move is weighted by how
volatile the position was around it, and the weighted mean is combined with a
harmonic mean, which punishes the worst moves rather than letting them average
out.

Measured over 18 games between 2000-2900 rated players: **mean 90.9, median
94.5**, which is the band the major sites report for that population.

## Openings

3810 named openings with ECO codes, from the
[Lichess ECO dataset](https://github.com/lichess-org/chess-openings) (CC0),
compiled by `scripts/build-openings.mjs`.

The book is keyed by **position**, not by move sequence. The London System
reached via 1.d4 d5 2.Bf4 and via 1.d4 Nf6 2.Nf3 g6 3.Bf4 is the same opening,
and a move-prefix book only recognises the order it happens to store. Position
keys catch transpositions for free.

## Explanations

Every sentence has to be earned by something read off the board. "This loses
material" is only said when static exchange says a piece can be won; a fork is
only named when a piece really does attack two targets; a mate is only claimed
when the engine reports one. Generic filler is worse than saying less, because
a player who checks the board and finds the claim false stops trusting
everything else.

## Depth and speed

Times are for a 45-move game on a modern laptop with 6 workers.

| Depth | Roughly | Notes |
| --- | --- | --- |
| 12 | ~3s | fast, but verdicts wobble |
| 16 | ~30s | balanced |
| 18 | ~60s | the default |
| 22 | several minutes | deep study |

Depth is the single biggest accuracy lever. Measured against Lichess's
judgments, going from depth 10 to depth 14 moved recall from 56.9% to 65.9% and
precision from 59.3% to 75.7%. Compare two reviews only if they ran at the same
depth.

## Using the review

- Click any move, or use **←** / **→**, **Home**, **End**. **f** flips.
- The eval graph marks every mistake and blunder; click to jump.
- **Show me** steps back to the position as it was and draws two arrows.
- **Retry** makes you find the better move yourself. Any move within 2 points
  counts, and an attempt outside the candidate list is evaluated on the spot
  rather than assumed wrong.
- **Engine lines** shows the top candidates with evaluations so you can check a
  verdict instead of trusting it.
- Click any piece to play a move and ask the engine what it thinks.

## Files

| File | What it does |
| --- | --- |
| `js/chess.js` | Board, legal moves, SAN, FEN, PGN, attacker enumeration |
| `js/engine.js` | Stockfish worker pool, UCI, build fallback ladder |
| `js/classify.js` | Expected score, static exchange, the classification ladder, accuracy |
| `js/tactics.js` | Reading the board: hanging pieces, forks, back rank, material swings |
| `js/explain.js` | The coaching voice |
| `js/review.js` | Sequences the two passes and builds the report |
| `js/openings.js` | Opening recognition by position hash |
| `js/board.js` | SVG board |
| `js/app.js` | State, loading, rendering, keyboard |
| `bench/` | Engine, classifier and threshold benchmarks |
| `test/` | perft and classifier unit tests |

## A note on scope

This analyses games that are **already finished**. It is deliberately not a
live overlay, which is engine assistance and will get you banned everywhere.

## Known gaps

- No tablebase. Syzygy files are gigabytes, so shipping them is out; the
  Lichess tablebase API would work but needs a network round trip per
  position, which conflicts with running offline.
- The opening book names positions but carries no popularity or scoring
  statistics, so "this is a rare sideline" is not something it can say.
- The performance band shown next to accuracy is a coarse lookup, not a rating.
