/* review.js — orchestrates a whole-game review.
 *
 * Two passes over the game:
 *   1. Every position, MultiPV, so we know what the engine wanted and how
 *      close the alternatives were.
 *   2. Every played move that pass 1 did not already score, searched on its
 *      own with `searchmoves`.
 *
 * The point of pass 2 is that a move's cost is only meaningful when the move
 * you played and the move the engine wanted were scored by the same search of
 * the same position. Measuring against the *next* position instead looks
 * reasonable but is biased: that position sits a ply deeper, so ordinary moves
 * come out looking like mistakes.
 *
 * Judgement lives in classify.js, prose in explain.js, board reading in
 * tactics.js. This file only sequences them.
 */

import { Chess } from './chess.js';
import {
  CLASSIFICATIONS,
  classifyMove,
  expectedScore,
  expectedFromCp,
  volatility,
  sacrificeSize,
  gameAccuracy,
  volatilityWeights,
  performanceBand,
  phaseOf,
  nonPawnMaterial,
  MATE_CP,
} from './classify.js';
import { identifyOpening, bookDepth, lookupPosition } from './openings.js';
import { explainMove } from './explain.js';
import { lineToSan } from './tactics.js';

export { CLASSIFICATIONS, expectedScore, expectedFromCp };

/* Expected score from White's point of view, for the eval bar and graph. */
export function expectedWhite(pos) {
  if (!pos) return 50;
  return pos.toMove === 'w' ? pos.expected : 100 - pos.expected;
}

/* Readable evaluation: "+1.35", "-0.20", "M4", "#". */
export function formatEval(cpWhite, mateWhite) {
  if (mateWhite !== null && mateWhite !== undefined) {
    if (mateWhite === 0) return '#';
    return (mateWhite > 0 ? 'M' : '-M') + Math.abs(mateWhite);
  }
  const pawns = cpWhite / 100;
  return (pawns > 0 ? '+' : '') + pawns.toFixed(2);
}

function terminalEvaluation(board) {
  if (board.isCheckmate()) {
    return { cp: -MATE_CP, mate: 0, lines: [], bestMove: null, terminal: 'checkmate' };
  }
  return { cp: 0, mate: null, lines: [], bestMove: null, terminal: 'draw' };
}

/* Analyse every position, then score every played move in its own frame. */
export async function analysePositions(game, pool, opts = {}) {
  const { depth = 16, multipv = 3, onProgress, shouldStop } = opts;

  const fens = [
    game.moves.length ? game.moves[0].fenBefore : game.startFen,
    ...game.moves.map((m) => m.fenAfter),
  ];

  const boards = fens.map((fen) => new Chess(fen));
  const jobs = fens.map((fen, i) => (boards[i].isGameOver() ? null : { fen }));

  const raws = await pool.analyseAll(jobs, {
    depth,
    multipv,
    shouldStop,
    onResult: (index, result, done) => {
      if (onProgress) onProgress({ done, total: fens.length, phase: 'positions' });
    },
  });

  const results = [];
  for (let i = 0; i < fens.length; i++) {
    const fen = fens[i];
    const board = boards[i];
    const toMove = board.turn;

    let raw;
    if (jobs[i] === null) {
      raw = terminalEvaluation(board);
    } else if (raws[i]) {
      const res = raws[i];
      const top = res.lines[0] || { cp: 0, mate: null, pv: [], wdl: null };
      raw = {
        cp: top.cp,
        mate: top.mate ?? null,
        wdl: top.wdl || null,
        lines: res.lines,
        bestMove: res.bestMove || (top.pv && top.pv[0]) || null,
        depth: res.depth,
      };
    } else {
      break; // cancelled before this slot
    }

    const sign = toMove === 'w' ? 1 : -1;
    const top = raw.lines[0];

    // Everything the mover could have played that this search scored, best
    // first. Scores inside one search are directly comparable.
    const candidates = raw.lines
      .filter((l) => l.pv && l.pv[0])
      .map((l) => ({
        uci: l.pv[0],
        cp: l.cp,
        mate: l.mate ?? null,
        wdl: l.wdl || null,
        expected: expectedScore({ wdl: l.wdl, cp: l.cp, mate: l.mate }),
        san: (new Chess(fen).move(l.pv[0]) || {}).san || null,
        lineSan: lineToSan(fen, l.pv, 6),
        cpWhite: l.cp * sign,
        mateWhite: l.mate === null || l.mate === undefined ? null : l.mate * sign,
      }));

    results.push({
      fen,
      toMove,
      cpWhite: raw.cp * sign,
      mateWhite: raw.mate === null || raw.mate === undefined ? null : raw.mate * sign,
      cpMover: raw.cp,
      wdl: raw.wdl,
      expected: expectedScore({ wdl: raw.wdl, cp: raw.cp, mate: raw.mate }),
      expectedWhite:
        toMove === 'w'
          ? expectedScore({ wdl: raw.wdl, cp: raw.cp, mate: raw.mate })
          : 100 - expectedScore({ wdl: raw.wdl, cp: raw.cp, mate: raw.mate }),
      volatility: volatility({ wdl: raw.wdl, cp: raw.cp }),
      bestMove: raw.bestMove,
      bestSan: raw.bestMove ? (new Chess(fen).move(raw.bestMove) || {}).san || null : null,
      pv: top ? top.pv : [],
      pvSan: top ? lineToSan(fen, top.pv, 8) : [],
      candidates,
      legalCount: board.isGameOver() ? 0 : board.moves().length,
      playedScore: null, // filled in by pass 2
      terminal: raw.terminal || null,
      depth: raw.depth || 0,
    });
  }

  await scorePlayedMoves(game, results, pool, { depth, onProgress, shouldStop });
  return results;
}

/* Pass 2: score each played move inside its own position's search. */
async function scorePlayedMoves(game, positions, pool, { depth, onProgress, shouldStop }) {
  const jobs = new Array(game.moves.length).fill(null);
  let pending = 0;

  for (let i = 0; i < game.moves.length; i++) {
    const pos = positions[i];
    if (!pos) continue;
    const played = game.moves[i].uci;
    const known = pos.candidates.find((c) => c.uci === played);
    if (known) {
      pos.playedScore = known;
    } else if (pos.legalCount > 0) {
      jobs[i] = { fen: pos.fen, searchmoves: [played], multipv: 1 };
      pending++;
    }
  }

  if (!pending) return;

  const scored = await pool.analyseAll(jobs, {
    depth,
    multipv: 1,
    shouldStop,
    onResult: (index, result, done) => {
      if (onProgress) onProgress({ done, total: jobs.length, phase: 'moves' });
    },
  });

  for (let i = 0; i < scored.length; i++) {
    const top = scored[i] && scored[i].lines[0];
    if (!top) continue;
    const pos = positions[i];
    const sign = pos.toMove === 'w' ? 1 : -1;
    pos.playedScore = {
      uci: game.moves[i].uci,
      cp: top.cp,
      mate: top.mate ?? null,
      wdl: top.wdl || null,
      expected: expectedScore({ wdl: top.wdl, cp: top.cp, mate: top.mate }),
      cpWhite: top.cp * sign,
      mateWhite: top.mate === null || top.mate === undefined ? null : top.mate * sign,
      // The searchmoves PV is the engine's continuation AFTER the played
      // move, which is what an explanation may quote for it. Quoting the
      // position's best-move PV instead describes a different move.
      pv: top.pv || [],
    };
  }
}

/* Third pass: re-examine every move the first report flagged as an error, at
 * greater depth, before letting the verdict stand.
 *
 * Shallow-search noise is asymmetric in a nasty way. A move the engine
 * briefly misjudges as losing becomes a false Mistake on screen; the player
 * checks it, disagrees, and stops trusting the review. Re-searching only the
 * flagged positions costs a fraction of a full deep analysis (typically a
 * tenth of the plies) and removes exactly the verdicts most likely to be
 * wrong. Chess.com's review does the same thing, which is why its blunder
 * calls feel solid at a depth its full pass never reaches.
 *
 * Mutates `positions` in place; the caller rebuilds the report afterwards.
 * Returns the indices it re-examined.
 */
export async function verifyFlaggedMoves(game, positions, pool, opts = {}) {
  const { depth = 16, extraDepth = 4, onProgress, shouldStop } = opts;
  const report = buildReport(game, positions);
  const suspicious = new Set(['inaccuracy', 'mistake', 'blunder', 'miss', 'brilliant', 'great']);

  // Verification must be symmetric. Re-checking only flagged moves makes the
  // pass a one-way ratchet: it can clear a false flag but can never recover
  // an error the shallow pass under-measured, and under-measurement is
  // systematic exactly where players blunder most, in already-bad positions
  // (the shallow search compresses the gap between the best defence and the
  // move played; a measured audit found real mistakes reading as loss 2-5 at
  // the base depth and 7-11 four plies deeper). So borderline moves, the
  // ones whose loss lands near the error threshold from below, get the same
  // deep re-check as flagged ones, and the deep numbers may add flags as
  // well as remove them.
  const borderline = (m) =>
    !suspicious.has(m.classification) &&
    m.classification !== 'book' &&
    m.classification !== 'forced' &&
    !m.playedBest &&
    m.loss >= 1.5 &&
    m.loss < 8;

  const flagged = report.moves
    .filter((m) => suspicious.has(m.classification) || borderline(m))
    .map((m) => m.index);
  if (!flagged.length) return [];

  const deeper = depth + extraDepth;

  // Two jobs per flagged move: the position (for best move and candidates)
  // and the played move in that position (for its same-frame score).
  const jobs = [];
  for (const i of flagged) {
    jobs.push({ fen: positions[i].fen, multipv: 3, index: i, kind: 'position' });
    jobs.push({
      fen: positions[i].fen,
      searchmoves: [game.moves[i].uci],
      multipv: 1,
      index: i,
      kind: 'played',
    });
  }

  const results = await pool.analyseAll(jobs, {
    depth: deeper,
    multipv: 3,
    shouldStop,
    onResult: (index, result, done) => {
      if (onProgress) onProgress({ done, total: jobs.length, phase: 'verify' });
    },
  });

  for (let j = 0; j < jobs.length; j++) {
    const job = jobs[j];
    const res = results[j];
    if (!res || !res.lines.length) continue;
    const pos = positions[job.index];
    const sign = pos.toMove === 'w' ? 1 : -1;
    const fen = pos.fen;

    if (job.kind === 'position') {
      const top = res.lines[0];
      pos.candidates = res.lines
        .filter((l) => l.pv && l.pv[0])
        .map((l) => ({
          uci: l.pv[0],
          cp: l.cp,
          mate: l.mate ?? null,
          wdl: l.wdl || null,
          expected: expectedScore({ wdl: l.wdl, cp: l.cp, mate: l.mate }),
          san: (new Chess(fen).move(l.pv[0]) || {}).san || null,
          lineSan: lineToSan(fen, l.pv, 6),
          cpWhite: l.cp * sign,
          mateWhite: l.mate === null || l.mate === undefined ? null : l.mate * sign,
        }));
      pos.cpMover = top.cp;
      pos.cpWhite = top.cp * sign;
      pos.mateWhite = top.mate === null || top.mate === undefined ? null : top.mate * sign;
      pos.wdl = top.wdl || null;
      pos.expected = expectedScore({ wdl: top.wdl, cp: top.cp, mate: top.mate });
      pos.expectedWhite = pos.toMove === 'w' ? pos.expected : 100 - pos.expected;
      pos.bestMove = res.bestMove || (top.pv && top.pv[0]) || pos.bestMove;
      pos.bestSan = pos.bestMove ? (new Chess(fen).move(pos.bestMove) || {}).san || null : null;
      pos.pv = top.pv || pos.pv;
      pos.pvSan = top ? lineToSan(fen, top.pv, 8) : pos.pvSan;
      pos.depth = res.depth;
      pos.verified = true;
    } else {
      const known = pos.candidates.find((c) => c.uci === game.moves[job.index].uci);
      const top = res.lines[0];
      // Prefer the candidate entry when the deeper MultiPV already scored the
      // played move: same search, exactly comparable.
      pos.playedScore = known || {
        uci: game.moves[job.index].uci,
        cp: top.cp,
        mate: top.mate ?? null,
        wdl: top.wdl || null,
        expected: expectedScore({ wdl: top.wdl, cp: top.cp, mate: top.mate }),
        cpWhite: top.cp * sign,
        mateWhite: top.mate === null || top.mate === undefined ? null : top.mate * sign,
      };
    }
  }

  return flagged;
}

/* Turn positions into per-move verdicts and whole-game statistics. */
export function buildReport(game, positions) {
  const fensAfter = game.moves.map((m) => m.fenAfter);
  const opening = identifyOpening(fensAfter);
  const theory = bookDepth(fensAfter);
  const moves = [];

  // Accuracy weights come from the volatility of the win% series around each
  // move (Lichess's published method), not from any single position.
  const winSeries = positions.map((p) => p.expectedWhite ?? 50);
  const weights = volatilityWeights(winSeries);

  for (let i = 0; i < game.moves.length; i++) {
    const move = game.moves[i];
    const before = positions[i];
    const after = positions[i + 1];
    if (!before || !after) break;

    const sign = move.color === 'w' ? 1 : -1;

    // Expected score for the mover, before and after, from the same frame
    // wherever pass 1 or pass 2 supplied it.
    const expBefore = before.expected;
    const played = before.playedScore;
    const expAfter = played
      ? played.expected
      : 100 - after.expected; // fallback: flip the opponent's view

    const hadMate = before.mateWhite !== null && before.mateWhite * sign > 0;
    const stillMating = !!(played && played.mate !== null && played.mate > 0);

    const sacrificed = sacrificeSize(move.fenBefore, move);

    // Taking back on the square the opponent just took on. Obvious, and so
    // never Great or Brilliant however much the alternatives lose.
    const previous = i > 0 ? game.moves[i - 1] : null;
    const isRecapture = !!(previous && move.captured && move.to === previous.to);
    const inCheck = new Chess(move.fenBefore).inCheck();

    const verdict = classifyMove({
      before: { expected: expBefore, wdl: before.wdl, cp: before.cpMover },
      after: { expected: expAfter },
      played: { uci: move.uci, san: move.san },
      bestMove: before.bestMove,
      candidates: before.candidates,
      legalCount: before.legalCount,
      isBook: i + 1 <= theory,
      sacrificed,
      hadMate,
      keptMate: stillMating,
      isRecapture,
      inCheck,
    });

    const phase = phaseOf(move.fenAfter, theory, i + 1);
    const bookEntry = lookupPosition(move.fenAfter);

    moves.push({
      ...move,
      index: i,
      classification: verdict.type,
      loss: verdict.loss,
      accuracy: verdict.accuracy,
      volatility: before.volatility,
      weight: weights[i] ?? 1,
      counts: verdict.type !== 'book',
      playedBest: verdict.playedBest,
      viable: verdict.viable,
      alternativeCost: verdict.alternativeCost,
      decided: verdict.decided,
      sacrificed,
      phase,
      openingName: bookEntry ? bookEntry.n : null,
      evalBeforeWhite: before.cpWhite,
      evalAfterWhite: played ? played.cpWhite : after.cpWhite,
      mateBeforeWhite: before.mateWhite,
      mateAfterWhite: played ? played.mateWhite : after.mateWhite,
      expectedBefore: expBefore,
      expectedAfter: expAfter,
      winBefore: expBefore,
      winAfter: expAfter,
      winLoss: verdict.loss,
      bestMove: before.bestMove,
      bestSan: before.bestSan,
      bestLineSan: before.pvSan,
      replySan: after.pvSan,
      depth: before.depth,
      explanation: explainMove({
        type: verdict.type,
        move,
        loss: verdict.loss,
        bestMove: before.bestMove,
        bestSan: before.bestSan,
        bestPv: before.pv,
        replyPv: after.pv,
        // The played move's own continuation, from its searchmoves search or
        // its candidate entry. An explanation for the played move may quote
        // only this, never the best move's PV.
        playedPv: played ? played.pv || null : null,
        playedLineSan: played && played.lineSan ? played.lineSan : null,
        isEngineChoice: move.uci === before.bestMove,
        // What the move did to the game itself: 'checkmate' or 'draw' when it
        // ended it. A stalemate delivered from a winning position is a
        // different sentence from an evaluation slip.
        terminalAfter: after.terminal || null,
        expectedBefore: expBefore,
        expectedAfter: expAfter,
        sacrificed,
        hadMate,
        mateBefore: before.mateWhite === null ? null : before.mateWhite * sign,
        keptMate: stillMating,
        alternativeCost: verdict.alternativeCost,
        openingName: bookEntry ? bookEntry.n : opening.name,
        phase,
      }),
    });
  }

  const phases = phaseRanges(moves);
  const stats = { w: sideStats(moves, 'w', phases), b: sideStats(moves, 'b', phases) };

  return {
    moves,
    stats,
    opening,
    theory,
    positions,
    phases,
    keyMoments: findKeyMoments(moves),
  };
}

function phaseRanges(moves) {
  const find = (name) => {
    const idx = moves.findIndex((m) => m.phase === name);
    return idx;
  };
  const openingEnd = moves.findIndex((m) => m.phase !== 'opening');
  const endgameStart = find('endgame');
  return {
    opening: [0, openingEnd === -1 ? moves.length : openingEnd],
    middlegame: [
      openingEnd === -1 ? moves.length : openingEnd,
      endgameStart === -1 ? moves.length : endgameStart,
    ],
    endgame: [endgameStart === -1 ? moves.length : endgameStart, moves.length],
  };
}

function sideStats(moves, color, phases) {
  const mine = moves.filter((m) => m.color === color);
  const counts = {};
  for (const key of Object.keys(CLASSIFICATIONS)) counts[key] = 0;
  for (const m of mine) counts[m.classification]++;

  const accuracy = gameAccuracy(mine);
  const scored = mine.filter((m) => m.counts !== false);
  const avgLoss = scored.length
    ? scored.reduce((sum, m) => sum + m.loss, 0) / scored.length
    : 0;

  const inPhase = (name) => gameAccuracy(mine.filter((m) => m.phase === name));
  const hasPhase = (name) => mine.some((m) => m.phase === name);

  return {
    counts,
    accuracy,
    avgWinLoss: avgLoss,
    moveCount: mine.length,
    rating: performanceBand(accuracy),
    phases: {
      opening: hasPhase('opening') ? inPhase('opening') : null,
      middlegame: hasPhase('middlegame') ? inPhase('middlegame') : null,
      endgame: hasPhase('endgame') ? inPhase('endgame') : null,
    },
  };
}

function findKeyMoments(moves) {
  return moves
    .filter((m) => ['blunder', 'miss', 'mistake'].includes(m.classification))
    .sort((a, b) => b.loss - a.loss)
    .slice(0, 3)
    .sort((a, b) => a.index - b.index);
}

export { nonPawnMaterial };
