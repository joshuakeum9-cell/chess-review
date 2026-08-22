/* icons.js — presentation for move classifications: one colored chip per
 * tier, each with its own glyph so the tiers read at a glance:
 *
 *   Brilliant !!   Great !   Best ★   Excellent 👍   Good ✓   Book ▤
 *   Inaccuracy ?!  Mistake ?  Miss ✕  Blunder ??    Forced →
 *
 * All glyphs are drawn here as original vector paths. Colors are display
 * concerns and live here, separate from the classifier's judgment logic.
 */

export const CLASS_STYLE = {
  brilliant: { color: '#26c2a3', text: '!!' },
  great: { color: '#749bbf', text: '!' },
  best: {
    color: '#81b64c',
    // five-point star
    path: 'M12 3.6l2.35 5.03 5.52.62-4.1 3.75 1.1 5.44L12 15.7l-4.87 2.74 1.1-5.44-4.1-3.75 5.52-.62z',
  },
  excellent: {
    color: '#81b64c',
    // thumbs up: fist block + raised thumb
    path: 'M7.1 10.6h2.3v8H7.1a1.1 1.1 0 0 1-1.1-1.1v-5.8a1.1 1.1 0 0 1 1.1-1.1zm3.6 8v-8.2l2.3-4.9a1.5 1.5 0 0 1 2.86.86l-.66 3.04h3.1a1.9 1.9 0 0 1 1.86 2.28l-1.05 5.2a2.2 2.2 0 0 1-2.16 1.72z',
  },
  good: {
    color: '#95b776',
    // checkmark
    path: 'M9.55 17.05L4.9 12.4l1.8-1.8 2.85 2.85 7.75-7.75 1.8 1.8z',
  },
  book: {
    color: '#d5a47d',
    // open book
    path: 'M12 5.8c-1.5-1.1-3.6-1.6-6.4-1.6-.6 0-1.1.45-1.1 1.05v11.1c0 .6.5 1.05 1.1 1.05 2.8 0 4.9.5 6.4 1.6 1.5-1.1 3.6-1.6 6.4-1.6.6 0 1.1-.45 1.1-1.05V5.25c0-.6-.5-1.05-1.1-1.05-2.8 0-4.9.5-6.4 1.6zm-1 10.9c-1.3-.6-2.9-.95-4.9-1V6.0c2 .05 3.6.4 4.9 1zm2 0V7c1.3-.6 2.9-.95 4.9-1v9.7c-2 .05-3.6.4-4.9 1z',
  },
  forced: {
    color: '#9c9c9c',
    // right arrow
    path: 'M4.5 10.8h9.2V7.4l5.8 4.6-5.8 4.6v-3.4H4.5z',
  },
  inaccuracy: { color: '#f7c631', text: '?!' },
  mistake: { color: '#ffa459', text: '?' },
  miss: {
    color: '#ff7769',
    // cross
    path: 'M7.2 5.4L12 10.2l4.8-4.8 1.8 1.8L13.8 12l4.8 4.8-1.8 1.8L12 13.8l-4.8 4.8-1.8-1.8L10.2 12 5.4 7.2z',
  },
  blunder: { color: '#fa412d', text: '??' },
};

/* Inline SVG chip for HTML contexts (move list, tables, detail panel).
 * `size` is the outer diameter in px. */
export function chipHtml(type, size = 18) {
  const style = CLASS_STYLE[type];
  if (!style) return '';
  const glyph = style.path
    ? `<path d="${style.path}" fill="#fff"/>`
    : `<text x="12" y="12.5" text-anchor="middle" dominant-baseline="central" fill="#fff" font-size="${style.text.length > 1 ? 11 : 13}" font-weight="800" font-family="inherit">${style.text}</text>`;
  return (
    `<svg class="chip-icon" width="${size}" height="${size}" viewBox="0 0 24 24" aria-label="${type}">` +
    `<circle cx="12" cy="12" r="11" fill="${style.color}"/>` +
    glyph +
    `</svg>`
  );
}

/* Same chip drawn into an existing SVG (the board badge). Returns a <g>. */
export function chipSvg(document, type, cx, cy, r) {
  const NS = 'http://www.w3.org/2000/svg';
  const style = CLASS_STYLE[type];
  if (!style) return null;
  const g = document.createElementNS(NS, 'g');
  g.setAttribute('class', 'badge-pop');

  const circle = document.createElementNS(NS, 'circle');
  circle.setAttribute('cx', cx);
  circle.setAttribute('cy', cy);
  circle.setAttribute('r', r);
  circle.setAttribute('fill', style.color);
  circle.setAttribute('stroke', '#ffffff');
  circle.setAttribute('stroke-width', r * 0.14);
  g.append(circle);

  if (style.path) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', style.path);
    path.setAttribute('fill', '#ffffff');
    const s = (r * 2) / 24;
    path.setAttribute('transform', `translate(${cx - r},${cy - r}) scale(${s})`);
    g.append(path);
  } else {
    const text = document.createElementNS(NS, 'text');
    text.setAttribute('x', cx);
    text.setAttribute('y', cy + r * 0.06);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'central');
    text.setAttribute('fill', '#ffffff');
    text.setAttribute('font-size', style.text.length > 1 ? r * 0.95 : r * 1.15);
    text.setAttribute('font-weight', '800');
    text.textContent = style.text;
    g.append(text);
  }
  return g;
}

export function classColor(type) {
  return (CLASS_STYLE[type] || {}).color || '#9c9c9c';
}

/* ------------------------------------------------------------------ */
/* game-over badges: the icons that land on the two kings when the     */
/* game ends. Semantics and circle colors follow chess.com's live      */
/* boards (winner crown on green #83B84F, loss reasons on red #E02828, */
/* draws on gray #555351); the glyphs are original drawings.           */
/* ------------------------------------------------------------------ */

export const RESULT_STYLE = {
  winner: {
    color: '#83b84f',
    // three-point crown
    path: 'M3.8 7.6l4.1 3 3.4-5.6a.8.8 0 0 1 1.4 0l3.4 5.6 4.1-3a.7.7 0 0 1 1.1.7l-1.5 8.4c-2.3.9-4.9 1.35-7.8 1.35s-5.5-.45-7.8-1.35L2.7 8.3a.7.7 0 0 1 1.1-.7z',
  },
  mate: {
    color: '#e02828',
    // eight-point burst
    path: 'M12 2.4l1.88 5.07 4.91-2.26-2.26 4.91L21.6 12l-5.07 1.88 2.26 4.91-4.91-2.26L12 21.6l-1.88-5.07-4.91 2.26 2.26-4.91L2.4 12l5.07-1.88-2.26-4.91 4.91 2.26z',
  },
  resign: {
    color: '#e02828',
    // waving white flag on a leaning pole
    path: 'M8.05 3.4l1.9-.5 4.05 15.2-1.9.5zM10.1 5.3c2.3-1.6 4.5.9 7-.7l1.75 6.55c-2.5 1.6-4.7-.9-7 .7z',
  },
  timeout: {
    color: '#e02828',
    // clock: ring plus hands at 12 and half past 4
    path: 'M12 3.2a8.8 8.8 0 1 0 0 17.6 8.8 8.8 0 0 0 0-17.6zm0 2.3a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zm-.95 1.6h1.9v5.4h-1.9zm1.6 4.3l3.35 2.75-1.2 1.45-3.35-2.75z',
    evenodd: true,
  },
  draw: { color: '#555351', text: '½' },
  abandon: {
    color: '#e02828',
    path: 'M8.05 3.4l1.9-.5 4.05 15.2-1.9.5zM10.1 5.3c2.3-1.6 4.5.9 7-.7l1.75 6.55c-2.5 1.6-4.7-.9-7 .7z',
  },
};

/* Result badge drawn into an existing SVG (the board). Same frame as the
 * classification chips so the two systems read as one language. */
export function resultBadgeSvg(document, kind, cx, cy, r) {
  const NS = 'http://www.w3.org/2000/svg';
  const style = RESULT_STYLE[kind];
  if (!style) return null;
  const g = document.createElementNS(NS, 'g');
  g.setAttribute('class', 'badge-pop');

  const circle = document.createElementNS(NS, 'circle');
  circle.setAttribute('cx', cx);
  circle.setAttribute('cy', cy);
  circle.setAttribute('r', r);
  circle.setAttribute('fill', style.color);
  circle.setAttribute('stroke', '#ffffff');
  circle.setAttribute('stroke-width', r * 0.14);
  g.append(circle);

  if (style.path) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', style.path);
    path.setAttribute('fill', '#ffffff');
    if (style.evenodd) path.setAttribute('fill-rule', 'evenodd');
    const s = (r * 2) / 24;
    path.setAttribute('transform', `translate(${cx - r},${cy - r}) scale(${s})`);
    g.append(path);
  } else {
    const text = document.createElementNS(NS, 'text');
    text.setAttribute('x', cx);
    text.setAttribute('y', cy + r * 0.06);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'central');
    text.setAttribute('fill', '#ffffff');
    text.setAttribute('font-size', r * 1.2);
    text.setAttribute('font-weight', '800');
    text.textContent = style.text;
    g.append(text);
  }
  return g;
}
