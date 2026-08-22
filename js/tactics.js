/* tactics.js — what actually happened on the board.
 *
 * The evaluation tells you a move was bad. It does not tell you why, and "this
 * loses 18% of your expected score" is not coaching. This module reads the
 * position for the concrete things a player would want named: what got left
 * hanging, what fork appeared, whose king is suddenly bare. Everything here is
 * derived from the board, never asserted, so an explanation can only claim
 * what is actually there.
 */

import { Chess, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING } from './chess.js?v=202608220307';
import { staticExchange, PIECE_VALUES } from './classify.js?v=202608220307';

export const PIECE_NAMES = {
  p: 'pawn',
  n: 'knight',
  b: 'bishop',
  r: 'rook',
  q: 'queen',
  k: 'king',
};

const other = (c) => (c === 'w' ? 'b' : 'w');

/* Plain facts about a move, read from the position it was played in. */
export function moveFacts(fenBefore, uci) {
  const board = new Chess(fenBefore);
  const legal = board.moves({ verbose: true }).find((m) => m.uci === uci);
  if (!legal) return null;

  const mover = board.turn;
  const captured = board.get(legal.toSquare);
  const after = new Chess(fenBefore);
  after.move(uci);

  return {
    san: legal.san,
    from: legal.fromSquare,
    to: legal.toSquare,
    piece: legal.piece,
    pieceName: PIECE_NAMES[legal.piece],
    mover,
    isCapture: !!captured || !!(legal.flags & 8),
    capturedName: captured ? PIECE_NAMES[captured.type] : null,
    isPromotion: !!legal.promotion,
    isCastle: !!(legal.flags & 96),
    givesCheck: after.inCheck(),
    givesMate: after.isCheckmate(),
    fenAfter: after.fen(),
  };
}

/* Pieces of `color` the opponent can win material on, as judged by static
 * exchange. This is what "hanging" actually means: not merely attacked, but
 * attacked profitably. */
export function hangingPieces(fen, color) {
  const board = new Chess(fen);
  const enemy = other(color);
  const out = [];

  for (const row of board.boardArray()) {
    for (const cell of row) {
      if (!cell || cell.color !== color || cell.type === KING) continue;
      const gain = staticExchange(board, cell.square, enemy);
      if (gain > 0) {
        out.push({
          square: cell.square,
          type: cell.type,
          name: PIECE_NAMES[cell.type],
          value: PIECE_VALUES[cell.type],
          gain,
        });
      }
    }
  }
  return out.sort((a, b) => b.gain - a.gain);
}

/* Does the piece on `square` attack two or more things worth winning?
 * A check plus any loose piece counts, which is the shape of most forks. */
export function forkTargets(fen, square) {
  const board = new Chess(fen);
  const piece = board.get(square);
  if (!piece) return [];

  const enemy = other(piece.color);
  const targets = [];

  for (const row of board.boardArray()) {
    for (const cell of row) {
      if (!cell || cell.color !== enemy) continue;
      // Is `square` among the attackers of this enemy piece?
      const attackers = board.attackersOf(cell.square, piece.color);
      if (!attackers.some((a) => squareName(a.square) === square)) continue;
      if (cell.type === KING) {
        targets.push({ square: cell.square, type: cell.type, name: 'king', value: 0 });
      } else if (PIECE_VALUES[cell.type] >= PIECE_VALUES[piece.type] || isLoose(board, cell)) {
        targets.push({
          square: cell.square,
          type: cell.type,
          name: PIECE_NAMES[cell.type],
          value: PIECE_VALUES[cell.type],
        });
      }
    }
  }
  return targets.length >= 2 ? targets : [];
}

function isLoose(board, cell) {
  return board.attackersOf(cell.square, cell.color).length === 0;
}

function squareName(index) {
  return 'abcdefgh'[index & 15] + (8 - (index >> 4));
}

/* Is this side's back rank a mating risk: king on its home rank, boxed in by
 * its own pawns, with no rook or queen guarding the rank. */
export function backRankRisk(fen, color) {
  const board = new Chess(fen);
  const rank = color === 'w' ? 1 : 8;
  const kingSq = board.kings[color];
  if (kingSq === -1) return false;
  const kingName = squareName(kingSq);
  if (Number(kingName[1]) !== rank) return false;

  const file = 'abcdefgh'.indexOf(kingName[0]);
  if (file < 4) return false; // castled kingside is the usual case

  const forwardRank = color === 'w' ? 2 : 7;
  let escapes = 0;
  for (const f of [file - 1, file, file + 1]) {
    if (f < 0 || f > 7) continue;
    const sq = 'abcdefgh'[f] + forwardRank;
    if (!board.get(sq)) escapes++;
  }
  return escapes === 0;
}

/* Material balance for `color`, in centipawns. */
export function materialBalance(fen, color) {
  const board = new Chess(fen);
  let mine = 0;
  let theirs = 0;
  for (const row of board.boardArray()) {
    for (const cell of row) {
      if (!cell || cell.type === KING) continue;
      if (cell.color === color) mine += PIECE_VALUES[cell.type];
      else theirs += PIECE_VALUES[cell.type];
    }
  }
  return mine - theirs;
}

/* The material swing a line produces for `mover`, in centipawns. */
export function materialSwing(fen, pvUci, mover, plies = 8) {
  const board = new Chess(fen);
  const before = materialBalance(board.fen(), mover);
  let played = 0;
  for (const uci of pvUci.slice(0, plies)) {
    if (!board.move(uci)) break;
    played++;
  }
  return { delta: materialBalance(board.fen(), mover) - before, plies: played };
}

/* Turn a UCI line into readable SAN, stopping cleanly if it goes illegal. */
export function lineToSan(fen, pvUci, limit = 6) {
  const board = new Chess(fen);
  const out = [];
  for (const uci of pvUci.slice(0, limit)) {
    const made = board.move(uci);
    if (!made) break;
    out.push(made.san);
  }
  return out;
}

/* Number the moves in a line the way a player reads them: "23. Qf6+ Nxf6". */
export function formatLine(fen, sans) {
  if (!sans.length) return '';
  const board = new Chess(fen);
  const parts = [];
  let number = board.moveNumber;
  let white = board.turn === 'w';
  sans.forEach((san, i) => {
    if (white) parts.push(`${number}. ${san}`);
    else if (i === 0) parts.push(`${number}... ${san}`);
    else parts.push(san);
    if (!white) number++;
    white = !white;
  });
  return parts.join(' ');
}
