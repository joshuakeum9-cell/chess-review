/* chess.js — self-contained chess rules engine (0x88 board representation).
 * No dependencies. Handles legal move generation, SAN, FEN, and PGN parsing.
 * Validated with perft in test/perft.mjs.
 */

export const WHITE = 'w';
export const BLACK = 'b';

export const PAWN = 'p';
export const KNIGHT = 'n';
export const BISHOP = 'b';
export const ROOK = 'r';
export const QUEEN = 'q';
export const KING = 'k';

export const DEFAULT_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export const FLAGS = {
  NORMAL: 1,
  CAPTURE: 2,
  BIG_PAWN: 4,
  EP_CAPTURE: 8,
  PROMOTION: 16,
  KSIDE_CASTLE: 32,
  QSIDE_CASTLE: 64,
};

const PAWN_OFFSETS = {
  w: [-16, -32, -17, -15],
  b: [16, 32, 17, 15],
};

const PIECE_OFFSETS = {
  n: [-18, -33, -31, -14, 18, 33, 31, 14],
  b: [-17, -15, 17, 15],
  r: [-16, 1, 16, -1],
  q: [-17, -16, -15, 1, 17, 16, 15, -1],
  k: [-17, -16, -15, 1, 17, 16, 15, -1],
};

const SLIDING = { b: true, r: true, q: true };

// Corner squares that carry castling rights.
const ROOK_SQUARES = {
  w: [
    { square: 119, flag: FLAGS.KSIDE_CASTLE }, // h1
    { square: 112, flag: FLAGS.QSIDE_CASTLE }, // a1
  ],
  b: [
    { square: 7, flag: FLAGS.KSIDE_CASTLE }, // h8
    { square: 0, flag: FLAGS.QSIDE_CASTLE }, // a8
  ],
};

export function file(sq) {
  return sq & 15;
}
export function rank(sq) {
  return sq >> 4;
}
export function algebraic(sq) {
  return 'abcdefgh'[file(sq)] + (8 - rank(sq));
}
export function fromAlgebraic(s) {
  const f = 'abcdefgh'.indexOf(s[0]);
  const r = 8 - parseInt(s[1], 10);
  if (f < 0 || r < 0 || r > 7) return -1;
  return r * 16 + f;
}
function swapColor(c) {
  return c === WHITE ? BLACK : WHITE;
}

export class Chess {
  constructor(fen = DEFAULT_FEN) {
    this.load(fen);
  }

  load(fen) {
    const parts = fen.trim().split(/\s+/);
    this.board = new Array(128).fill(null);
    this.kings = { w: -1, b: -1 };
    this.castling = { w: 0, b: 0 };
    this.history = [];

    let sq = 0;
    for (const ch of parts[0]) {
      if (ch === '/') {
        sq += 8;
      } else if (/[1-8]/.test(ch)) {
        sq += parseInt(ch, 10);
      } else {
        const color = ch === ch.toUpperCase() ? WHITE : BLACK;
        const type = ch.toLowerCase();
        this.board[sq] = { type, color };
        if (type === KING) this.kings[color] = sq;
        sq++;
      }
    }

    this.turn = parts[1] === 'b' ? BLACK : WHITE;

    const rights = parts[2] || '-';
    if (rights.includes('K')) this.castling.w |= FLAGS.KSIDE_CASTLE;
    if (rights.includes('Q')) this.castling.w |= FLAGS.QSIDE_CASTLE;
    if (rights.includes('k')) this.castling.b |= FLAGS.KSIDE_CASTLE;
    if (rights.includes('q')) this.castling.b |= FLAGS.QSIDE_CASTLE;

    this.epSquare = parts[3] && parts[3] !== '-' ? fromAlgebraic(parts[3]) : -1;
    this.halfMoves = parseInt(parts[4], 10) || 0;
    this.moveNumber = parseInt(parts[5], 10) || 1;
    return this;
  }

  fen() {
    let empty = 0;
    let str = '';
    for (let i = 0; i <= 119; i++) {
      if (i & 0x88) {
        if (empty > 0) {
          str += empty;
          empty = 0;
        }
        if (i !== 7) str += '/';
        i += 7;
        continue;
      }
      const piece = this.board[i];
      if (!piece) {
        empty++;
      } else {
        if (empty > 0) {
          str += empty;
          empty = 0;
        }
        str +=
          piece.color === WHITE
            ? piece.type.toUpperCase()
            : piece.type.toLowerCase();
      }
    }

    let rights = '';
    if (this.castling.w & FLAGS.KSIDE_CASTLE) rights += 'K';
    if (this.castling.w & FLAGS.QSIDE_CASTLE) rights += 'Q';
    if (this.castling.b & FLAGS.KSIDE_CASTLE) rights += 'k';
    if (this.castling.b & FLAGS.QSIDE_CASTLE) rights += 'q';

    const ep = this.epSquare === -1 ? '-' : algebraic(this.epSquare);
    return [
      str,
      this.turn,
      rights || '-',
      ep,
      this.halfMoves,
      this.moveNumber,
    ].join(' ');
  }

  get(square) {
    const sq = typeof square === 'string' ? fromAlgebraic(square) : square;
    return this.board[sq] || null;
  }

  /* Board as 8 rows of 8, index 0 = rank 8. Each cell null or {type,color,square}. */
  boardArray() {
    const rows = [];
    for (let r = 0; r < 8; r++) {
      const row = [];
      for (let f = 0; f < 8; f++) {
        const sq = r * 16 + f;
        const p = this.board[sq];
        row.push(p ? { ...p, square: algebraic(sq) } : null);
      }
      rows.push(row);
    }
    return rows;
  }

  _addMove(moves, from, to, flags) {
    const piece = this.board[from];
    const targetRank = rank(to);
    if (piece.type === PAWN && (targetRank === 0 || targetRank === 7)) {
      for (const promo of [QUEEN, ROOK, BISHOP, KNIGHT]) {
        moves.push(this._buildMove(from, to, flags | FLAGS.PROMOTION, promo));
      }
    } else {
      moves.push(this._buildMove(from, to, flags, null));
    }
  }

  _buildMove(from, to, flags, promotion) {
    const move = {
      color: this.turn,
      from,
      to,
      piece: this.board[from].type,
      flags,
    };
    if (promotion) move.promotion = promotion;
    if (flags & FLAGS.EP_CAPTURE) move.captured = PAWN;
    else if (this.board[to]) move.captured = this.board[to].type;
    return move;
  }

  /* True if `byColor` attacks `sq`. */
  _attacked(byColor, sq) {
    for (const off of PIECE_OFFSETS.n) {
      const t = sq + off;
      if (t & 0x88) continue;
      const p = this.board[t];
      if (p && p.color === byColor && p.type === KNIGHT) return true;
    }

    for (const off of PIECE_OFFSETS.q) {
      let t = sq + off;
      let dist = 1;
      while (!(t & 0x88)) {
        const p = this.board[t];
        if (p) {
          if (p.color === byColor) {
            const diagonal =
              off === -17 || off === -15 || off === 17 || off === 15;
            if (p.type === QUEEN) return true;
            if (diagonal && p.type === BISHOP) return true;
            if (!diagonal && p.type === ROOK) return true;
            if (dist === 1) {
              if (p.type === KING) return true;
              if (p.type === PAWN && diagonal) {
                // A white pawn on sq+17 or sq+15 attacks sq.
                if (byColor === WHITE && (off === 17 || off === 15)) return true;
                if (byColor === BLACK && (off === -17 || off === -15))
                  return true;
              }
            }
          }
          break;
        }
        t += off;
        dist++;
      }
    }
    return false;
  }

  inCheck() {
    return this._attacked(swapColor(this.turn), this.kings[this.turn]);
  }

  /* Every piece of `byColor` that attacks `square`, as
   * [{ type, square, value }] sorted cheapest first. Used by the static
   * exchange evaluation that decides whether a move is really a sacrifice.
   * Ignores pins, which is the standard simplification for SEE. */
  attackersOf(square, byColor) {
    const sq = typeof square === 'string' ? fromAlgebraic(square) : square;
    const found = [];

    for (const off of PIECE_OFFSETS.n) {
      const t = sq + off;
      if (t & 0x88) continue;
      const p = this.board[t];
      if (p && p.color === byColor && p.type === KNIGHT) {
        found.push({ type: KNIGHT, square: t });
      }
    }

    for (const off of PIECE_OFFSETS.q) {
      let t = sq + off;
      let dist = 1;
      while (!(t & 0x88)) {
        const p = this.board[t];
        if (p) {
          if (p.color === byColor) {
            const diagonal = off === -17 || off === -15 || off === 17 || off === 15;
            const slides =
              p.type === QUEEN ||
              (diagonal && p.type === BISHOP) ||
              (!diagonal && p.type === ROOK);
            if (slides) {
              found.push({ type: p.type, square: t });
            } else if (dist === 1) {
              if (p.type === KING) found.push({ type: KING, square: t });
              else if (p.type === PAWN && diagonal) {
                const attacksThisWay =
                  byColor === WHITE ? off === 17 || off === 15 : off === -17 || off === -15;
                if (attacksThisWay) found.push({ type: PAWN, square: t });
              }
            }
          }
          break;
        }
        t += off;
        dist++;
      }
    }

    const value = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };
    return found
      .map((f) => ({ ...f, value: value[f.type] }))
      .sort((a, b) => a.value - b.value);
  }

  _generateMoves({ legal = true, square = null } = {}) {
    const us = this.turn;
    const them = swapColor(us);
    const moves = [];

    let first = 0;
    let last = 119;
    const single = square != null;
    if (single) {
      const sq = typeof square === 'string' ? fromAlgebraic(square) : square;
      first = last = sq;
    }

    for (let i = first; i <= last; i++) {
      if (i & 0x88) {
        i += 7;
        continue;
      }
      const piece = this.board[i];
      if (!piece || piece.color !== us) continue;

      if (piece.type === PAWN) {
        const offs = PAWN_OFFSETS[us];
        const to = i + offs[0];
        if (!(to & 0x88) && !this.board[to]) {
          this._addMove(moves, i, to, FLAGS.NORMAL);
          const startRank = us === WHITE ? 6 : 1;
          if (rank(i) === startRank) {
            const to2 = i + offs[1];
            if (!this.board[to2]) this._addMove(moves, i, to2, FLAGS.BIG_PAWN);
          }
        }
        for (let j = 2; j < 4; j++) {
          const t = i + offs[j];
          if (t & 0x88) continue;
          const tp = this.board[t];
          if (tp) {
            if (tp.color === them) this._addMove(moves, i, t, FLAGS.CAPTURE);
          } else if (t === this.epSquare) {
            this._addMove(moves, i, t, FLAGS.EP_CAPTURE);
          }
        }
      } else {
        for (const off of PIECE_OFFSETS[piece.type]) {
          let t = i;
          for (;;) {
            t += off;
            if (t & 0x88) break;
            const tp = this.board[t];
            if (!tp) {
              this._addMove(moves, i, t, FLAGS.NORMAL);
            } else {
              if (tp.color === them) this._addMove(moves, i, t, FLAGS.CAPTURE);
              break;
            }
            if (!SLIDING[piece.type]) break;
          }
        }
      }
    }

    const kingSq = this.kings[us];
    if (kingSq !== -1 && (!single || first === kingSq)) {
      if (this.castling[us] & FLAGS.KSIDE_CASTLE) {
        const to = kingSq + 2;
        if (
          !this.board[kingSq + 1] &&
          !this.board[to] &&
          !this._attacked(them, kingSq) &&
          !this._attacked(them, kingSq + 1) &&
          !this._attacked(them, to)
        ) {
          this._addMove(moves, kingSq, to, FLAGS.KSIDE_CASTLE);
        }
      }
      if (this.castling[us] & FLAGS.QSIDE_CASTLE) {
        const to = kingSq - 2;
        if (
          !this.board[kingSq - 1] &&
          !this.board[kingSq - 2] &&
          !this.board[kingSq - 3] &&
          !this._attacked(them, kingSq) &&
          !this._attacked(them, kingSq - 1) &&
          !this._attacked(them, to)
        ) {
          this._addMove(moves, kingSq, to, FLAGS.QSIDE_CASTLE);
        }
      }
    }

    if (!legal) return moves;

    const legalMoves = [];
    for (const move of moves) {
      this._makeMove(move);
      if (!this._attacked(swapColor(us), this.kings[us])) legalMoves.push(move);
      this._undoMove();
    }
    return legalMoves;
  }

  /* moves({verbose}) -> SAN strings, or objects with .san/.from/.to/.promotion */
  moves({ verbose = false, square = null } = {}) {
    const raw = this._generateMoves({ legal: true, square });
    if (!verbose) return raw.map((m) => this._moveToSan(m, raw));
    return raw.map((m) => this._decorate(m, raw));
  }

  _decorate(move, allMoves) {
    return {
      ...move,
      san: this._moveToSan(move, allMoves),
      fromSquare: algebraic(move.from),
      toSquare: algebraic(move.to),
      uci:
        algebraic(move.from) +
        algebraic(move.to) +
        (move.promotion ? move.promotion : ''),
    };
  }

  /* Accepts SAN ('Nf3'), UCI ('g1f3'), or {from,to,promotion}. Returns the
   * decorated move, or null if illegal. */
  move(input) {
    const candidates = this._generateMoves({ legal: true });
    let chosen = null;

    if (typeof input === 'string') {
      const clean = input.replace(/[+#?!]+$/, '').replace(/0/g, 'O');
      for (const m of candidates) {
        if (this._moveToSan(m, candidates).replace(/[+#]/g, '') === clean) {
          chosen = m;
          break;
        }
      }
      if (!chosen && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(input)) {
        const from = fromAlgebraic(input.slice(0, 2));
        const to = fromAlgebraic(input.slice(2, 4));
        const promo = input[4] || null;
        chosen =
          candidates.find(
            (m) =>
              m.from === from &&
              m.to === to &&
              (!m.promotion || m.promotion === (promo || 'q'))
          ) || null;
      }
    } else if (input && typeof input === 'object') {
      const from =
        typeof input.from === 'string' ? fromAlgebraic(input.from) : input.from;
      const to =
        typeof input.to === 'string' ? fromAlgebraic(input.to) : input.to;
      chosen =
        candidates.find(
          (m) =>
            m.from === from &&
            m.to === to &&
            (!m.promotion || m.promotion === (input.promotion || 'q'))
        ) || null;
    }

    if (!chosen) return null;
    const decorated = this._decorate(chosen, candidates);
    this._makeMove(chosen);
    return decorated;
  }

  _makeMove(move) {
    const us = move.color;
    const them = swapColor(us);

    this.history.push({
      move,
      kings: { ...this.kings },
      turn: this.turn,
      castling: { ...this.castling },
      epSquare: this.epSquare,
      halfMoves: this.halfMoves,
      moveNumber: this.moveNumber,
      captured: this.board[move.to],
    });

    this.board[move.to] = this.board[move.from];
    this.board[move.from] = null;

    if (move.flags & FLAGS.EP_CAPTURE) {
      const capturedSquare = us === WHITE ? move.to + 16 : move.to - 16;
      this.board[capturedSquare] = null;
      this.history[this.history.length - 1].epCapturedSquare = capturedSquare;
    }

    if (move.flags & FLAGS.PROMOTION) {
      this.board[move.to] = { type: move.promotion, color: us };
    }

    if (this.board[move.to].type === KING) {
      this.kings[us] = move.to;
      if (move.flags & FLAGS.KSIDE_CASTLE) {
        this.board[move.to - 1] = this.board[move.to + 1];
        this.board[move.to + 1] = null;
      } else if (move.flags & FLAGS.QSIDE_CASTLE) {
        this.board[move.to + 1] = this.board[move.to - 2];
        this.board[move.to - 2] = null;
      }
      this.castling[us] = 0;
    }

    for (const r of ROOK_SQUARES[us]) {
      if (this.castling[us] & r.flag && move.from === r.square) {
        this.castling[us] &= ~r.flag;
      }
    }
    for (const r of ROOK_SQUARES[them]) {
      if (this.castling[them] & r.flag && move.to === r.square) {
        this.castling[them] &= ~r.flag;
      }
    }

    this.epSquare =
      move.flags & FLAGS.BIG_PAWN
        ? us === WHITE
          ? move.to + 16
          : move.to - 16
        : -1;

    if (move.piece === PAWN || move.flags & (FLAGS.CAPTURE | FLAGS.EP_CAPTURE)) {
      this.halfMoves = 0;
    } else {
      this.halfMoves++;
    }
    if (us === BLACK) this.moveNumber++;
    this.turn = them;
  }

  _undoMove() {
    const old = this.history.pop();
    if (!old) return null;
    const move = old.move;

    this.kings = old.kings;
    this.turn = old.turn;
    this.castling = old.castling;
    this.epSquare = old.epSquare;
    this.halfMoves = old.halfMoves;
    this.moveNumber = old.moveNumber;

    const us = move.color;

    this.board[move.from] = this.board[move.to];
    this.board[move.from].type = move.piece; // undo promotion
    this.board[move.to] = old.captured || null;

    if (move.flags & FLAGS.EP_CAPTURE) {
      this.board[move.to] = null;
      this.board[old.epCapturedSquare] = { type: PAWN, color: swapColor(us) };
    }

    if (move.flags & FLAGS.KSIDE_CASTLE) {
      this.board[move.to + 1] = this.board[move.to - 1];
      this.board[move.to - 1] = null;
    } else if (move.flags & FLAGS.QSIDE_CASTLE) {
      this.board[move.to - 2] = this.board[move.to + 1];
      this.board[move.to + 1] = null;
    }
    return move;
  }

  undo() {
    return this._undoMove();
  }

  _disambiguator(move, moves) {
    let ambiguous = 0;
    let sameFile = 0;
    let sameRank = 0;

    for (const m of moves) {
      if (
        m.piece === move.piece &&
        m.from !== move.from &&
        m.to === move.to
      ) {
        ambiguous++;
        if (rank(move.from) === rank(m.from)) sameRank++;
        if (file(move.from) === file(m.from)) sameFile++;
      }
    }
    if (!ambiguous) return '';
    const from = algebraic(move.from);
    if (sameRank > 0 && sameFile > 0) return from;
    if (sameFile > 0) return from[1];
    return from[0];
  }

  _moveToSan(move, moves) {
    let san;
    if (move.flags & FLAGS.KSIDE_CASTLE) {
      san = 'O-O';
    } else if (move.flags & FLAGS.QSIDE_CASTLE) {
      san = 'O-O-O';
    } else {
      san = '';
      if (move.piece !== PAWN) {
        san += move.piece.toUpperCase() + this._disambiguator(move, moves);
      }
      if (move.flags & (FLAGS.CAPTURE | FLAGS.EP_CAPTURE)) {
        if (move.piece === PAWN) san += algebraic(move.from)[0];
        san += 'x';
      }
      san += algebraic(move.to);
      if (move.flags & FLAGS.PROMOTION) san += '=' + move.promotion.toUpperCase();
    }

    this._makeMove(move);
    if (this.inCheck()) {
      san += this._generateMoves({ legal: true }).length === 0 ? '#' : '+';
    }
    this._undoMove();
    return san;
  }

  isCheckmate() {
    return this.inCheck() && this._generateMoves({ legal: true }).length === 0;
  }
  isStalemate() {
    return !this.inCheck() && this._generateMoves({ legal: true }).length === 0;
  }

  isInsufficientMaterial() {
    const counts = {};
    const bishops = [];
    let total = 0;
    for (let i = 0; i <= 119; i++) {
      if (i & 0x88) {
        i += 7;
        continue;
      }
      const p = this.board[i];
      if (!p) continue;
      total++;
      counts[p.type] = (counts[p.type] || 0) + 1;
      if (p.type === BISHOP) bishops.push((rank(i) + file(i)) % 2);
    }
    if (total === 2) return true; // K vs K
    if (total === 3 && (counts[BISHOP] === 1 || counts[KNIGHT] === 1))
      return true;
    if (total - 2 === counts[BISHOP] && counts[BISHOP] > 1) {
      return bishops.every((c) => c === bishops[0]); // same-colour bishops
    }
    return false;
  }

  isDraw() {
    return (
      this.halfMoves >= 100 || this.isStalemate() || this.isInsufficientMaterial()
    );
  }
  isGameOver() {
    return this.isCheckmate() || this.isDraw();
  }

  clone() {
    return new Chess(this.fen());
  }
}

/* ------------------------------------------------------------------ */
/* PGN                                                                 */
/* ------------------------------------------------------------------ */

/* Splits a multi-game PGN blob into individual game strings. */
export function splitPgnGames(text) {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];
  const games = [];
  let current = [];
  let seenMoves = false;
  for (const line of normalized.split('\n')) {
    const isHeader = /^\s*\[\s*\w+\s+"/.test(line);
    if (isHeader && seenMoves) {
      games.push(current.join('\n'));
      current = [];
      seenMoves = false;
    }
    if (!isHeader && line.trim()) seenMoves = true;
    current.push(line);
  }
  if (current.length) games.push(current.join('\n'));
  return games.map((g) => g.trim()).filter(Boolean);
}

function stripVariations(text) {
  let out = '';
  let depth = 0;
  for (const ch of text) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  return out;
}

/* Parses one PGN game into { headers, moves:[{san, fen, uci, ...}], result }. */
export function parsePgn(pgnText) {
  const text = pgnText.replace(/\r\n?/g, '\n');
  const headers = {};
  const headerRe = /\[\s*(\w+)\s+"([^"]*)"\s*\]/g;
  let m;
  while ((m = headerRe.exec(text)) !== null) headers[m[1]] = m[2];

  let body = text.replace(headerRe, '');
  body = body.replace(/\{[^}]*\}/g, ' '); // comments
  body = body.replace(/;[^\n]*/g, ' '); // rest-of-line comments
  body = stripVariations(body);
  body = body.replace(/\$\d+/g, ' '); // NAGs
  body = body.replace(/\d+\s*\.(\.\.)?/g, ' '); // move numbers
  body = body.replace(/\b(1-0|0-1|1\/2-1\/2|\*)\b/g, ' ');

  const startFen = headers.FEN && headers.SetUp !== '0' ? headers.FEN : DEFAULT_FEN;
  const game = new Chess(startFen);
  const moves = [];
  const tokens = body.split(/\s+/).filter((t) => t && /[a-zA-Z]/.test(t));

  for (const token of tokens) {
    const san = token.replace(/[!?]+$/, '');
    const before = game.fen();
    const made = game.move(san);
    if (!made) {
      throw new Error(
        `Could not play "${token}" at move ${moves.length + 1}. ` +
          `Check that the PGN is valid.`
      );
    }
    moves.push({
      san: made.san,
      uci: made.uci,
      color: made.color,
      from: made.fromSquare,
      to: made.toSquare,
      piece: made.piece,
      captured: made.captured || null,
      fenBefore: before,
      fenAfter: game.fen(),
      ply: moves.length + 1,
    });
  }

  return {
    headers,
    moves,
    startFen,
    result: headers.Result || '*',
  };
}
