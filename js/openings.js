/* openings.js — opening recognition against the Lichess ECO dataset.
 *
 * 3810 named openings, keyed by position rather than by move sequence. That
 * matters: the London System reached via 1.d4 d5 2.Bf4 and via 1.d4 Nf6 2.Nf3
 * g6 3.Bf4 is the same opening, and a move-prefix book only recognises the
 * order it happens to store. Position keys catch transpositions for free.
 */

import { OPENING_POSITIONS } from './opening-data.js?v=202608212106';

/* FNV-1a over the position-defining part of a FEN. Must match exactly the
 * hash used by scripts/build-openings.mjs. */
export function positionKey(fen) {
  const [board, turn, castling, ep] = fen.split(' ');
  const text = `${board} ${turn} ${castling} ${ep}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/* The book entry for a position, or null. */
export function lookupPosition(fen) {
  return OPENING_POSITIONS[positionKey(fen)] || null;
}

/* Walk the game and return the deepest opening it reached.
 * `fens` are the positions after each move, in order. */
export function identifyOpening(fens) {
  let best = { name: null, eco: null, plies: 0 };
  // Openings run out well before move 30 even in the deepest theory.
  const limit = Math.min(fens.length, 40);
  for (let i = 0; i < limit; i++) {
    const hit = OPENING_POSITIONS[positionKey(fens[i])];
    if (hit) best = { name: hit.n, eco: hit.e, plies: i + 1 };
  }
  return best;
}

/* How far theory extends in this game: the last ply whose resulting position
 * is still a named opening. Moves up to that point are "Book".
 *
 * A single gap is tolerated because the dataset names positions, not every
 * position along every line, so a known line can briefly pass through an
 * unnamed position before rejoining theory. */
export function bookDepth(fens) {
  let last = 0;
  let gap = 0;
  const limit = Math.min(fens.length, 40);
  for (let i = 0; i < limit; i++) {
    if (OPENING_POSITIONS[positionKey(fens[i])]) {
      last = i + 1;
      gap = 0;
    } else if (++gap > 2) {
      break;
    }
  }
  return last;
}

export const OPENING_COUNT = Object.keys(OPENING_POSITIONS).length;
