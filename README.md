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

### Optional: run fully offline

By default Stockfish is pulled from a CDN the first time you analyse. To bundle
it locally instead (also a good deal faster, since the local copy is the
WebAssembly build rather than asm.js):

```bash
npm run vendor
```

That drops `stockfish.wasm.js` + `stockfish.wasm` into `vendor/`, which the app
prefers automatically on the next load.

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

Every position in the game is evaluated once at a fixed depth. Position *i* is
"before move *i*"; position *i+1* is "after". The cost of a move is the drop
between those two numbers.

That drop is measured in **expected score** (win %), not raw centipawns. Losing
100 centipawns when you are already up a queen barely matters; losing 100
centipawns in a level position is serious. The conversion is the standard
sigmoid `50 + 50 * (2 / (1 + e^(-0.00368 · cp)) - 1)`.

With `wpl` = win percentage lost:

| Verdict | When |
| --- | --- |
| **Forced** | Only one legal move existed |
| **Book** | Still inside the bundled opening book |
| **Brilliant !!** | A sound sacrifice — you gave up ≥ 2 points of material in the engine's own line, `wpl` ≤ 2, and you are still fine afterwards |
| **Great !** | The only move that held; the second-best move loses ≥ 12% expected score |
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
guesswork: play the best line out eight plies and see whether you end up down
material while the evaluation still says you are fine.

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
  yourself — any move within 2% of the engine's choice counts, and after three
  misses you get a hint.
- **Show me &lt;move&gt;** draws two arrows instead: green for what you should
  have played, blue for what you did.
- Click any piece on the board to play a move yourself and ask the engine what
  it thinks — useful for "but what if I'd taken with the other rook?". **Back
  to game** returns you to the review.

## Depth and speed

| Depth | Roughly | Good for |
| --- | --- | --- |
| 10 | ~30s per game | a quick skim |
| 14 | ~1-2 min | normal review, catches all real blunders |
| 18 | ~4-6 min | studying a serious game |
| 22 | ~15 min+ | correspondence, deep prep |

Times are for the CDN asm.js build. Run `npm run vendor` and everything gets
roughly three to five times faster.

## Files

| File | What it does |
| --- | --- |
| `js/chess.js` | Board, legal move generation, SAN, FEN, PGN parsing |
| `js/engine.js` | Stockfish Web Worker, UCI protocol, promise API |
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
