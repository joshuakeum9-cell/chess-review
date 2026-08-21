/* board.js — SVG chessboard: pieces, highlights, move dots, arrows and the
 * classification badge that pops on the square you just moved to. */

import { Chess } from './chess.js';
import { chipSvg, classColor } from './icons.js';

const SIZE = 100; // one square in SVG user units
const FILES = 'abcdefgh';

/* Fallback glyphs for the unlikely case the piece images fail to load. */
const GLYPHS = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };

/* Standard open-licensed piece set (Cburnett, via lichess; see README). */
const PIECE_SRC = (color, type) => `assets/pieces/${color}${type.toUpperCase()}.svg`;

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

export class BoardView {
  constructor(container, { onSquareClick } = {}) {
    this.container = container;
    this.flipped = false;
    this.position = new Chess();
    this.lastMove = null;
    this.badge = null;
    this.arrows = [];
    this.dots = [];
    this.selected = null;
    this.checkSquare = null;
    this.onSquareClick = onSquareClick;

    this.svg = el('svg', {
      viewBox: `0 0 ${SIZE * 8} ${SIZE * 8}`,
      class: 'board-svg',
    });
    this.squareLayer = el('g');
    this.markLayer = el('g');
    this.pieceLayer = el('g');
    this.arrowLayer = el('g', { class: 'arrow-layer' });
    this.badgeLayer = el('g');
    this.svg.append(
      this.squareLayer,
      this.markLayer,
      this.pieceLayer,
      this.arrowLayer,
      this.badgeLayer
    );

    // Arrows are self-contained polygons; no marker defs needed.

    container.innerHTML = '';
    container.append(this.svg);

    this.svg.addEventListener('click', (event) => {
      const square = this._squareFromEvent(event);
      if (square && this.onSquareClick) this.onSquareClick(square);
    });

    this._drawSquares();
  }

  _arrowHead(id, color) {
    const marker = el('marker', {
      id,
      viewBox: '0 0 10 10',
      refX: '5',
      refY: '5',
      markerWidth: '3.2',
      markerHeight: '3.2',
      orient: 'auto-start-reverse',
    });
    marker.append(el('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: color }));
    return marker;
  }

  _squareFromEvent(event) {
    const rect = this.svg.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 8;
    const y = ((event.clientY - rect.top) / rect.height) * 8;
    if (x < 0 || x > 8 || y < 0 || y > 8) return null;
    let f = Math.floor(x);
    let r = Math.floor(y);
    if (this.flipped) {
      f = 7 - f;
      r = 7 - r;
    }
    return FILES[f] + (8 - r);
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
    // coordinates
    for (let i = 0; i < 8; i++) {
      const fileIdx = this.flipped ? 7 - i : i;
      const rankIdx = this.flipped ? 7 - i : i;
      const fileLabel = el('text', {
        x: i * SIZE + SIZE - 8,
        y: 8 * SIZE - 8,
        class: `coord ${i % 2 === 0 ? 'coord-dark' : 'coord-light'}`,
        'text-anchor': 'end',
      });
      fileLabel.textContent = FILES[fileIdx];
      const rankLabel = el('text', {
        x: 6,
        y: i * SIZE + 24,
        class: `coord ${i % 2 === 0 ? 'coord-light' : 'coord-dark'}`,
      });
      rankLabel.textContent = String(8 - rankIdx);
      this.squareLayer.append(fileLabel, rankLabel);
    }
  }

  setFlipped(flipped) {
    this.flipped = flipped;
    this._drawSquares();
    this.render();
  }

  setPosition(fen, { lastMove = null, classification = null, checkSquare = null } = {}) {
    this.position = new Chess(fen);
    this.lastMove = lastMove;
    this.badge = classification && lastMove ? { square: lastMove.to, classification } : null;
    this.checkSquare = checkSquare;
    this.selected = null;
    this.dots = [];
    this.render();
  }

  setArrows(arrows) {
    this.arrows = arrows || [];
    this._renderArrows();
  }

  setSelection(square, destinations) {
    this.selected = square;
    this.dots = destinations || [];
    this._renderMarks();
  }

  render() {
    this._renderMarks();
    this._renderPieces();
    this._renderArrows();
    this._renderBadge();
  }

  _renderMarks() {
    this.markLayer.innerHTML = '';
    if (this.lastMove) {
      // The from/to squares carry the verdict's colour, so a blunder turns the
      // board red and a brilliancy turns it teal — you read the game at a
      // glance without looking at the sidebar.
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
    for (const sq of this.dots) {
      const { x, y } = this._xy(sq);
      const occupied = this.position.get(sq);
      this.markLayer.append(
        occupied
          ? el('circle', {
              cx: x + SIZE / 2,
              cy: y + SIZE / 2,
              r: SIZE * 0.45,
              class: 'dot-capture',
            })
          : el('circle', {
              cx: x + SIZE / 2,
              cy: y + SIZE / 2,
              r: SIZE * 0.16,
              class: 'dot-move',
            })
      );
    }
  }

  _renderPieces() {
    this.pieceLayer.innerHTML = '';
    for (const row of this.position.boardArray()) {
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
        // If the SVG asset cannot load, fall back to a text glyph so the
        // board never shows an empty square.
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
      }
    }
  }

  /* Arrows drawn as a single polygon per arrow, with the proportions
   * measured from chess.com's analysis board: shaft 22% of a square wide,
   * head 52% wide and 36% long, tail starting 36% of a square from the
   * origin square's centre. */
  _renderArrows() {
    this.arrowLayer.innerHTML = '';
    for (const arrow of this.arrows) {
      const from = this._xy(arrow.from);
      const to = this._xy(arrow.to);
      const x1 = from.x + SIZE / 2;
      const y1 = from.y + SIZE / 2;
      const x2 = to.x + SIZE / 2;
      const y2 = to.y + SIZE / 2;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const px = -uy; // perpendicular
      const py = ux;

      const tail = SIZE * 0.36;
      const shaftHalf = SIZE * 0.11;
      const headLen = SIZE * 0.36;
      const headHalf = SIZE * 0.26;

      const sx = x1 + ux * tail;
      const sy = y1 + uy * tail;
      const hx = x2 - ux * headLen;
      const hy = y2 - uy * headLen;

      const points = [
        [sx + px * shaftHalf, sy + py * shaftHalf],
        [hx + px * shaftHalf, hy + py * shaftHalf],
        [hx + px * headHalf, hy + py * headHalf],
        [x2, y2],
        [hx - px * headHalf, hy - py * headHalf],
        [hx - px * shaftHalf, hy - py * shaftHalf],
        [sx - px * shaftHalf, sy - py * shaftHalf],
      ]
        .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
        .join(' ');

      this.arrowLayer.append(
        el('polygon', {
          points,
          class: `arrow arrow-${arrow.kind || 'best'}`,
        })
      );
    }
  }

  _renderBadge() {
    this.badgeLayer.innerHTML = '';
    if (!this.badge) return;
    const { x, y } = this._xy(this.badge.square);
    const group = chipSvg(document, this.badge.classification, x + SIZE - 12, y + 12, 21);
    if (group) this.badgeLayer.append(group);
  }
}
