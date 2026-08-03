# Game Review

A post-game chess analyser: load a game, get an evaluation bar, a verdict on
every move, and the line you should have played instead. Stockfish runs in a
Web Worker inside your browser — no server, no account, nothing uploaded.

**Live version: https://joshuakeum9-cell.github.io/chess-review/**

Built from scratch: the chess rules, the PGN parser, the board renderer and the
move-classification logic are all in this repo. The only outside component is
the Stockfish engine binary itself.

## Running it

The app uses ES modules, so it needs to be served over HTTP — opening
`index.html` straight off the disk will not work.

```bash
python -m http.server 8130
```

Then open http://localhost:8130.

### The engine

The WebAssembly build of Stockfish ships in `vendor/` (GPL-3, see
`vendor/LICENSE-NOTE.md`), so the app runs offline out of the box. Analysis is
**parallel**: a pool of engine workers — one per CPU core, capped at six —
each analyses a different position at the same time, which is what makes
whole-game analysis fast. If `vendor/` is missing the app falls back to a CDN
copy of the slower asm.js build; `npm run vendor` regenerates the local files.

### Tests

```bash
npm test
```

Runs perft against the standard reference positions — if those numbers match,
move generation is provably correct (castling, en passant, promotion, pins,
discovered check, the lot), plus a few SAN and PGN round-trip checks.

## Loading a game

- **Paste PGN** — anything copied out of Chess.com, Lichess, or a database.
- **Chess.com / Lichess** — type a username, get their 20 most recent public
  games straight from the site's own API.
- **Upload a .pgn file** — multi-game files give you a list to pick from.

## How a move gets its verdict

The cost of a move is the difference between what the engine wanted to play and
what you actually played. Getting that number right is the whole game, and it is
easy to get wrong, so the analysis runs in two passes:

1. **Every position** is searched to a fixed depth with the top four candidate
   moves scored.
2. **Every played move that pass 1 did not already score** gets its own
   targeted search, at the same depth, in the same position.

The point is that both numbers always come from *the same search of the same
position*. Comparing a position against the next one instead looks reasonable
but is quietly biased: the later position is effectively searched a ply deeper,
so ordinary moves come out looking like mistakes. Three rules keep the figures
honest:

- Candidate scores are only ever compared within one search iteration. The
  engine reports candidate 1 at depth 16 while candidate 3 is still at depth
  15, and mixing those is meaningless.
- Moves that tie with the engine's pick are marked **Best** too. Positions
  routinely have several equally good moves, and which one the engine lists
  first is arbitrary.
- The transposition table is cleared before each position, so the same game at
  the same depth always produces the same review. Without this, results depend
  on which worker happened to pick up which position.

The drop itself is measured in **expected score** (win %), not raw centipawns.
Losing 100 centipawns when you are already up a queen barely matters; losing 100
centipawns in a level position is serious. The conversion is the standard
sigmoid `50 + 50 * (2 / (1 + e^(-0.00368 · cp)) - 1)`.

With `wpl` = win percentage lost:

| Verdict | When |
| --- | --- |
| **Forced** | Only one legal move existed |
| **Book** | Still inside the bundled opening book |
| **Brilliant !!** | A sound sacrifice. You gave up at least 2 points of material in the engine's own line, `wpl` ≤ 2, and you are still fine afterwards |
| **Great !** | The only move that held: the second-best move loses at least 12% expected score *and* would have left you at 55% or worse. Being the top move while three others also win easily is just Best |
| **Best ★** | The engine's first choice |
| **Excellent** | `wpl` < 2 |
| **Good** | `wpl` < 5 |
| **Inaccuracy ?!** | `wpl` < 10 |
| **Mistake ?** | `wpl` < 20 |
| **Miss ⨯** | You had a forced mate or a winning position and gave it up |
| **Blunder ??** | Everything worse |

Accuracy per move is `103.1668 · e^(-0.04354 · wpl) - 3.1669`, clamped to
0–100; the per-side figure is the mean over that side's non-book moves. The
"est. performance" row is a coarse lookup from accuracy to a rating band — a
sanity check, not a rating system.

Sacrifices are detected using the engine's own principal variation rather than
guesswork: play the line out and check the material balance once it *settles*.
Measuring the worst point mid-line instead would flag every ordinary
capture-recapture as a sacrifice, since you are transiently down a piece in the
middle of one.

## Using the review

Analysis opens with a **Game Report** — accuracy per side, accuracy split by
opening / middlegame / endgame, the move-quality tally, and the two or three
**key moments** that decided the game (click one to jump straight to it).
**Start review** drops you into move one; the **Game Report** button brings the
card back any time.

- Click any move, or use **←** / **→**, **Home**, **End**.
- **f** flips the board.
- The from/to squares are tinted with the verdict's colour — a blunder turns
  them red, a brilliancy teal — and the badge pops on the destination square.
- The eval graph marks every mistake, miss and blunder; click it to jump there.
- On a bad move, **Retry** rewinds the board and makes you find the better move
  yourself. Any move within 2% of the engine's choice counts — if your attempt
  wasn't among the candidates the search already scored, it gets evaluated on
  the spot rather than assumed wrong, and you're told what it costs. Three
  misses gets you a hint.
- **Show me &lt;move&gt;** draws two arrows instead: green for what you should
  have played, blue for what you did.
- The **Engine lines** panel shows the top three candidate moves for the
  position on the board with their evaluations, so you can check a verdict
  rather than take it on trust. Click a line to play it out.
- Click any piece on the board to play a move yourself and ask the engine what
  it thinks, which is useful for "but what if I'd taken with the other rook?".
  **Back to game** returns you to the review.

## Depth and speed

Times below are for a 45-move game on a modern laptop (6 parallel WASM
workers). Longer games scale roughly linearly with the number of positions.

| Depth | Roughly | Good for |
| --- | --- | --- |
| 12 | ~5s per game | a quick skim |
| 16 | ~15s | the default: reliable verdicts on every real error |
| 20 | ~1 min | studying a serious game |
| 24 | ~5 min+ | correspondence, deep prep |

Depth matters for more than speed. At depth 12 the engine's idea of the best
move genuinely changes from move to move, so verdicts wobble; 16 is where they
settle down. Compare two reviews only if they were run at the same depth.

## Files

| File | What it does |
| --- | --- |
| `js/chess.js` | Board, legal move generation, SAN, FEN, PGN parsing |
| `js/engine.js` | Stockfish worker pool: N engines analysing N positions in parallel, UCI protocol, promise API |
| `js/review.js` | Evaluation → win %, move classification, accuracy, feedback text |
| `js/openings.js` | Opening book, used for naming and for "Book" moves |
| `js/board.js` | SVG board: pieces, arrows, highlights, badges |
| `js/app.js` | State, loading, rendering, keyboard, exploration mode |
| `test/perft.mjs` | Correctness tests for the rules engine |

## A note on scope

This analyses games that are **already finished**. It is deliberately not a
live overlay that sits on top of a game in progress — that is engine assistance,
and it will get you banned from every chess site there is. Reviewing your own
games afterwards is how you actually improve anyway.

## Ideas worth adding next

- Cache evaluations by FEN in `localStorage` so re-analysing is instant.
- A "blunder trainer" mode: chain the Retry drill across every mistake in the
  game (or across several games) instead of one move at a time.
- Tag recurring error patterns — hung pieces, missed forks, back-rank issues —
  by inspecting what the punishing reply actually does.
