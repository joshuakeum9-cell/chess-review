/* board.js — SVG chessboard: pieces with movement animation, drag-to-move,
 * engine arrows (L-shaped for knight moves), user-drawn arrows and square
 * highlights (right-click, chess.com conventions), and the classification
 * badge that pops on the square you just moved to. */

import { Chess } from './chess.js?v=202608212125';
import { chipSvg, classColor } from './icons.js?v=202608212125';

const SIZE = 100; // one square in SVG user units
const FILES = 'abcdefgh';

/* Fallback glyphs for the unlikely case the piece images fail to load. */
const GLYPHS = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };

/* Standard open-licensed piece set (Cburnett, via lichess; see README). */
const PIECE_SRC = (color, type) => `assets/pieces/${color}${type.toUpperCase()}.svg`;

/* User-drawn marks, matching chess.com's conventions: right-click drag draws
 * an orange arrow, right-click on one square paints it red, left click
 * clears everything. */
const USER_ARROW_FILL = 'rgba(255, 170, 0, 0.8)';
const USER_HIGHLIGHT_FILL = 'rgba(235, 97, 80, 0.8)';

const ANIM_MS = 140;

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/* Is from->to a knight-shaped jump? */
function isKnightOffset(from, to) {
  const df = Math.abs(FILES.indexOf(to[0]) - FILES.indexOf(from[0]));
  const dr = Math.abs(Number(to[1]) - Number(from[1]));
  return (df === 1 && dr === 2) || (df === 2 && dr === 1);
}

/* A drawable arrow shape: straight lines, diagonals, and knight jumps only.
 * Anything else (a 3,1 offset, say) is not a chess line and is refused. */
function isDrawableShape(from, to) {
  const df = Math.abs(FILES.indexOf(to[0]) - FILES.indexOf(from[0]));
  const dr = Math.abs(Number(to[1]) - Number(from[1]));
  if (df === 0 && dr === 0) return false;
  return df === 0 || dr === 0 || df === dr || isKnightOffset(from, to);
}

export class BoardView {
  constructor(container, { onSquareClick, onDragMove, onUserMark } = {}) {
    this.container = container;
    this.flipped = false;
    this.position = new Chess();
    this.lastMove = null;
    this.badge = null;
    this.arrows = [];
    this.selected = null;
    this.checkSquare = null;
    this.onSquareClick = onSquareClick;
    this.onDragMove = onDragMove;
    this.onUserMark = onUserMark;

    this.userArrows = []; // [{from, to}]
    this.userHighlights = new Set(); // square names

    this.svg = el('svg', {
      viewBox: `0 0 ${SIZE * 8} ${SIZE * 8}`,
      class: 'board-svg',
    });
    this.squareLayer = el('g');
    this.markLayer = el('g');
    this.userMarkLayer = el('g');
    this.pieceLayer = el('g');
    this.arrowLayer = el('g', { class: 'arrow-layer' });
    this.userArrowLayer = el('g');
    this.previewLayer = el('g');
    this.badgeLayer = el('g');
    this.svg.append(
      this.squareLayer,
      this.markLayer,
      this.userMarkLayer,
      this.pieceLayer,
      this.arrowLayer,
      this.userArrowLayer,
      this.previewLayer,
      this.badgeLayer
    );

    container.innerHTML = '';
    container.append(this.svg);

    this._drag = null; // left-drag state
    this._rightDrag = null; // right-drag state
    this._bindPointerEvents();

    this._drawSquares();
  }

  /* ---------------------------------------------------------------- */
  /* geometry                                                          */
  /* ---------------------------------------------------------------- */

  _squareFromPoint(clientX, clientY) {
    const rect = this.svg.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 8;
    const y = ((clientY - rect.top) / rect.height) * 8;
    if (x < 0 || x >= 8 || y < 0 || y >= 8) return null;
    let f = Math.floor(x);
    let r = Math.floor(y);
    if (this.flipped) {
      f = 7 - f;
      r = 7 - r;
    }
    return FILES[f] + (8 - r);
  }

  _svgPoint(clientX, clientY) {
    const rect = this.svg.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * SIZE * 8,
      y: ((clientY - rect.top) / rect.height) * SIZE * 8,
    };
  }

  _xy(square) {
    let f = FILES.indexOf(square[0]);
    let r = 8 - parseInt(square[1], 10);
    if (this.flipped) {
      f = 7 - f;
      r = 7 - r;
    }
    return { x: f * SIZE, y: r * SIZE };
  }

  _center(square) {
    const { x, y } = this._xy(square);
    return { x: x + SIZE / 2, y: y + SIZE / 2 };
  }

  /* ---------------------------------------------------------------- */
  /* pointer input: click, drag-to-move, right-click marks             */
  /* ---------------------------------------------------------------- */

  _bindPointerEvents() {
    // The context menu would swallow right-drag arrow drawing.
    this.svg.addEventListener('contextmenu', (e) => e.preventDefault());

    this.svg.addEventListener('pointerdown', (e) => {
      const square = this._squareFromPoint(e.clientX, e.clientY);
      if (!square) return;

      if (e.button === 2) {
        this._rightDrag = { from: square, to: square };
        this.svg.setPointerCapture(e.pointerId);
        return;
      }
      if (e.button !== 0) return;

      // Left click clears user marks, chess.com-style, then proceeds with
      // its normal duties.
      if (this.userArrows.length || this.userHighlights.size) {
        this.userArrows = [];
        this.userHighlights.clear();
        this._renderUserMarks();
        if (this.onUserMark) this.onUserMark();
      }

      const piece = this.position.get(square);
      this._drag = {
        from: square,
        piece,
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
        node: piece ? this._pieceNodes.get(square) : null,
      };
      this.svg.setPointerCapture(e.pointerId);
    });

    this.svg.addEventListener('pointermove', (e) => {
      if (this._rightDrag) {
        const square = this._squareFromPoint(e.clientX, e.clientY);
        if (square && square !== this._rightDrag.to) {
          this._rightDrag.to = square;
          this._renderPreviewArrow();
        }
        return;
      }
      if (!this._drag || !this._drag.piece) return;
      const dx = e.clientX - this._drag.startX;
      const dy = e.clientY - this._drag.startY;
      if (!this._drag.moved && Math.hypot(dx, dy) < 5) return;

      this._drag.moved = true;
      const node = this._drag.node;
      if (node) {
        const p = this._svgPoint(e.clientX, e.clientY);
        node.style.transition = 'none';
        node.style.transform = '';
        node.setAttribute('x', p.x - SIZE * 0.48);
        node.setAttribute('y', p.y - SIZE * 0.48);
        this.pieceLayer.append(node); // raise above siblings
      }
    });

    this.svg.addEventListener('pointerup', (e) => {
      if (this._rightDrag) {
        const { from, to } = this._rightDrag;
        this._rightDrag = null;
        this.previewLayer.innerHTML = '';
        if (from === to) {
          // Toggle a red square highlight.
          if (this.userHighlights.has(from)) this.userHighlights.delete(from);
          else this.userHighlights.add(from);
          this._renderUserMarks();
        } else if (isDrawableShape(from, to)) {
          // Toggle the arrow: drawing the same one again removes it.
          const idx = this.userArrows.findIndex((a) => a.from === from && a.to === to);
          if (idx >= 0) this.userArrows.splice(idx, 1);
          else this.userArrows.push({ from, to });
          this._renderUserMarks();
        }
        if (this.onUserMark) this.onUserMark();
        return;
      }

      if (!this._drag) return;
      const drag = this._drag;
      this._drag = null;

      if (drag.moved) {
        const target = this._squareFromPoint(e.clientX, e.clientY);
        // Snap back visually; the app re-renders on a successful move.
        this._renderPieces();
        if (target && target !== drag.from && this.onDragMove) {
          this.onDragMove(drag.from, target);
        }
        return;
      }

      if (this.onSquareClick) this.onSquareClick(drag.from);
    });

    this.svg.addEventListener('pointercancel', () => {
      if (this._drag && this._drag.moved) this._renderPieces();
      this._drag = null;
      this._rightDrag = null;
      this.previewLayer.innerHTML = '';
    });
  }

  /* ---------------------------------------------------------------- */
  /* board furniture                                                   */
  /* ---------------------------------------------------------------- */

  _drawSquares() {
    this.squareLayer.innerHTML = '';
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const light = (r + f) % 2 === 0;
        this.squareLayer.append(
          el('rect', {
            x: f * SIZE,
            y: r * SIZE,
            width: SIZE,
            height: SIZE,
            class: light ? 'sq-light' : 'sq-dark',
          })
        );
      }
    }

    // Coordinates, chess.com-style: rank digits down the left edge, file
    // letters along the bottom, each sitting inside its square in the
    // opposite square colour.
    for (let i = 0; i < 8; i++) {
      // Rank label in the leftmost column of screen row i.
      const screenTopIsLight = i % 2 === 0;
      const rankText = this.flipped ? String(i + 1) : String(8 - i);
      const rank = el('text', {
        x: 6,
        y: i * SIZE + 24,
        class: `coord ${screenTopIsLight ? 'coord-dark' : 'coord-light'}`,
      });
      rank.textContent = rankText;
      this.squareLayer.append(rank);

      // File label in the bottom row of screen column i.
      const bottomIsLight = (7 + i) % 2 === 0;
      const fileText = this.flipped ? FILES[7 - i] : FILES[i];
      const file = el('text', {
        x: i * SIZE + SIZE - 8,
        y: 8 * SIZE - 8,
        class: `coord ${bottomIsLight ? 'coord-dark' : 'coord-light'}`,
        'text-anchor': 'end',
      });
      file.textContent = fileText;
      this.squareLayer.append(file);
    }
  }

  setFlipped(flipped) {
    this.flipped = flipped;
    this._drawSquares();
    this.render({ animate: false });
  }

  setPosition(fen, { lastMove = null, classification = null, checkSquare = null } = {}) {
    this._previousBoard = this.position ? this.position.boardArray() : null;
    this.position = new Chess(fen);
    this.lastMove = lastMove;
    this.badge = classification && lastMove ? { square: lastMove.to, classification } : null;
    this.checkSquare = checkSquare;
    this.selected = null;
    this.render({ animate: true });
  }

  setArrows(arrows) {
    this.arrows = arrows || [];
    this._renderArrows();
  }

  setSelection(square) {
    this.selected = square;
    this._renderMarks();
  }

  clearUserMarks() {
    this.userArrows = [];
    this.userHighlights.clear();
    this._renderUserMarks();
  }

  render({ animate = false } = {}) {
    this._renderMarks();
    this._renderPieces(animate ? this._previousBoard : null);
    this._renderArrows();
    this._renderUserMarks();
    this._renderBadge();
  }

  _renderMarks() {
    this.markLayer.innerHTML = '';
    if (this.lastMove) {
      // The from/to squares carry the verdict's colour, so a blunder turns
      // the board red and a brilliancy teal at a glance.
      const tint = this.badge ? classColor(this.badge.classification) : null;
      for (const sq of [this.lastMove.from, this.lastMove.to]) {
        const { x, y } = this._xy(sq);
        const rect = el('rect', { x, y, width: SIZE, height: SIZE, class: 'sq-last' });
        if (tint) {
          rect.setAttribute('fill', tint);
          rect.setAttribute('fill-opacity', '0.5');
        }
        this.markLayer.append(rect);
      }
    }
    if (this.checkSquare) {
      const { x, y } = this._xy(this.checkSquare);
      this.markLayer.append(
        el('circle', {
          cx: x + SIZE / 2,
          cy: y + SIZE / 2,
          r: SIZE * 0.48,
          class: 'sq-check',
        })
      );
    }
    if (this.selected) {
      const { x, y } = this._xy(this.selected);
      this.markLayer.append(
        el('rect', { x, y, width: SIZE, height: SIZE, class: 'sq-selected' })
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* pieces, with glide animation                                      */
  /* ---------------------------------------------------------------- */

  /* Renders the current position. When `previous` (a boardArray) is given,
   * pieces that changed square glide from their old square instead of
   * teleporting: each moved piece starts translated back at its old spot and
   * transitions to zero. Captures simply vanish, which at 140ms reads
   * naturally. Large diffs (jumping around the game) skip animation. */
  _renderPieces(previous = null) {
    const current = this.position.boardArray();

    // Work out where each appeared piece came from.
    const animateFrom = new Map(); // targetSquare -> sourceSquare
    if (previous) {
      const gone = []; // pieces no longer on their old square
      const appeared = [];
      const prevAt = new Map();
      for (const row of previous) for (const c of row) if (c) prevAt.set(c.square, c);
      const nowAt = new Map();
      for (const row of current) for (const c of row) if (c) nowAt.set(c.square, c);

      for (const [sq, piece] of prevAt) {
        const now = nowAt.get(sq);
        if (!now || now.color !== piece.color || now.type !== piece.type) gone.push(piece);
      }
      for (const [sq, piece] of nowAt) {
        const before = prevAt.get(sq);
        if (!before || before.color !== piece.color || before.type !== piece.type)
          appeared.push(piece);
      }

      if (appeared.length >= 1 && appeared.length <= 3) {
        for (const piece of appeared) {
          // Prefer the same piece type; fall back to a pawn of the same
          // colour, which is what a promotion looks like.
          let source =
            gone.find((g) => g.color === piece.color && g.type === piece.type) ||
            gone.find((g) => g.color === piece.color && g.type === 'p');
          if (source) {
            animateFrom.set(piece.square, source.square);
            gone.splice(gone.indexOf(source), 1);
          }
        }
      }
    }

    this.pieceLayer.innerHTML = '';
    this._pieceNodes = new Map();

    const reduced =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

    for (const row of current) {
      for (const cell of row) {
        if (!cell) continue;
        const { x, y } = this._xy(cell.square);
        const image = el('image', {
          x: x + SIZE * 0.02,
          y: y + SIZE * 0.02,
          width: SIZE * 0.96,
          height: SIZE * 0.96,
          class: 'piece-img',
        });
        image.setAttribute('href', PIECE_SRC(cell.color, cell.type));
        image.addEventListener('error', () => {
          const text = el('text', {
            x: x + SIZE / 2,
            y: y + SIZE / 2,
            class: `piece piece-${cell.color}`,
            'text-anchor': 'middle',
            'dominant-baseline': 'central',
          });
          text.textContent = GLYPHS[cell.type];
          image.replaceWith(text);
        });
        this.pieceLayer.append(image);
        this._pieceNodes.set(cell.square, image);

        const from = animateFrom.get(cell.square);
        if (from && !reduced && typeof image.animate === 'function') {
          // Web Animations rather than a CSS-transition dance: it is driven
          // by time, so a tab that is not compositing (backgrounded, hidden)
          // still ends with the piece resting on its true square instead of
          // stuck mid-glide, and it leaves no inline style behind.
          const src = this._xy(from);
          image.animate(
            [
              { transform: `translate(${src.x - x}px, ${src.y - y}px)` },
              { transform: 'translate(0px, 0px)' },
            ],
            { duration: ANIM_MS, easing: 'ease-out' }
          );
        }
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* arrows                                                            */
  /* ---------------------------------------------------------------- */

  /* Straight arrow polygon, chess.com proportions: shaft 22% of a square,
   * head 52% x 36%, tail starting 36% from the origin centre. */
  _straightArrowPoints(from, to) {
    const a = this._center(from);
    const b = this._center(to);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const px = -uy;
    const py = ux;

    const tail = SIZE * 0.36;
    const half = SIZE * 0.11;
    const headLen = SIZE * 0.36;
    const headHalf = SIZE * 0.26;

    const sx = a.x + ux * tail;
    const sy = a.y + uy * tail;
    const hx = b.x - ux * headLen;
    const hy = b.y - uy * headLen;

    return [
      [sx + px * half, sy + py * half],
      [hx + px * half, hy + py * half],
      [hx + px * headHalf, hy + py * headHalf],
      [b.x, b.y],
      [hx - px * headHalf, hy - py * headHalf],
      [hx - px * half, hy - py * half],
      [sx - px * half, sy - py * half],
    ];
  }

  /* Knight arrow as a proper L, chess.com-style: the two-square leg first,
   * a right-angle bend, then the one-square leg carrying the head. */
  _knightArrowPoints(from, to) {
    const a = this._center(from);
    const b = this._center(to);
    const dx = b.x - a.x;
    const dy = b.y - a.y;

    // Long leg first. Both legs are axis-aligned.
    const corner =
      Math.abs(dx) > Math.abs(dy) ? { x: b.x, y: a.y } : { x: a.x, y: b.y };

    const u1 = { x: Math.sign(corner.x - a.x), y: Math.sign(corner.y - a.y) };
    const u2 = { x: Math.sign(b.x - corner.x), y: Math.sign(b.y - corner.y) };
    const p1 = { x: -u1.y, y: u1.x };
    const p2 = { x: -u2.y, y: u2.x };

    const tail = SIZE * 0.36;
    const half = SIZE * 0.11;
    const headLen = SIZE * 0.36;
    const headHalf = SIZE * 0.26;

    const s = { x: a.x + u1.x * tail, y: a.y + u1.y * tail };
    const hb = { x: b.x - u2.x * headLen, y: b.y - u2.y * headLen };

    // For perpendicular legs the offset corner on each side is the corner
    // shifted by both legs' perpendiculars.
    const cornerAt = (sign) => ({
      x: corner.x + sign * half * (p1.x + p2.x),
      y: corner.y + sign * half * (p1.y + p2.y),
    });
    const kPlus = cornerAt(1);
    const kMinus = cornerAt(-1);

    return [
      [s.x + p1.x * half, s.y + p1.y * half],
      [kPlus.x, kPlus.y],
      [hb.x + p2.x * half, hb.y + p2.y * half],
      [hb.x + p2.x * headHalf, hb.y + p2.y * headHalf],
      [b.x, b.y],
      [hb.x - p2.x * headHalf, hb.y - p2.y * headHalf],
      [hb.x - p2.x * half, hb.y - p2.y * half],
      [kMinus.x, kMinus.y],
      [s.x - p1.x * half, s.y - p1.y * half],
    ];
  }

  _arrowPolygon(from, to, className, fill = null) {
    const pts = isKnightOffset(from, to)
      ? this._knightArrowPoints(from, to)
      : this._straightArrowPoints(from, to);
    const poly = el('polygon', {
      points: pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '),
      class: className,
    });
    if (fill) poly.setAttribute('fill', fill);
    return poly;
  }

  _renderArrows() {
    this.arrowLayer.innerHTML = '';
    for (const arrow of this.arrows) {
      this.arrowLayer.append(
        this._arrowPolygon(arrow.from, arrow.to, `arrow arrow-${arrow.kind || 'best'}`)
      );
    }
  }

  _renderUserMarks() {
    this.userMarkLayer.innerHTML = '';
    for (const sq of this.userHighlights) {
      const { x, y } = this._xy(sq);
      this.userMarkLayer.append(
        el('rect', {
          x,
          y,
          width: SIZE,
          height: SIZE,
          fill: USER_HIGHLIGHT_FILL,
        })
      );
    }
    this.userArrowLayer.innerHTML = '';
    for (const arrow of this.userArrows) {
      this.userArrowLayer.append(
        this._arrowPolygon(arrow.from, arrow.to, 'arrow arrow-user', USER_ARROW_FILL)
      );
    }
  }

  _renderPreviewArrow() {
    this.previewLayer.innerHTML = '';
    const d = this._rightDrag;
    if (!d || d.from === d.to || !isDrawableShape(d.from, d.to)) return;
    this.previewLayer.append(
      this._arrowPolygon(d.from, d.to, 'arrow arrow-user', USER_ARROW_FILL)
    );
  }

  _renderBadge() {
    this.badgeLayer.innerHTML = '';
    if (!this.badge) return;
    const { x, y } = this._xy(this.badge.square);
    const group = chipSvg(document, this.badge.classification, x + SIZE - 12, y + 12, 21);
    if (group) this.badgeLayer.append(group);
  }
}
