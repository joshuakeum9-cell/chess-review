/* app.js — wires the parser, engine, review logic and board together. */

import { Chess, parsePgn, splitPgnGames } from './chess.js';
import { Engine } from './engine.js';
import {
  analysePositions,
  buildReport,
  CLASSIFICATIONS,
  formatEval,
  winPercent,
} from './review.js';
import { BoardView } from './board.js';

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
  retry: null,
};

const engine = new Engine();
let engineReady = null;

const board = new BoardView($('board'), { onSquareClick: handleSquareClick });

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
        setEngineStatus(
          engine.source === 'cdn' ? 'Engine: ready (CDN)' : 'Engine: ready (local)',
          'is-ready'
        );
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
  state.game = parsed;
  state.positions = null;
  state.report = null;
  state.ply = 0;
  state.explore = null;
  state.pinnedArrows = null;
  state.retry = null;

  $('analyseBtn').disabled = false;
  $('summaryPanel').hidden = true;
  $('reportBtn').hidden = true;
  $('retryBar').hidden = true;
  $('graphPanel').hidden = true;
  $('detailEmpty').hidden = false;
  $('detailBody').hidden = true;

  const h = parsed.headers;
  $('whiteName').textContent = h.White || 'White';
  $('blackName').textContent = h.Black || 'Black';

  renderPlayers();
  renderMoveList();
  renderPosition();
  $('loadDialog').close();
}

async function fetchOnlineGames() {
  const site = $('siteSelect').value;
  const user = $('usernameInput').value.trim();
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
    showError(`${err.message} — check the username, or paste the PGN instead.`);
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

  $('analyseBtn').disabled = true;
  $('cancelBtn').hidden = false;
  $('progressWrap').hidden = false;
  setProgress(0, state.game.moves.length + 1);

  try {
    await ensureEngine();
    await engine.newGame();
    const depth = parseInt($('depthSelect').value, 10) || 14;

    const positions = await analysePositions(state.game, engine, {
      depth,
      // Wide enough that the move actually played is usually among the scored
      // candidates, which is what keeps the "cost" figures honest.
      multipv: 4,
      onProgress: ({ done, total }) => setProgress(done, total),
      shouldStop: () => state.cancelRequested,
    });

    // If you cancelled part-way, buildReport simply stops at the last move it
    // has an evaluation for. The game itself is left intact so you can run the
    // analysis again without losing moves.
    state.positions = positions;
    state.report = buildReport(state.game, positions);
    state.ply = 0;

    $('graphPanel').hidden = false;
    renderSummary();
    renderGraph();
    renderMoveList();
    goToPly(0);
    // Chess.com shows you the report card first, then you step into the game.
    showReport();
  } catch (err) {
    showTransientError(err.message || String(err));
  } finally {
    state.analysing = false;
    $('analyseBtn').disabled = false;
    $('cancelBtn').hidden = true;
    $('progressWrap').hidden = true;
  }
}

function showTransientError(message) {
  const node = $('progressText');
  node.textContent = message;
  $('progressWrap').hidden = false;
  setEngineStatus(`Engine: ${message}`, 'is-error');
}

function setProgress(done, total) {
  const pct = total ? (done / total) * 100 : 0;
  $('progressFill').style.width = `${pct}%`;
  $('progressText').textContent = `Analysing ${done} / ${total} positions`;
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
    const chess = state.explore.chess;
    const last = state.explore.moves[state.explore.moves.length - 1];
    board.setPosition(chess.fen(), {
      lastMove: last ? { from: last.fromSquare, to: last.toSquare } : null,
      checkSquare: checkSquareFor(chess),
    });
    board.setArrows([]);
    updateEvalBar(state.explore.cpWhite, state.explore.mateWhite);
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
  highlightCurrentMove();
  renderGraphCursor();
}

function checkSquareFor(chess) {
  if (!chess.inCheck()) return null;
  const kingSq = chess.kings[chess.turn];
  return 'abcdefgh'[kingSq & 15] + (8 - (kingSq >> 4));
}

function updateEvalBar(cpWhite, mateWhite) {
  const pct = winPercent(cpWhite);
  $('evalBarWhite').style.height = `${pct}%`;
  const label = formatEval(cpWhite, mateWhite);
  $('evalBarLabel').textContent = label;
  $('evalBar').classList.toggle('is-black-ahead', pct < 50);
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
    sym.textContent = meta.symbol;
    sym.style.color = meta.color;
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
  if (active) active.scrollIntoView({ block: 'nearest' });
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
  $('openingName').textContent = opening.name || 'Unnamed opening';

  renderPhases(stats);

  const rows = CLASS_ORDER.filter(
    (key) => stats.w.counts[key] || stats.b.counts[key]
  )
    .map((key) => {
      const meta = CLASSIFICATIONS[key];
      return `<tr class="is-row">
        <td class="cell-count" style="color:${meta.color}">${stats.w.counts[key]}</td>
        <td class="cell-label"><span class="chip" style="background:${meta.color}">${meta.symbol}</span>${meta.label}</td>
        <td class="cell-count" style="color:${meta.color}">${stats.b.counts[key]}</td>
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
      <span class="phase-num" style="color:${accuracyColour(w)}">${w === null ? '—' : w.toFixed(0)}</span>
      <span class="phase-track flip"><span class="phase-fill" style="width:${w || 0}%;background:${accuracyColour(w)}"></span></span>
      <span class="phase-name">${labels[phase]}</span>
      <span class="phase-track"><span class="phase-fill" style="width:${b || 0}%;background:${accuracyColour(b)}"></span></span>
      <span class="phase-num" style="color:${accuracyColour(b)}">${b === null ? '—' : b.toFixed(0)}</span>`;
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
      `<span class="km-chip" style="background:${meta.color}">${meta.symbol}</span>` +
      `<span>${moveNo}${dots} ${escapeHtml(move.san)} — ${meta.label}</span>` +
      `<span class="km-cost">-${move.winLoss.toFixed(0)}%</span>`;
    button.addEventListener('click', () => {
      hideReport();
      goToPly(move.index + 1);
    });
    list.append(button);
  }
}

function showReport() {
  if (!state.report) return;
  $('summaryPanel').hidden = false;
  $('reportBtn').hidden = true;
}

function hideReport() {
  $('summaryPanel').hidden = true;
  $('reportBtn').hidden = false;
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
  badge.textContent = meta.symbol;
  badge.style.background = meta.color;

  $('detailTitle').textContent = meta.label;
  $('detailTitle').style.color = meta.color;

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
  if (['inaccuracy', 'mistake', 'blunder', 'miss'].includes(reviewed.classification)) {
    actions.hidden = false;

    const retry = document.createElement('button');
    retry.className = 'btn btn-primary';
    retry.textContent = 'Retry — find the best move';
    retry.addEventListener('click', () => startRetry(reviewed));

    const show = document.createElement('button');
    show.className = 'btn btn-ghost';
    show.textContent = `Show me ${reviewed.bestSan || 'the better move'}`;
    show.addEventListener('click', () => showBetterMove(reviewed));

    actions.append(retry, show);
  } else {
    actions.hidden = true;
  }
}

/* ------------------------------------------------------------------ */
/* retry mode: rewind to before the error and make the user find the   */
/* engine move (or any move at most 2% worse) on the board.            */
/* ------------------------------------------------------------------ */

function startRetry(reviewed) {
  state.explore = null;
  state.pinnedArrows = null;
  state.retry = { reviewed, solved: false, tries: 0 };
  state.ply = reviewed.index;

  const fen = fenAtPly(reviewed.index);
  board.setPosition(fen, { checkSquare: checkSquareFor(new Chess(fen)) });
  board.setArrows([]);

  $('retryBar').hidden = false;
  $('retryBar').className = 'retry-bar';
  $('retryText').textContent = `You played ${reviewed.san}. Find the better move for ${
    reviewed.color === 'w' ? 'White' : 'Black'
  }.`;
  updateEvalBarFromPly(reviewed.index);
  highlightCurrentMove();
}

function endRetry() {
  state.retry = null;
  $('retryBar').hidden = true;
  renderPosition();
}

async function handleRetryMove(chess, move) {
  const retry = state.retry;
  const reviewed = retry.reviewed;
  retry.tries++;

  const bar = $('retryBar');
  const isEngineChoice =
    move.uci === reviewed.bestMove || move.san === reviewed.bestSan;

  // Anything nearly as good as the engine move also counts — there is often
  // more than one right answer.
  let goodEnough = isEngineChoice;
  if (!goodEnough) {
    const pos = state.positions[reviewed.index];
    const line = (pos.linesMover || []).find((l) => l.first === move.uci);
    if (line) {
      goodEnough =
        winPercent(pos.cpMover) - winPercent(line.cp) <= 2;
    }
  }

  if (goodEnough) {
    retry.solved = true;
    bar.className = 'retry-bar is-right';
    $('retryText').textContent = isEngineChoice
      ? `${move.san} — exactly. That's the engine's move.`
      : `${move.san} works too — practically as strong as ${reviewed.bestSan}.`;
    const played = new Chess(fenAtPly(reviewed.index));
    played.move(move.uci);
    board.setPosition(played.fen(), {
      lastMove: { from: move.fromSquare, to: move.toSquare },
      classification: 'best',
      checkSquare: checkSquareFor(played),
    });
  } else {
    bar.className = 'retry-bar is-wrong';
    $('retryText').textContent =
      retry.tries >= 3
        ? `${move.san} isn't it either. Hint: it starts on ${reviewed.bestMove ? reviewed.bestMove.slice(0, 2) : '…'}.`
        : `${move.san} isn't the one. Try again.`;
    // reset the position so they can try again
    const fen = fenAtPly(reviewed.index);
    board.setPosition(fen, { checkSquare: checkSquareFor(new Chess(fen)) });
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
    `<strong style="color:#4a9c3a">Green</strong>: ${escapeHtml(reviewed.bestSan || 'engine choice')} — the move to play. ` +
    `<strong style="color:#6f9fc4">Blue</strong>: ${escapeHtml(reviewed.san)} — what you played. ` +
    `Press → to go back to the game.`;
}

function renderGraph() {
  const svg = $('evalGraph');
  svg.innerHTML = '';
  if (!state.positions || state.positions.length < 2) return;

  const W = 600;
  const H = 140;
  const n = state.positions.length;
  const points = state.positions.map((p, i) => {
    const win = winPercent(p.cpWhite);
    return { x: (i / (n - 1)) * W, y: H - (win / 100) * H };
  });

  const ns = 'http://www.w3.org/2000/svg';
  const bg = document.createElementNS(ns, 'rect');
  bg.setAttribute('width', W);
  bg.setAttribute('height', H);
  bg.setAttribute('fill', '#3a3733');
  svg.append(bg);

  const area = document.createElementNS(ns, 'path');
  const d =
    `M 0 ${H} ` +
    points.map((p) => `L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ') +
    ` L ${W} ${H} Z`;
  area.setAttribute('d', d);
  area.setAttribute('fill', '#e9e7e2');
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
    dot.setAttribute('cy', H - (winPercent(move.evalAfterWhite) / 100) * H);
    dot.setAttribute('r', 4);
    dot.setAttribute('fill', CLASSIFICATIONS[move.classification].color);
    svg.append(dot);
  }

  const cursor = document.createElementNS(ns, 'line');
  cursor.setAttribute('id', 'graphCursor');
  cursor.setAttribute('y1', 0);
  cursor.setAttribute('y2', H);
  cursor.setAttribute('stroke', '#81b64c');
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

function goToPly(ply) {
  if (!state.game) return;
  state.explore = null;
  state.pinnedArrows = null;
  if (state.retry) {
    state.retry = null;
    $('retryBar').hidden = true;
  }
  if (state.report && !$('summaryPanel').hidden) hideReport();
  $('exitExploreBtn').hidden = true;
  state.ply = Math.max(0, Math.min(state.game.moves.length, ply));
  renderPosition();
}

function updateEvalBarFromPly(ply) {
  if (state.positions && state.positions[ply]) {
    const pos = state.positions[ply];
    updateEvalBar(pos.cpWhite, pos.mateWhite);
  }
}

async function handleSquareClick(square) {
  if (!state.game) return;

  const chess = state.retry
    ? new Chess(fenAtPly(state.retry.reviewed.index))
    : state.explore
      ? state.explore.chess
      : new Chess(fenAtPly(state.ply));
  const piece = chess.get(square);

  if (board.selected && board.selected !== square) {
    const legal = chess.moves({ verbose: true, square: board.selected });
    const target = legal.find((m) => m.toSquare === square);
    if (target) {
      board.setSelection(null, []);
      if (state.retry && !state.retry.solved) {
        await handleRetryMove(chess, target);
      } else if (!state.retry) {
        await playExploratoryMove(chess, target);
      }
      return;
    }
  }

  if (piece && piece.color === chess.turn) {
    const dests = chess.moves({ verbose: true, square }).map((m) => m.toSquare);
    board.setSelection(square, dests);
  } else {
    board.setSelection(null, []);
  }
}

async function playExploratoryMove(chess, move) {
  const working = state.explore ? chess : new Chess(chess.fen());
  if (!state.explore) {
    state.explore = { chess: working, moves: [], startPly: state.ply, cpWhite: 0, mateWhite: null };
  }
  const made = working.move({ from: move.fromSquare, to: move.toSquare, promotion: 'q' });
  if (!made) return;
  state.explore.moves.push(made);

  $('exitExploreBtn').hidden = false;
  board.setSelection(null, []);
  renderPosition();

  const note = $('exploreNote');
  $('detailEmpty').hidden = true;
  $('detailBody').hidden = false;
  $('detailBadge').textContent = '?';
  $('detailBadge').style.background = '#6b7280';
  $('detailTitle').textContent = 'Exploring';
  $('detailTitle').style.color = '#c9c4bc';
  $('detailMove').textContent = state.explore.moves.map((m) => m.san).join(' ');
  $('detailText').textContent = 'Asking the engine…';
  $('detailLine').hidden = true;
  note.hidden = true;

  try {
    await ensureEngine();
    const res = await engine.analyse(working.fen(), { depth: 12, multipv: 1 });
    const top = res.lines[0];
    if (!top) return;
    const sign = working.turn === 'w' ? 1 : -1;
    state.explore.cpWhite = top.cp * sign;
    state.explore.mateWhite = top.mate === null || top.mate === undefined ? null : top.mate * sign;
    updateEvalBar(state.explore.cpWhite, state.explore.mateWhite);

    const pvBoard = new Chess(working.fen());
    const pvSan = [];
    for (const uci of top.pv.slice(0, 6)) {
      const m = pvBoard.move(uci);
      if (!m) break;
      pvSan.push(m.san);
    }
    $('detailEval').textContent = formatEval(state.explore.cpWhite, state.explore.mateWhite);
    $('detailText').textContent = `After ${made.san} the engine evaluates this at ${formatEval(
      state.explore.cpWhite,
      state.explore.mateWhite
    )}.`;
    if (pvSan.length) {
      $('detailLine').hidden = false;
      $('detailLineMoves').textContent = pvSan.join(' ');
    }
  } catch (err) {
    $('detailText').textContent = `Could not analyse this line: ${err.message}`;
  }
}

function exitExplore() {
  state.explore = null;
  $('exitExploreBtn').hidden = true;
  board.setSelection(null, []);
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
  engine.stop();
});

$('flipBtn').addEventListener('click', () => {
  state.flipped = !state.flipped;
  board.setFlipped(state.flipped);
  renderPlayers();
});
$('firstBtn').addEventListener('click', () => goToPly(0));
$('prevBtn').addEventListener('click', () => goToPly(state.ply - 1));
$('nextBtn').addEventListener('click', () => goToPly(state.ply + 1));
$('lastBtn').addEventListener('click', () =>
  goToPly(state.game ? state.game.moves.length : 0)
);
$('exitExploreBtn').addEventListener('click', exitExplore);
$('reportBtn').addEventListener('click', showReport);
$('startReviewBtn').addEventListener('click', () => {
  hideReport();
  goToPly(state.game && state.game.moves.length ? 1 : 0);
});
$('retryExitBtn').addEventListener('click', endRetry);
$('retryHintBtn').addEventListener('click', () => {
  if (!state.retry) return;
  const reviewed = state.retry.reviewed;
  endRetry();
  showBetterMove(reviewed);
});

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
      break;
    default:
      break;
  }
});

/* Boot: show the starting position and warm the engine up in the background. */
board.setPosition(new Chess().fen());
ensureEngine().catch(() => {
  /* status line already reports the failure */
});
