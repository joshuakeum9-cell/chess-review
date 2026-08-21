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
node bench/scale-bench.mjs 12   # compare loss scales against Lichess
node bench/eval-bench.mjs 16    # evaluation and eval-bar accuracy per ply
node bench/side-by-side.mjs 16 1  # our review next to Lichess's, ply by ply
node bench/one-game.mjs 14      # per-move trace of a single game
```

A warning learned the hard way: the benchmark harness re-implements the
engine's UCI parsing, and for a while it did not parse win/draw/loss while the
browser did. The two were then measuring different pipelines, and the
benchmarks looked healthy while the shipped app used a worse scale. If you
touch `parseInfo` in `js/engine.js`, mirror it in `bench/engine-node.mjs`.

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

### Why not the engine's own win/draw/loss numbers

Stockfish can report win/draw/loss probabilities directly (`UCI_ShowWDL`), and
those look like the obviously better source for expected score. They are the
more principled statement about the *result*. They are not the better measure
of a *move*, which was settled by experiment rather than argument.

Measured against Lichess's judgments over 18 games (`bench/scale-bench.mjs`):

| scale | recall | precision | exact | F1 |
| --- | --- | --- | --- | --- |
| win/draw/loss | 52.0% | 61.5% | 46.9% | 56.4% |
| **centipawn curve** | **61.0%** | **86.2%** | **58.7%** | **71.4%** |
| average of the two | 50.4% | 68.9% | 50.0% | 58.2% |

The reason is saturation. Past roughly two and a half pawns a strong engine
wins essentially every time, so win/draw/loss reports 100 and keeps reporting
100 however far ahead you get. Every move in a winning position then looks
identical, including the ones that threw half the advantage away, and the
scale has no resolution left exactly where a lot of real errors happen.

The same saturation made the **eval bar** useless: it pinned to one side at
about +2.5 and never moved again while the number beside it kept climbing.

| Evaluation | win/draw/loss bar | centipawn bar |
| --- | --- | --- |
| +1.00 | 78% | 59% |
| +2.50 | 100% | 72% |
| +4.00 | 100% | 81% |

So the classifier and the bar both use the fitted centipawn curve. Win/draw/loss
is still used for **volatility**, which is how drawish a position is, because
that is the right thing to weight accuracy by and it does not saturate in the
same damaging way.

### Three passes, so the comparison is fair and the verdicts stick

1. **Every position** is searched with MultiPV, giving the engine's choice and
   how close the alternatives were.
2. **Every played move pass 1 did not already score** gets its own search with
   `searchmoves`, at the same depth, in the same position.
3. **Every flagged move AND every borderline move is re-examined four plies
   deeper** before the verdict is shown. Flagged-only verification is a
   one-way ratchet: it can clear a false flag but can never recover an error
   the shallow pass under-measured, and under-measurement is systematic in
   already-bad positions, where the shallow search compresses the gap between
   the best defence and the move played (a depth-22 audit found real mistakes
   reading as loss 2-5 shallow and 7-11 deep). So moves whose loss lands just
   under the error threshold get the same deep re-check, and the deep numbers
   can add flags as well as remove them. Measured effect of verification:
   precision against Lichess's judgments went from 88.4% to 95.2%.

A depth-22 reference audit of the serious verdicts: **zero** shipped blunder,
mistake or miss calls were downgraded to non-errors at depth 22, and no
non-error ever became worse than inaccuracy. The remaining disagreement lives
in a plus-or-minus-2-point band around the inaccuracy threshold, where two
independent depth-22 searches disagree with each other as often as they
disagree with the shipped depth: that band is search noise, not a depth
ceiling, and no amount of extra depth settles it.

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
| **Great !** | The only move that held, where finding it was a real decision: every alternative gives up 10+ points, and it is not a recapture, a check evasion, or a position with fewer than five legal moves |
| **Best ★** | The engine's first choice, or level with it |
| **Excellent** | `loss` < 2 |
| **Good** | `loss` < 6 |
| **Inaccuracy ?!** | `loss` < 12 |
| **Mistake ?** | `loss` < 18 |
| **Miss ⨯** | You had a forced mate or a won position and kept less of it, while staying in the game (`loss` between 6 and 18) |
| **Blunder ??** | Everything worse. An outright collapse from a won position, a delivered stalemate included, is a Blunder however winning you were the move before |

Those thresholds are not round numbers picked by feel. They were swept against
Lichess's own judgments over 1419 plies of real games (`bench/tune.mjs`),
scoring each combination on how well it reproduces an outside opinion.

**Decided positions are exempt.** If the result is already settled both before
and after the move, nothing is graded as an error. This is the single largest
source of false blunders elsewhere: throwing away a second queen while still
mating is not the same mistake as losing a drawn game.

### Sacrifices

"Only move that does not lose" also describes most **recaptures**: if the
opponent takes your bishop, taking back is the only move that keeps material
and every alternative drops a piece. None of that makes it a great move. Left
unguarded, Great fired on 4.7% of all plies, roughly five times what it should
be; excluding recaptures, check evasions and near-forced positions brought it
to 1.5%.

Sacrifice detection uses **static exchange evaluation**, not a walk down the
engine's principal variation. Walking the line cannot work: in any capture
sequence you are transiently down material, so every recapture reads as a
sacrifice. SEE answers the real question, which is whether the material comes
back. On a Greek gift it reports exactly 230 centipawns invested, a bishop for
a pawn.

## Accuracy

Per-move accuracy is `103.1668 · e^(-0.04354 · loss) - 3.1669`, clamped to
0-100.

Game accuracy is **not** a plain mean. Following Lichess's published method,
each move is weighted by the local volatility of the win% series around it
(sliding-window standard deviation), and the weighted mean is combined with a
harmonic mean, which punishes the worst moves rather than letting them average
out.

Measured against the accuracy Lichess itself computes, over 32 games spanning
1027-3145 rated players: **mean absolute difference 2.3 points, median 1.6**
(1.6 in the 2200+ band). Average centipawn loss agrees with Lichess's own acpl
to a mean of 9.0cp, median 6.7. Two lessons the harness learned the hard way:
Lichess "From Position" games can start with Black to move, and assuming
white-first silently attributes every move to the wrong player; and acpl must
clamp evals to +/-1000 before differencing, or a mate score resolving to an
ordinary advantage reads as a 1000cp loss.

On per-ply error flags, precision is 95.2% and every Lichess flag we decline
turns out, after the deeper verification search, to cost under 6 expected-score
points (median 4). The recall number (63%) is mostly that disagreement:
Lichess flags small slips from a shallower pass; the deeper look says they
were fine.

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

An audit of 518 generated claims enforced three further rules:

- A move that merely **ties** with the engine's choice is never described as
  "the engine's first choice", and its explanation quotes the move's own
  continuation (from its `searchmoves` line), never the other move's PV.
- A **hanging** lead may only name a piece the move *newly* left takeable, and
  only when nothing in the reply line costs more: a stray pawn must not bury a
  fork that wins a rook.
- When the punishing reply is a capture, it is named by what it **takes**
  ("wins the queen"), not by the net material bucket ("wins a rook" because
  queen-minus-knight rounds to five points).
- A **stalemate** delivered from a winning position is called exactly that,
  drawn on the spot, with the mating line that was available.

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

## Credits

- Chess pieces: the Cburnett SVG set (Colin M.L. Burnett, CC-BY-SA / GFDL /
  BSD), as distributed by lichess. chess.com's own piece artwork is
  proprietary and is deliberately not copied; the board colours, arrow tones
  and badge palette match chess.com's default theme, which are plain colour
  values.
- Openings: the Lichess ECO dataset (CC0).
- Engine: Stockfish (GPL-3), see `vendor/LICENSE-NOTE.md`.

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
