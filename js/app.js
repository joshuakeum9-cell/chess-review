/* app.js — wires the parser, engine, review logic and board together. */

import { Chess, parsePgn, splitPgnGames } from './chess.js?v=202608212141';
import { EnginePool } from './engine.js?v=202608212141';
import {
  analysePositions,
  analysePosition,
  verifyFlaggedMoves,
  buildReport,
  reviewVariationMove,
  CLASSIFICATIONS,
  formatEval,
  expectedFromCp,
} from './review.js?v=202608212141';
import { BoardView } from './board.js?v=202608212141';
import { chipHtml, classColor } from './icons.js?v=202608212141';
import { SoundBoard } from './sounds.js?v=202608212141';

const SAMPLE_PGN = `[Event "Immortal Game"]
[Site "London ENG"]
[Date "1851.06.21"]
[White "Adolf Anderssen"]
[Black "Lionel Kieseritzky"]
[Result "1-0"]

1. e4 e5 2. f4 exf4 3. Bc4 Qh4+ 4. Kf1 b5 5. Bxb5 Nf6 6. Nf3 Qh6 7. d3 Nh5
8. Nh4 Qg5 9. Nf5 c6 10. g4 Nf6 11. Rg1 cxb5 12. h4 Qg6 13. h5 Qg5 14. Qf3 Ng8
15. Bxf4 Qf6 16. Nc3 Bc5 17. Nd5 Qxb2 18. Bd6 Bxg1 19. e5 Qxa1+ 20. Ke2 Na6
21. Nxg7+ Kd8 22. Qf6+ Nxf6 23. Be7# 1-0`;

const $ = (id) => document.getElementById(id);

const state = {
  game: null,
  positions: null,
  report: null,
  ply: 0,
  flipped: false,
  analysing: false,
  cancelRequested: false,
  explore: null,
  pinnedArrows: null,
};

const engine = new EnginePool();
let engineReady = null;
const sounds = new SoundBoard();

const board = new BoardView($('board'), {
  onSquareClick: handleSquareClick,
  onDragMove: (from, to) => tryUserMove(from, to),
});

/* ------------------------------------------------------------------ */
/* engine boot                                                         */
/* ------------------------------------------------------------------ */

function setEngineStatus(text, cls = '') {
  const node = $('engineStatus');
  node.textContent = text;
  node.className = 'engine-status' + (cls ? ` ${cls}` : '');
}

function ensureEngine() {
  if (!engineReady) {
    setEngineStatus('Engine: loading…');
    engineReady = engine
      .init()
      .then(() => {
        setEngineStatus(`${engine.source} ×${engine.size}`, 'is-ready');
        return engine;
      })
      .catch((err) => {
        setEngineStatus('Engine: failed to load', 'is-error');
        engineReady = null;
        throw err;
      });
  }
  return engineReady;
}

/* ------------------------------------------------------------------ */
/* loading games                                                       */
/* ------------------------------------------------------------------ */

function showError(message) {
  const node = $('loadError');
  node.textContent = message;
  node.hidden = !message;
}

function loadGameFromPgn(pgnText) {
  const games = splitPgnGames(pgnText);
  if (!games.length) throw new Error('No PGN found in that text.');
  const parsed = parsePgn(games[0]);
  if (!parsed.moves.length) throw new Error('That PGN has no moves in it.');
  setGame(parsed);
  return parsed;
}

function setGame(parsed) {
  // A load during a running analysis abandons that run; runAnalysis checks
  // the game identity before publishing, so stale results can never land.
  if (state.analysing) state.cancelRequested = true;
  state.game = parsed;
  state.positions = null;
  state.report = null;
  state.ply = 0;
  state.explore = null;
  state.pinnedArrows = null;

  $('analyseBtn').disabled = false;
  // The Game Report card stays on screen; before an analysis it shows the
  // placeholder copy instead of numbers.
  $('reportPlaceholder').hidden = false;
  $('reportContent').hidden = true;
  $('graphPanel').hidden = true;
  $('enginePanel').hidden = true;
  $('detailEmpty').hidden = false;
  $('detailBody').hidden = true;

  const h = parsed.headers;
  $('whiteName').textContent = h.White || 'White';
  $('blackName').textContent = h.Black || 'Black';
  $('openingName').textContent = '';

  // When the game came from a username search, orient the board so that
  // player's side faces them. Display only: flipping never re-analyses.
  const me = (state.fetchedUser || '').toLowerCase();
  if (me) {
    if ((h.Black || '').toLowerCase() === me) state.flipped = true;
    else if ((h.White || '').toLowerCase() === me) state.flipped = false;
    board.setFlipped(state.flipped);
    $('evalBar').classList.toggle('is-flipped', state.flipped);
  }

  renderPlayers();
  renderMoveList();
  renderPosition();
  $('loadDialog').close();
}

async function fetchOnlineGames() {
  const site = $('siteSelect').value;
  const user = $('usernameInput').value.trim();
  state.fetchedUser = user;
  const list = $('gameList');
  showError('');
  list.innerHTML = '<li class="hint">Fetching…</li>';

  try {
    let games = [];
    if (site === 'chesscom') {
      const archivesRes = await fetch(
        `https://api.chess.com/pub/player/${encodeURIComponent(user)}/games/archives`
      );
      if (!archivesRes.ok) throw new Error(`Chess.com returned ${archivesRes.status}`);
      const archives = (await archivesRes.json()).archives || [];
      if (!archives.length) throw new Error('No games found for that username.');
      const monthRes = await fetch(archives[archives.length - 1]);
      const monthly = (await monthRes.json()).games || [];
      games = monthly
        .slice(-20)
        .reverse()
        .map((g) => ({
          pgn: g.pgn,
          white: g.white && g.white.username,
          black: g.black && g.black.username,
          result: describeChesscomResult(g),
          when: g.end_time ? new Date(g.end_time * 1000).toLocaleDateString() : '',
          mode: g.time_class || '',
        }));
    } else {
      const res = await fetch(
        `https://lichess.org/api/games/user/${encodeURIComponent(user)}?max=20`,
        { headers: { Accept: 'application/x-chess-pgn' } }
      );
      if (!res.ok) throw new Error(`Lichess returned ${res.status}`);
      const text = await res.text();
      games = splitPgnGames(text).map((pgn) => {
        const head = Object.fromEntries(
          [...pgn.matchAll(/\[(\w+)\s+"([^"]*)"\]/g)].map((m) => [m[1], m[2]])
        );
        return {
          pgn,
          white: head.White,
          black: head.Black,
          result: head.Result,
          when: head.UTCDate || head.Date || '',
          mode: head.Event || '',
        };
      });
    }

    if (!games.length) throw new Error('No games found for that username.');
    list.innerHTML = '';
    for (const g of games) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.innerHTML =
        `<strong>${escapeHtml(g.white || '?')}</strong> vs <strong>${escapeHtml(g.black || '?')}</strong>` +
        `<span class="game-meta">${escapeHtml(g.result || '')} · ${escapeHtml(g.mode)} · ${escapeHtml(g.when)}</span>`;
      button.addEventListener('click', () => {
        try {
          loadGameFromPgn(g.pgn);
        } catch (err) {
          showError(err.message);
        }
      });
      li.append(button);
      list.append(li);
    }
  } catch (err) {
    list.innerHTML = '';
    showError(`${err.message}. Check the username, or paste the PGN instead.`);
  }
}

/* Chess.com reports a per-player outcome ("win", "checkmated", "timeout",
 * "insufficient"...). Turn that into a normal score plus a readable reason. */
function describeChesscomResult(game) {
  const white = (game.white && game.white.result) || '';
  const black = (game.black && game.black.result) || '';
  const score = white === 'win' ? '1-0' : black === 'win' ? '0-1' : '½-½';
  const reasons = {
    checkmated: 'checkmate',
    resigned: 'resignation',
    timeout: 'time',
    abandoned: 'abandoned',
    stalemate: 'stalemate',
    agreed: 'agreement',
    repetition: 'repetition',
    insufficient: 'insufficient material',
    timevsinsufficient: 'time vs insufficient material',
    '50move': 'fifty-move rule',
  };
  const reason = reasons[white === 'win' ? black : white];
  return reason ? `${score} · ${reason}` : score;
}

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

/* ------------------------------------------------------------------ */
/* analysis                                                            */
/* ------------------------------------------------------------------ */

async function runAnalysis() {
  if (!state.game || state.analysing) return;
  state.analysing = true;
  state.cancelRequested = false;
  state.explore = null;
  // Pin the game this run belongs to: if a new game is loaded mid-run the
  // results are thrown away instead of being pinned onto the wrong moves.
  const game = state.game;
  let errored = false;

  $('analyseBtn').disabled = true;
  $('cancelBtn').hidden = false;
  $('progressWrap').hidden = false;
  setProgress(0, game.moves.length + 1);

  try {
    await ensureEngine();
    await engine.newGame();
    const depth = parseInt($('depthSelect').value, 10) || 14;
    state.depth = depth;

    const positions = await analysePositions(game, engine, {
      depth,
      // Widening the search is by far the most expensive knob with NNUE: at a
      // given depth, four lines cost roughly four times one. Three lines is
      // enough to name the alternatives and spot an only-move, and anything
      // that falls outside gets a cheap targeted search in pass two instead.
      multipv: 3,
      onProgress: ({ done, total, phase }) => setProgress(done, total, phase),
      shouldStop: () => state.cancelRequested,
    });

    // Third pass: anything the first report calls an error gets re-examined
    // at greater depth before the verdict is shown. Kills the false flags
    // that shallow-search noise produces, at a fraction of the cost of
    // deepening the whole game.
    if (!state.cancelRequested && positions.length === game.moves.length + 1) {
      await verifyFlaggedMoves(game, positions, engine, {
        depth,
        extraDepth: 4,
        onProgress: ({ done, total, phase }) => setProgress(done, total, phase),
        shouldStop: () => state.cancelRequested,
      });
    }

    // A different game was loaded while this one was being analysed: these
    // evaluations belong to the old moves, so drop them silently.
    if (state.game !== game) return;

    // If you cancelled part-way, buildReport simply stops at the last move it
    // has an evaluation for. The game itself is left intact so you can run the
    // analysis again without losing moves.
    state.positions = positions;
    state.report = buildReport(game, positions);
    state.ply = 0;

    $('graphPanel').hidden = false;
    renderSummary();
    renderGraph();
    renderMoveList();
    goToPly(0, { silent: true });
    // Chess.com shows you the report card first, then you step into the game.
    $('reportPlaceholder').hidden = true;
    $('reportContent').hidden = false;
    sounds.play('ready');
  } catch (err) {
    showTransientError(err.message || String(err));
    errored = true;
  } finally {
    state.analysing = false;
    $('analyseBtn').disabled = false;
    $('cancelBtn').hidden = true;
    // On failure the strip stays up: it is where the error message lives.
    if (!errored) $('progressWrap').hidden = true;
  }
}

function showTransientError(message) {
  const node = $('progressText');
  node.textContent = message;
  $('progressWrap').hidden = false;
  setEngineStatus(`Engine: ${message}`, 'is-error');
}

function setProgress(done, total, phase = 'positions') {
  const pct = total ? (done / total) * 100 : 0;
  $('progressFill').style.width = `${pct}%`;
  $('progressText').textContent =
    phase === 'moves'
      ? `Scoring your moves ${done} / ${total}`
      : phase === 'verify'
        ? `Double-checking flagged moves ${done} / ${total}`
        : `Analysing ${done} / ${total} positions`;
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

function fenAtPly(ply) {
  if (!state.game) return new Chess().fen();
  if (ply <= 0) return state.game.startFen;
  return state.game.moves[ply - 1].fenAfter;
}

function renderPlayers() {
  const h = (state.game && state.game.headers) || {};
  const white = `${h.White || 'White'}${h.WhiteElo ? ` <span class="prating">(${h.WhiteElo})</span>` : ''}`;
  const black = `${h.Black || 'Black'}${h.BlackElo ? ` <span class="prating">(${h.BlackElo})</span>` : ''}`;
  $('topPlayer').innerHTML = `<span class="pname">${state.flipped ? white : black}</span>`;
  $('bottomPlayer').innerHTML = `<span class="pname">${state.flipped ? black : white}</span>`;
}

function renderPosition() {
  if (state.explore) {
    const ex = state.explore;
    const chess = ex.chess;
    const last = ex.moves[ex.moves.length - 1];
    const review = ex.reviews[ex.reviews.length - 1];

    board.setPosition(chess.fen(), {
      lastMove: last ? { from: last.from, to: last.to } : null,
      // The verdict badge lands on the square you moved to, exactly as it
      // does for a move from the game.
      classification: review ? review.classification : null,
      checkSquare: checkSquareFor(chess),
    });

    // The engine's best move in the line you built, which is the whole point
    // of exploring: what should be played *here*.
    const after = ex.after;
    board.setArrows(
      after && after.bestMove && after.bestMove.length >= 4
        ? [{ from: after.bestMove.slice(0, 2), to: after.bestMove.slice(2, 4), kind: 'best' }]
        : []
    );

    updateEvalBar(ex.cpWhite, ex.mateWhite);
    renderEngineLines();
    renderVariation();
    return;
  }

  const fen = fenAtPly(state.ply);
  const chess = new Chess(fen);
  const move = state.ply > 0 ? state.game.moves[state.ply - 1] : null;
  const reviewed = state.report ? state.report.moves[state.ply - 1] : null;

  board.setPosition(fen, {
    lastMove: move ? { from: move.from, to: move.to } : null,
    classification: reviewed ? reviewed.classification : null,
    checkSquare: checkSquareFor(chess),
  });

  if (state.pinnedArrows) {
    board.setArrows(state.pinnedArrows);
  } else if (state.positions && state.positions[state.ply]) {
    const pos = state.positions[state.ply];
    board.setArrows(
      pos.bestMove && pos.bestMove.length >= 4
        ? [{ from: pos.bestMove.slice(0, 2), to: pos.bestMove.slice(2, 4), kind: 'best' }]
        : []
    );
  } else {
    board.setArrows([]);
  }

  if (state.positions && state.positions[state.ply]) {
    const pos = state.positions[state.ply];
    updateEvalBar(pos.cpWhite, pos.mateWhite);
  }

  renderDetail(reviewed);
  renderEngineLines();
  highlightCurrentMove();
  renderGraphCursor();
}

/* The position the board is showing: a position from the game, or the one at
 * the end of the line being explored. Everything that describes the current
 * position (eval bar, best-move arrow, engine list) reads it from here, so a
 * line you invented gets the same treatment as the game. */
function currentPosition() {
  if (state.explore) return state.explore.after;
  return state.positions ? state.positions[state.ply] : null;
}

/* The engine's top candidate moves for the position on the board, with their
 * evaluations. Lets you check the verdict rather than take it on trust. */
function renderEngineLines() {
  const panel = $('enginePanel');
  const pos = currentPosition();
  if (!pos) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  // A finished position has no moves to rank. Say so rather than removing the
  // panel, which would pull everything below it up the page.
  if (!pos.candidates || !pos.candidates.length) {
    const board = new Chess(pos.fen);
    $('engineDepth').textContent = '';
    $('engineLines').innerHTML = `<li class="engine-line is-idle">${
      board.isCheckmate()
        ? 'Checkmate. No moves to rank.'
        : board.isStalemate()
          ? 'Stalemate. No moves to rank.'
          : 'Game over. No moves to rank.'
    }</li>`;
    return;
  }

  $('engineDepth').textContent = `depth ${pos.depth}`;

  const playedUci =
    !state.explore && state.ply < state.game.moves.length
      ? state.game.moves[state.ply].uci
      : null;

  const list = $('engineLines');
  list.innerHTML = '';
  for (const cand of pos.candidates) {
    if (!cand.san) continue;
    const li = document.createElement('li');
    li.className = 'engine-line' + (cand.uci === playedUci ? ' is-played' : '');

    const evalText = formatEval(cand.cpWhite, cand.mateWhite);
    const ahead = cand.cpWhite > 20;
    const behind = cand.cpWhite < -20;

    const score = document.createElement('span');
    score.className = 'engine-line-eval';
    score.textContent = evalText;
    score.style.background = ahead ? '#ffffff' : behind ? '#000000' : '#757575';
    score.style.color = ahead ? '#000000' : '#ffffff';
    // Firmer edges so the white pill reads on light rows and the black pill
    // reads on the dark panel.
    score.style.borderColor = ahead ? '#757575' : behind ? '#5e5e5e' : 'transparent';

    const moves = document.createElement('span');
    moves.className = 'engine-line-moves';
    const rest = cand.lineSan.slice(1).join(' ');
    moves.innerHTML = `<strong>${escapeHtml(cand.san)}</strong>${rest ? ' ' + escapeHtml(rest) : ''}`;

    li.append(score, moves);
    li.title = 'Play this line out on the board';
    li.addEventListener('click', () => previewCandidate(cand));
    list.append(li);
  }
}

/* Click an engine line to walk into it from the current position. */
async function previewCandidate(cand) {
  if (!cand.uci) return;
  // Clicking a line while exploring continues the line you built, rather than
  // starting a new one from the game.
  const chess = state.explore ? state.explore.chess : new Chess(fenAtPly(state.ply));
  const legal = chess.moves({ verbose: true }).find((m) => m.uci === cand.uci);
  if (!legal) return;
  await playExploratoryMove(chess, legal);
}

function checkSquareFor(chess) {
  if (!chess.inCheck()) return null;
  const kingSq = chess.kings[chess.turn];
  return 'abcdefgh'[kingSq & 15] + (8 - (kingSq >> 4));
}

function updateEvalBar(cpWhite, mateWhite) {
  /* The bar is drawn from the centipawn score, not from the engine's
   * win/draw/loss expectation, even though the classifier uses the latter.
   *
   * They answer different questions. Win/draw/loss is a truthful statement
   * about the result: from +2.5 a 3100-rated engine wins essentially every
   * time, so expected score is already 100 there and stays 100 all the way to
   * +9. That makes a useless bar. It slams to one side around two and a half
   * pawns and then never moves again while the number beside it keeps
   * climbing, which reads as broken.
   *
   * The centipawn curve keeps its resolution across exactly the range players
   * watch, and is what every chess site draws, so the bar behaves the way the
   * eye expects. */
  const pct = expectedFromCp(cpWhite);
  $('evalBarWhite').style.height = `${pct}%`;
  const label = formatEval(cpWhite, mateWhite);
  $('evalBarLabel').textContent = label;
  $('evalBar').classList.toggle('is-black-ahead', pct < 50);
  // The bar's orientation follows the board: flipped board, flipped bar,
  // so White's share is always on White's side of the screen.
  $('evalBar').classList.toggle('is-flipped', state.flipped);
}

function renderMoveList() {
  const list = $('movesList');
  list.innerHTML = '';
  if (!state.game) return;

  const moves = state.game.moves;
  for (let i = 0; i < moves.length; i += 2) {
    const number = document.createElement('li');
    number.className = 'move-number';
    number.textContent = `${Math.floor(i / 2) + 1}.`;
    list.append(number);
    list.append(moveCell(i));
    list.append(moveCell(i + 1));
  }
}

function moveCell(index) {
  const li = document.createElement('li');
  const move = state.game.moves[index];
  if (!move) {
    li.className = 'move-cell is-empty';
    return li;
  }
  li.className = 'move-cell';
  li.dataset.ply = String(index + 1);

  const reviewed = state.report ? state.report.moves[index] : null;
  const meta = reviewed ? CLASSIFICATIONS[reviewed.classification] : null;

  const sym = document.createElement('span');
  sym.className = 'move-sym';
  if (meta) {
    sym.innerHTML = chipHtml(reviewed.classification, 15);
  }
  const san = document.createElement('span');
  san.textContent = move.san;

  li.append(sym, san);

  const chipWorthy =
    reviewed && !['book', 'forced'].includes(reviewed.classification);
  if (chipWorthy && reviewed.winLoss >= 5) {
    const loss = document.createElement('span');
    loss.className = 'move-loss';
    loss.textContent = `-${reviewed.winLoss.toFixed(0)}%`;
    li.append(loss);
  }

  li.addEventListener('click', () => goToPly(index + 1));
  return li;
}

function highlightCurrentMove() {
  for (const node of document.querySelectorAll('.move-cell')) {
    node.classList.toggle('is-current', Number(node.dataset.ply) === state.ply);
  }
  const active = document.querySelector('.move-cell.is-current');
  if (!active) return;

  // Scroll the move list only. scrollIntoView walks up every scrollable
  // ancestor, the document included, so it drags the whole page down a few
  // pixels on each navigation click.
  const box = $('movesScroll');
  const boxRect = box.getBoundingClientRect();
  const rect = active.getBoundingClientRect();
  if (rect.top < boxRect.top) {
    box.scrollTop -= boxRect.top - rect.top;
  } else if (rect.bottom > boxRect.bottom) {
    box.scrollTop += rect.bottom - boxRect.bottom;
  }
}

const CLASS_ORDER = [
  'brilliant',
  'great',
  'best',
  'excellent',
  'good',
  'book',
  'forced',
  'inaccuracy',
  'miss',
  'mistake',
  'blunder',
];

function renderSummary() {
  const { stats, opening } = state.report;
  $('whiteAccuracy').textContent = stats.w.accuracy.toFixed(1);
  $('blackAccuracy').textContent = stats.b.accuracy.toFixed(1);
  $('openingName').textContent = opening.name
    ? `${opening.name}${opening.eco ? ` (${opening.eco})` : ''}`
    : 'Unnamed opening';

  renderPhases(stats);

  const rows = CLASS_ORDER.filter(
    (key) => stats.w.counts[key] || stats.b.counts[key]
  )
    .map((key) => {
      const meta = CLASSIFICATIONS[key];
      return `<tr class="is-row">
        <td class="cell-count" style="color:${classTextColor(key)}">${stats.w.counts[key]}</td>
        <td class="cell-label">${chipHtml(key, 17)}${meta.label}</td>
        <td class="cell-count" style="color:${classTextColor(key)}">${stats.b.counts[key]}</td>
      </tr>`;
    })
    .join('');

  $('classTable').innerHTML = `${rows}
    <tr class="row-rating">
      <td class="cell-count">${stats.w.rating}</td>
      <td class="cell-label">Game rating</td>
      <td class="cell-count">${stats.b.rating}</td>
    </tr>`;

  renderKeyMoments();
}

/* Accuracy split by opening / middlegame / endgame, as mirrored bars. */
function renderPhases(stats) {
  const block = $('phaseBlock');
  block.innerHTML = '';
  const labels = { opening: 'Opening', middlegame: 'Middle', endgame: 'Endgame' };

  for (const phase of ['opening', 'middlegame', 'endgame']) {
    const w = stats.w.phases && stats.w.phases[phase];
    const b = stats.b.phases && stats.b.phases[phase];
    if (w === null && b === null) continue;

    const row = document.createElement('div');
    row.className = 'phase-row';
    row.innerHTML = `
      <span class="phase-num">${w === null ? 'n/a' :w.toFixed(0)}</span>
      <span class="phase-track flip"><span class="phase-fill" style="width:${w || 0}%;background:${accuracyColour(w)}"></span></span>
      <span class="phase-name">${labels[phase]}</span>
      <span class="phase-track"><span class="phase-fill" style="width:${b || 0}%;background:${accuracyColour(b)}"></span></span>
      <span class="phase-num">${b === null ? 'n/a' :b.toFixed(0)}</span>`;
    block.append(row);
  }
}

function accuracyColour(value) {
  if (value === null || value === undefined) return '#6b6862';
  if (value >= 90) return '#81b64c';
  if (value >= 80) return '#95b776';
  if (value >= 70) return '#f7c631';
  if (value >= 60) return '#ffa459';
  return '#fa412d';
}

/* Text color for a classification. The app page runs on the dark theme,
 * where the light chip palette reads well as text; if the chrome ever goes
 * light again, swap this back to a darkened per-class map (see git history,
 * the light NVIDIA build had one). */
function classTextColor(type) {
  return classColor(type);
}

function renderKeyMoments() {
  const wrap = $('keyMoments');
  const list = $('keyMomentsList');
  list.innerHTML = '';
  const moments = state.report.keyMoments || [];
  wrap.hidden = moments.length === 0;

  for (const move of moments) {
    const meta = CLASSIFICATIONS[move.classification];
    const moveNo = Math.floor(move.index / 2) + 1;
    const dots = move.color === 'w' ? '.' : '...';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'km-item';
    button.innerHTML =
      `<span class="km-chip">${chipHtml(move.classification, 20)}</span>` +
      `<span>${moveNo}${dots} ${escapeHtml(move.san)} · ${meta.label}</span>` +
      `<span class="km-cost">-${move.winLoss.toFixed(0)}%</span>`;
    button.addEventListener('click', () => {
      goToPly(move.index + 1);
    });
    list.append(button);
  }
}

function renderDetail(reviewed) {
  if (!reviewed) {
    $('detailEmpty').hidden = !!state.game;
    $('detailBody').hidden = true;
    if (state.game) {
      $('detailEmpty').hidden = false;
      $('detailEmpty').innerHTML = state.report
        ? '<h2>Start of the game</h2><p>Step forward to walk through the review move by move.</p>'
        : '<h2>Ready to analyse</h2><p>Pick a depth and hit <strong>Analyse game</strong>. Depth 14 takes roughly a minute for a full game.</p>';
    }
    return;
  }

  $('detailEmpty').hidden = true;
  $('detailBody').hidden = false;

  const meta = CLASSIFICATIONS[reviewed.classification];
  const badge = $('detailBadge');
  badge.innerHTML = chipHtml(reviewed.classification, 38);
  badge.style.background = 'transparent';

  $('detailTitle').textContent = meta.label;
  $('detailTitle').style.color = classTextColor(reviewed.classification);

  const moveNo = Math.floor(reviewed.index / 2) + 1;
  const dots = reviewed.color === 'w' ? '.' : '...';
  $('detailMove').textContent = `${moveNo}${dots} ${reviewed.san}`;
  $('detailEval').textContent = formatEval(reviewed.evalAfterWhite, reviewed.mateAfterWhite);
  $('detailText').textContent = reviewed.explanation;

  const showLine = !reviewed.playedBest && reviewed.bestLineSan && reviewed.bestLineSan.length;
  $('detailLine').hidden = !showLine;
  if (showLine) {
    $('detailLineMoves').textContent = reviewed.bestLineSan.slice(0, 6).join(' ');
  }

  $('exploreNote').hidden = true;
  const actions = $('detailActions');
  actions.innerHTML = '';
  // The better-move replay steps back to a position from the game, so it is
  // only offered for moves the game actually contains.
  if (
    !reviewed.isVariation &&
    ['inaccuracy', 'mistake', 'blunder', 'miss'].includes(reviewed.classification)
  ) {
    actions.hidden = false;
    const show = document.createElement('button');
    show.className = 'btn btn-ghost';
    show.textContent = `Show me ${reviewed.bestSan || 'the better move'}`;
    show.addEventListener('click', () => showBetterMove(reviewed));
    actions.append(show);
  } else {
    actions.hidden = true;
  }
}

/* Step back to the position before the mistake and draw the move that was
 * available, so you can see it on the board that actually existed. */
function showBetterMove(reviewed) {
  state.ply = reviewed.index;
  const pos = state.positions[reviewed.index];
  state.pinnedArrows = [];
  if (pos && pos.bestMove) {
    state.pinnedArrows.push({
      from: pos.bestMove.slice(0, 2),
      to: pos.bestMove.slice(2, 4),
      kind: 'best',
    });
  }
  state.pinnedArrows.push({ from: reviewed.from, to: reviewed.to, kind: 'alt' });
  renderPosition();
  // keep the detail panel on the move we are explaining
  renderDetail(reviewed);
  const note = $('exploreNote');
  note.hidden = false;
  note.innerHTML =
    `<strong style="color:#9fcf3f">Green</strong>: ${escapeHtml(reviewed.bestSan || 'engine choice')}, the move to play. ` +
    `<strong style="color:#48c1f9">Blue</strong>: ${escapeHtml(reviewed.san)}, what you played. ` +
    `Press the right arrow key to go back to the game.`;
}

function renderGraph() {
  const svg = $('evalGraph');
  svg.innerHTML = '';
  if (!state.positions || state.positions.length < 2) return;

  const W = 600;
  const H = 140;
  const n = state.positions.length;
  // Same reasoning as the eval bar: the centipawn curve keeps its resolution
  // where games are actually decided, so the graph has a readable shape
  // instead of flat-lining at the top the moment someone is winning.
  const points = state.positions.map((p, i) => {
    const win = expectedFromCp(p.cpWhite);
    return { x: (i / (n - 1)) * W, y: H - (win / 100) * H };
  });

  const ns = 'http://www.w3.org/2000/svg';
  const bg = document.createElementNS(ns, 'rect');
  bg.setAttribute('width', W);
  bg.setAttribute('height', H);
  // Pure black so the chart stands off the #1a1a1a panel it sits on.
  bg.setAttribute('fill', '#000000');
  svg.append(bg);

  const area = document.createElementNS(ns, 'path');
  const d =
    `M 0 ${H} ` +
    points.map((p) => `L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ') +
    ` L ${W} ${H} Z`;
  area.setAttribute('d', d);
  area.setAttribute('fill', '#ffffff');
  svg.append(area);

  const mid = document.createElementNS(ns, 'line');
  mid.setAttribute('x1', 0);
  mid.setAttribute('x2', W);
  mid.setAttribute('y1', H / 2);
  mid.setAttribute('y2', H / 2);
  mid.setAttribute('stroke', '#8b8880');
  mid.setAttribute('stroke-width', '1');
  mid.setAttribute('stroke-dasharray', '4 4');
  svg.append(mid);

  // mark the serious errors
  for (const move of state.report.moves) {
    if (!['mistake', 'blunder', 'miss'].includes(move.classification)) continue;
    const i = move.index + 1;
    const dot = document.createElementNS(ns, 'circle');
    dot.setAttribute('cx', (i / (n - 1)) * W);
    const after = state.positions[i];
    const y = expectedFromCp(after ? after.cpWhite : move.evalAfterWhite);
    dot.setAttribute('cy', H - (y / 100) * H);
    dot.setAttribute('r', 4);
    dot.setAttribute('fill', classColor(move.classification));
    svg.append(dot);
  }

  const cursor = document.createElementNS(ns, 'line');
  cursor.setAttribute('id', 'graphCursor');
  cursor.setAttribute('y1', 0);
  cursor.setAttribute('y2', H);
  cursor.setAttribute('stroke', '#76b900');
  cursor.setAttribute('stroke-width', '2');
  svg.append(cursor);

  svg.onclick = (event) => {
    const rect = svg.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    goToPly(Math.round(ratio * (n - 1)));
  };

  renderGraphCursor();
}

function renderGraphCursor() {
  const cursor = document.getElementById('graphCursor');
  if (!cursor || !state.positions) return;
  const x = (state.ply / (state.positions.length - 1)) * 600;
  cursor.setAttribute('x1', x);
  cursor.setAttribute('x2', x);
}

/* ------------------------------------------------------------------ */
/* navigation & exploration                                            */
/* ------------------------------------------------------------------ */

function goToPly(ply, opts = {}) {
  if (!state.game) return;
  state.explore = null;
  state.pinnedArrows = null;
  $('exitExploreBtn').hidden = true;
  $('variationPanel').hidden = true;
  state.ply = Math.max(0, Math.min(state.game.moves.length, ply));
  renderPosition();
  // The move that produced the position now on the board, so stepping through
  // a game sounds like playing it.
  if (!opts.silent && state.ply > 0) sounds.playMove(state.game.moves[state.ply - 1]);
}

function updateEvalBarFromPly(ply) {
  if (state.positions && state.positions[ply]) {
    const pos = state.positions[ply];
    updateEvalBar(pos.cpWhite, pos.mateWhite);
  }
}

async function handleSquareClick(square) {
  if (!state.game) return;

  const chess = state.explore ? state.explore.chess : new Chess(fenAtPly(state.ply));
  const piece = chess.get(square);

  if (board.selected && board.selected !== square) {
    const legal = chess.moves({ verbose: true, square: board.selected });
    const target = legal.find((m) => m.toSquare === square);
    if (target) {
      board.setSelection(null);
      await playExploratoryMove(chess, target);
      return;
    }
  }

  if (piece && piece.color === chess.turn) {
    board.setSelection(square);
  } else {
    board.setSelection(null);
  }
}

/* Drag-and-drop lands here: same rules as click-to-move, one gesture. */
async function tryUserMove(fromSquare, toSquare) {
  if (!state.game) return;
  const chess = state.explore ? state.explore.chess : new Chess(fenAtPly(state.ply));
  const legal = chess
    .moves({ verbose: true, square: fromSquare })
    .find((m) => m.toSquare === toSquare);
  if (!legal) {
    // Picking a piece up and putting it back is a change of mind, not a
    // mistake, so it stays silent.
    if (fromSquare !== toSquare) sounds.play('illegal');
    return;
  }
  board.setSelection(null);
  await playExploratoryMove(chess, legal);
}

async function playExploratoryMove(chess, move) {
  const working = state.explore ? chess : new Chess(chess.fen());
  const fenBefore = working.fen();
  const made = working.move({ from: move.fromSquare, to: move.toSquare, promotion: 'q' });
  if (!made) return;

  if (!state.explore) {
    state.explore = {
      chess: working,
      moves: [],
      reviews: [],
      startPly: state.ply,
      cpWhite: 0,
      mateWhite: null,
      after: null,
      seq: 0,
    };
  }
  const ex = state.explore;

  // Same record shape a move parsed out of a PGN has, so the review code
  // cannot tell the difference between this move and one from the game.
  const record = {
    san: made.san,
    uci: made.uci,
    color: made.color,
    from: made.fromSquare,
    to: made.toSquare,
    piece: made.piece,
    captured: made.captured || null,
    fenBefore,
    fenAfter: working.fen(),
    ply: ex.startPly + ex.moves.length + 1,
  };
  ex.moves.push(record);
  ex.reviews.push(null);
  ex.after = null;

  sounds.playMove(record);
  $('exitExploreBtn').hidden = false;
  board.setSelection(null);
  renderPosition();
  showVariationPending(record);

  const seq = ++ex.seq;
  try {
    await ensureEngine();
    const previous =
      ex.moves.length > 1
        ? ex.moves[ex.moves.length - 2]
        : ex.startPly > 0
          ? state.game.moves[ex.startPly - 1]
          : null;

    const { reviewed, after } = await reviewVariationMove(record, engine, {
      depth: reviewDepth(),
      previous,
    });

    // A newer move (or a jump back to the game) landed while this search was
    // running: its answer describes a position nobody is looking at.
    if (!state.explore || state.explore !== ex || ex.seq !== seq) return;

    reviewed.isVariation = true;
    ex.reviews[ex.reviews.length - 1] = reviewed;
    ex.after = after;
    ex.cpWhite = after.cpWhite;
    ex.mateWhite = after.mateWhite;

    renderPosition();
    renderDetail(reviewed);
  } catch (err) {
    if (state.explore === ex && ex.seq === seq) {
      $('detailText').textContent = `Could not analyse this line: ${err.message}`;
    }
  }
}

function reviewDepth() {
  return state.depth || parseInt($('depthSelect').value, 10) || 14;
}

/* What the detail panel shows while the engine is judging an invented move. */
function showVariationPending(record) {
  $('detailEmpty').hidden = true;
  $('detailBody').hidden = false;
  $('detailBadge').innerHTML =
    '<svg class="chip-icon" width="38" height="38" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#6b7280"/><text x="12" y="12.5" text-anchor="middle" dominant-baseline="central" fill="#fff" font-size="13" font-weight="800">?</text></svg>';
  $('detailBadge').style.background = 'transparent';
  $('detailTitle').textContent = 'Judging your move';
  $('detailTitle').style.color = '#a7a7a7';
  const moveNo = Math.floor((record.ply - 1) / 2) + 1;
  const dots = record.color === 'w' ? '.' : '...';
  $('detailMove').textContent = `${moveNo}${dots} ${record.san}`;
  $('detailEval').textContent = '…';
  $('detailText').textContent = 'Searching this position at full review depth.';
  $('detailLine').hidden = true;
  $('detailActions').hidden = true;
  $('exploreNote').hidden = true;
}

/* The line you have built, move by move, with each verdict. Clicking a move
 * rewinds the line to it so you can branch somewhere else. */
function renderVariation() {
  const panel = $('variationPanel');
  const ex = state.explore;
  if (!ex || !ex.moves.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  const list = $('variationMoves');
  list.innerHTML = '';
  ex.moves.forEach((move, i) => {
    const review = ex.reviews[i];
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'var-move' + (i === ex.moves.length - 1 ? ' is-current' : '');
    const moveNo = Math.floor((move.ply - 1) / 2) + 1;
    const dots = move.color === 'w' ? '.' : '...';
    item.innerHTML =
      `<span class="var-num">${moveNo}${dots}</span>` +
      `<span class="var-san">${escapeHtml(move.san)}</span>` +
      (review ? chipHtml(review.classification, 15) : '');
    item.title = 'Rewind the line to here';
    item.addEventListener('click', () => rewindVariation(i));
    list.append(item);
  });
}

/* Take the line back to the given move: drop everything after it, restore the
 * board, and show that move's verdict again. */
function rewindVariation(index) {
  const ex = state.explore;
  if (!ex || index >= ex.moves.length - 1) return;

  const keep = ex.moves.slice(0, index + 1);
  ex.chess = new Chess(keep[keep.length - 1].fenAfter);
  ex.moves = keep;
  ex.reviews = ex.reviews.slice(0, index + 1);
  ex.seq++; // any search still running belongs to a move that no longer exists

  const review = ex.reviews[index];
  ex.after = null;
  if (review) {
    ex.cpWhite = review.evalAfterWhite;
    ex.mateWhite = review.mateAfterWhite;
  }

  sounds.playMove(keep[keep.length - 1]);
  board.setSelection(null);
  renderPosition();
  if (review) renderDetail(review);

  // The engine list and best-move arrow describe the position at the end of
  // the line, so they have to be re-established for the position we landed on.
  refreshVariationPosition();
}

/* Re-analyse the position at the end of the current line, after a rewind. */
async function refreshVariationPosition() {
  const ex = state.explore;
  if (!ex) return;
  const seq = ex.seq;
  try {
    await ensureEngine();
    const after = await analysePosition(ex.chess.fen(), engine, {
      depth: reviewDepth(),
      multipv: 3,
    });
    if (!state.explore || state.explore !== ex || ex.seq !== seq) return;
    ex.after = after;
    ex.cpWhite = after.cpWhite;
    ex.mateWhite = after.mateWhite;
    renderPosition();
  } catch {
    /* the board is still correct without it */
  }
}

function exitExplore() {
  state.explore = null;
  $('exitExploreBtn').hidden = true;
  $('variationPanel').hidden = true;
  board.setSelection(null);
  renderPosition();
}

/* ------------------------------------------------------------------ */
/* events                                                              */
/* ------------------------------------------------------------------ */

$('newGameBtn').addEventListener('click', () => $('loadDialog').showModal());
$('emptyLoadBtn').addEventListener('click', () => $('loadDialog').showModal());
$('closeDialogBtn').addEventListener('click', () => $('loadDialog').close());

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) t.classList.remove('is-active');
    for (const p of document.querySelectorAll('.tab-panel')) p.classList.remove('is-active');
    tab.classList.add('is-active');
    document.querySelector(`[data-panel="${tab.dataset.tab}"]`).classList.add('is-active');
    showError('');
  });
}

$('loadPgnBtn').addEventListener('click', () => {
  showError('');
  try {
    loadGameFromPgn($('pgnInput').value);
  } catch (err) {
    showError(err.message);
  }
});

$('loadSampleBtn').addEventListener('click', () => {
  showError('');
  $('pgnInput').value = SAMPLE_PGN;
  try {
    loadGameFromPgn(SAMPLE_PGN);
  } catch (err) {
    showError(err.message);
  }
});

$('fetchGamesBtn').addEventListener('click', fetchOnlineGames);
$('usernameInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    fetchOnlineGames();
  }
});

$('pgnFile').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  showError('');
  const text = await file.text();
  const games = splitPgnGames(text);
  const list = $('fileGameList');
  list.innerHTML = '';
  if (games.length === 1) {
    try {
      loadGameFromPgn(games[0]);
    } catch (err) {
      showError(err.message);
    }
    return;
  }
  for (const pgn of games) {
    const head = Object.fromEntries(
      [...pgn.matchAll(/\[(\w+)\s+"([^"]*)"\]/g)].map((m) => [m[1], m[2]])
    );
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.innerHTML = `<strong>${escapeHtml(head.White || '?')}</strong> vs <strong>${escapeHtml(head.Black || '?')}</strong><span class="game-meta">${escapeHtml(head.Result || '')} · ${escapeHtml(head.Date || '')}</span>`;
    button.addEventListener('click', () => {
      try {
        loadGameFromPgn(pgn);
      } catch (err) {
        showError(err.message);
      }
    });
    li.append(button);
    list.append(li);
  }
});

$('analyseBtn').addEventListener('click', runAnalysis);
$('cancelBtn').addEventListener('click', () => {
  state.cancelRequested = true;
  engine.stopAll();
});

$('flipBtn').addEventListener('click', () => {
  state.flipped = !state.flipped;
  board.setFlipped(state.flipped);
  renderPlayers();
  // Keep the eval bar oriented with the board.
  $('evalBar').classList.toggle('is-flipped', state.flipped);
});
$('firstBtn').addEventListener('click', () => goToPly(0));
$('prevBtn').addEventListener('click', () => goToPly(state.ply - 1));
$('nextBtn').addEventListener('click', () => goToPly(state.ply + 1));
$('lastBtn').addEventListener('click', () =>
  goToPly(state.game ? state.game.moves.length : 0)
);
$('exitExploreBtn').addEventListener('click', exitExplore);

document.addEventListener('keydown', (event) => {
  if (event.target.matches('input, textarea, select')) return;
  switch (event.key) {
    case 'ArrowLeft':
      event.preventDefault();
      goToPly(state.ply - 1);
      break;
    case 'ArrowRight':
      event.preventDefault();
      goToPly(state.ply + 1);
      break;
    case 'Home':
      goToPly(0);
      break;
    case 'End':
      goToPly(state.game ? state.game.moves.length : 0);
      break;
    case 'f':
      state.flipped = !state.flipped;
      board.setFlipped(state.flipped);
      renderPlayers();
      $('evalBar').classList.toggle('is-flipped', state.flipped);
      break;
    default:
      break;
  }
});

/* ---- move sounds ---- */

const SPEAKER_ON =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>' +
  '<path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
const SPEAKER_OFF =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>';

function renderSoundButton() {
  const btn = $('soundBtn');
  btn.innerHTML = sounds.enabled ? SPEAKER_ON : SPEAKER_OFF;
  btn.setAttribute('aria-pressed', sounds.enabled ? 'true' : 'false');
  btn.classList.toggle('is-muted', !sounds.enabled);
  btn.title = sounds.enabled ? 'Move sounds are on' : 'Move sounds are off';
}

$('soundBtn').addEventListener('click', () => {
  sounds.setEnabled(!sounds.enabled);
  renderSoundButton();
  if (sounds.enabled) sounds.play('move'); // so you hear what you turned on
});
renderSoundButton();

/* Browsers only allow audio to start inside a user gesture. Every sound here
 * follows a click or a key press anyway, but warming the context on the first
 * interaction means the very first move sound is not the one that gets eaten. */
for (const type of ['pointerdown', 'keydown']) {
  addEventListener(type, () => sounds.unlock(), { once: true, passive: true });
}

/* Exposed for inspection from the console: the parsed game, every position's
 * evaluation, and the finished report. Handy when a verdict looks wrong and
 * you want the numbers behind it. */
window.chessReview = state;
window.chessReviewSounds = sounds;

/* Boot: show the starting position and warm the engine up in the background. */
board.setPosition(new Chess().fen());
ensureEngine().catch(() => {
  /* status line already reports the failure */
});
