/* review.js — turns raw engine evaluations into human feedback.
 *
 * The method (the same one lichess and chess.com broadly use):
 *   1. Evaluate every position in the game once, at a fixed depth.
 *      Position i is "before move i"; position i+1 is "after move i".
 *   2. The cost of a move is the drop between those two evaluations, measured
 *      in *expected score* (win %), not raw centipawns — losing 100cp when
 *      you're already up a queen barely matters, losing 100cp in a level
 *      position matters a lot.
 *   3. Classify that drop, with special cases for book moves, forced moves,
 *      only-moves, sacrifices, and thrown-away wins.
 */

import { Chess } from './chess.js';
import { identifyOpening, isBookMove } from './openings.js';

export const CLASSIFICATIONS = {
  brilliant: { label: 'Brilliant', symbol: '!!', color: '#26c2a3', rank: 0 },
  great: { label: 'Great', symbol: '!', color: '#749bbf', rank: 1 },
  best: { label: 'Best', symbol: '★', color: '#81b64c', rank: 2 },
  excellent: { label: 'Excellent', symbol: '✓', color: '#81b64c', rank: 3 },
  good: { label: 'Good', symbol: '✓', color: '#95b776', rank: 4 },
  book: { label: 'Book', symbol: '▤', color: '#a88865', rank: 5 },
  forced: { label: 'Forced', symbol: '⭢', color: '#9c9c9c', rank: 6 },
  inaccuracy: { label: 'Inaccuracy', symbol: '?!', color: '#f7c631', rank: 7 },
  miss: { label: 'Miss', symbol: '⨯', color: '#ff7769', rank: 8 },
  mistake: { label: 'Mistake', symbol: '?', color: '#ffa459', rank: 9 },
  blunder: { label: 'Blunder', symbol: '??', color: '#fa412d', rank: 10 },
};

export const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

const MATE_CP = 100000;

/* Expected score for the side the evaluation refers to, 0-100.
 * Sigmoid fitted by lichess against a large game database. */
export function winPercent(cp) {
  if (cp >= MATE_CP - 10000) return 100;
  if (cp <= -MATE_CP + 10000) return 0;
  const clamped = Math.max(-2000, Math.min(2000, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clamped)) - 1);
}

/* Per-move accuracy, 0-100, from the win% the player gave away. */
export function moveAccuracy(winBefore, winAfter) {
  const drop = Math.max(0, winBefore - winAfter);
  const raw = 103.1668 * Math.exp(-0.04354 * drop) - 3.1669;
  return Math.max(0, Math.min(100, raw));
}

/* Readable evaluation: "+1.35", "-0.20", "M4", "-M2". */
export function formatEval(cpWhite, mateWhite) {
  if (mateWhite !== null && mateWhite !== undefined) {
    // "mate 0" means the position on the board already is mate.
    if (mateWhite === 0) return '#';
    return (mateWhite > 0 ? 'M' : '-M') + Math.abs(mateWhite);
  }
  const pawns = cpWhite / 100;
  return (pawns > 0 ? '+' : pawns < 0 ? '' : '') + pawns.toFixed(2);
}

function materialFor(chess, color) {
  let total = 0;
  for (const row of chess.boardArray()) {
    for (const cell of row) {
      if (cell && cell.color === color) total += PIECE_VALUES[cell.type];
    }
  }
  return total;
}

/* Material balance for `color`, in pawns. */
function balance(chess, color) {
  return materialFor(chess, color) - materialFor(chess, color === 'w' ? 'b' : 'w');
}

/* Convert a UCI principal variation into SAN, for display. */
function pvToSan(fen, pvUci, limit = 12) {
  const board = new Chess(fen);
  const out = [];
  for (const uci of pvUci.slice(0, limit)) {
    const made = board.move(uci);
    if (!made) break;
    out.push(made.san);
  }
  return out;
}

/* A sacrifice is real if, after the opponent's best play, the mover is down
 * material but the evaluation says they are still fine. We reuse the engine's
 * own principal variation rather than guessing at exchanges. */
function detectSacrifice(fenAfterMove, pvUci, mover) {
  const board = new Chess(fenAfterMove);
  const before = balance(board, mover);

  // Play the line out and measure material once it settles. Taking the worst
  // point *during* the line would count every ordinary capture-recapture as a
  // sacrifice, because you are transiently down a piece in the middle of one.
  let played = 0;
  for (const uci of pvUci.slice(0, 10)) {
    if (!board.move(uci)) break;
    played++;
  }
  const settled = balance(board, mover);
  return {
    given: before - settled,
    materialAfterMove: before,
    lineLength: played,
  };
}

function terminalEvaluation(board) {
  if (board.isCheckmate()) {
    // Side to move is mated, so the evaluation is -mate from their point of view.
    return { cp: -MATE_CP, mate: 0, lines: [], bestMove: null, terminal: 'checkmate' };
  }
  return { cp: 0, mate: null, lines: [], bestMove: null, terminal: 'draw' };
}

/* Analyse every position in the game, fanned out across the engine pool so
 * several positions run at once. Progress arrives out of order (that's the
 * point); onProgress reports the completed count.
 * Returns an array of { cpWhite, mateWhite, bestMove, bestSan, pv, pvSan, alt } */
export async function analysePositions(game, pool, opts = {}) {
  const { depth = 12, multipv = 3, onProgress, shouldStop } = opts;

  const fens = [
    game.moves.length ? game.moves[0].fenBefore : game.startFen,
    ...game.moves.map((m) => m.fenAfter),
  ];

  // Terminal positions (mate / stalemate on the board) don't need a search;
  // hand the pool a null so it skips the slot.
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
      const top = res.lines[0] || { cp: 0, mate: null, pv: [] };
      raw = {
        cp: top.cp,
        mate: top.mate ?? null,
        lines: res.lines,
        bestMove: res.bestMove || (top.pv && top.pv[0]) || null,
        depth: res.depth,
      };
    } else {
      // Cancelled before this slot was reached: stop here and return the
      // prefix that has real evaluations.
      break;
    }

    const sign = toMove === 'w' ? 1 : -1;
    const top = raw.lines[0];
    const second = raw.lines[1];

    results.push({
      fen,
      toMove,
      cpWhite: raw.cp * sign,
      mateWhite: raw.mate === null || raw.mate === undefined ? null : raw.mate * sign,
      cpMover: raw.cp,
      bestMove: raw.bestMove,
      bestSan: raw.bestMove ? (new Chess(fen).move(raw.bestMove) || {}).san || null : null,
      pv: top ? top.pv : [],
      pvSan: top ? pvToSan(fen, top.pv) : [],
      altCpMover: second ? second.cp : null,
      altMove: second && second.pv ? second.pv[0] : null,
      // Every candidate move this search scored, from the side-to-move's point
      // of view. Scores inside one search are directly comparable to each
      // other, which is what makes an honest "what did that move cost?" answer
      // possible — see buildReport.
      linesMover: raw.lines.map((l) => ({
        cp: l.cp,
        mate: l.mate ?? null,
        first: l.pv && l.pv[0] ? l.pv[0] : null,
      })),
      altSan:
        second && second.pv && second.pv[0]
          ? (new Chess(fen).move(second.pv[0]) || {}).san || null
          : null,
      // Top candidates, in SAN, for the engine-lines panel.
      candidates: raw.lines.slice(0, 3).map((l) => {
        const probe = new Chess(fen);
        const made = l.pv && l.pv[0] ? probe.move(l.pv[0]) : null;
        return {
          uci: l.pv && l.pv[0] ? l.pv[0] : null,
          san: made ? made.san : null,
          cp: l.cp,
          mate: l.mate ?? null,
          cpWhite: l.cp * sign,
          mateWhite: l.mate === null || l.mate === undefined ? null : l.mate * sign,
          lineSan: pvToSan(fen, l.pv || [], 6),
        };
      }),
      // Score of the move actually played from this position, measured in the
      // same search as the best move. Filled in below.
      playedCpMover: null,
      terminal: raw.terminal || null,
      depth: raw.depth || 0,
    });
  }

  await scorePlayedMoves(game, results, pool, { depth, onProgress, shouldStop });
  return results;
}

/* Second pass.
 *
 * A move's cost is only meaningful if the move you played and the move the
 * engine wanted were scored by the SAME search of the SAME position. When the
 * played move is one of the candidates pass 1 already scored, we have that for
 * free. When it isn't, comparing against the next position's own search
 * introduces a bias (that position is effectively searched one ply deeper),
 * which makes ordinary moves look like mistakes.
 *
 * So: for every played move that pass 1 did not score, ask the engine to
 * search that exact move, at the same depth, in the position it was played.
 */
async function scorePlayedMoves(game, positions, pool, { depth, onProgress, shouldStop }) {
  const jobs = new Array(game.moves.length).fill(null);
  let pending = 0;

  for (let i = 0; i < game.moves.length; i++) {
    const pos = positions[i];
    if (!pos) continue;
    const played = game.moves[i].uci;
    const known = (pos.linesMover || []).find((l) => l.first === played);
    if (known) {
      pos.playedCpMover = known.cp;
    } else if (!new Chess(pos.fen).isGameOver()) {
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
    if (top) positions[i].playedCpMover = top.cp;
  }
}

/* Turn positions + moves into per-move verdicts and whole-game statistics. */
export function buildReport(game, positions) {
  const sanList = game.moves.map((m) => m.san);
  const opening = identifyOpening(sanList);
  const moves = [];

  for (let i = 0; i < game.moves.length; i++) {
    const move = game.moves[i];
    const before = positions[i];
    const after = positions[i + 1];
    if (!before || !after) break;

    const mover = move.color;
    const sign = mover === 'w' ? 1 : -1;

    const evalBeforeMover = before.cpWhite * sign;

    const legalCount = new Chess(before.fen).moves().length;
    const isOnlyMove = legalCount === 1;

    // Both numbers come from the same search of the same position (pass 1 for
    // candidates, pass 2 for everything else), so the difference between them
    // is the real cost of the move rather than search noise.
    const scoredInFrame = before.playedCpMover !== null && before.playedCpMover !== undefined;
    const evalAfterMover = scoredInFrame ? before.playedCpMover : after.cpWhite * sign;

    const isEngineFirstChoice =
      before.bestMove === move.uci ||
      (before.bestSan && before.bestSan === move.san);
    // Positions often have several moves of identical value. If yours scores
    // level with the engine's pick, it is a best move too, whichever one the
    // engine happened to list first.
    const tiedWithBest = scoredInFrame && before.cpMover - before.playedCpMover <= 3;
    const playedBest = isEngineFirstChoice || tiedWithBest;

    const winBefore = winPercent(evalBeforeMover);
    const winAfter = playedBest ? winBefore : winPercent(evalAfterMover);
    const loss = Math.max(0, winBefore - winAfter);

    // How much worse is the second-best move, and where would it have left
    // you? A move is only "great" if the alternative actually surrenders the
    // position. Being the top move while three others also win easily is
    // simply "best".
    let altGap = null;
    let altLeavesYouWorse = false;
    if (before.altCpMover !== null) {
      const altWin = winPercent(before.altCpMover);
      altGap = winPercent(before.cpMover) - altWin;
      altLeavesYouWorse = altWin <= 55;
    }

    const sac = detectSacrifice(move.fenAfter, after.pv, mover);
    const hadMate = before.mateWhite !== null && before.mateWhite * sign > 0;
    const keptMate = after.mateWhite !== null && after.mateWhite * sign > 0;
    const wasWinning = evalBeforeMover >= 200 || hadMate;
    const stillWinning = evalAfterMover >= 200 || keptMate;

    let type;
    if (isOnlyMove) {
      type = 'forced';
    } else if (isBookMove(sanList, i + 1)) {
      type = 'book';
    } else if (
      // A real sacrifice: essentially the best move, still down material once
      // the line settles, position still fine, and you were not already
      // winning easily enough for it to be routine.
      loss <= 1 &&
      playedBest &&
      sac.given >= 2 &&
      sac.lineLength >= 4 &&
      winAfter >= 45 &&
      evalBeforeMover < 300
    ) {
      type = 'brilliant';
    } else if (
      playedBest &&
      loss <= 2 &&
      altGap !== null &&
      altGap >= 12 &&
      altLeavesYouWorse
    ) {
      type = 'great';
    } else if (playedBest) {
      type = 'best';
    } else if (loss < 2) {
      type = 'excellent';
    } else if (loss < 5) {
      type = 'good';
    } else if (loss < 10) {
      type = 'inaccuracy';
    } else if (loss < 20) {
      type = 'mistake';
    } else {
      type = 'blunder';
    }

    // Throwing away a forced win is its own kind of error.
    if ((type === 'mistake' || type === 'inaccuracy') && wasWinning && !stillWinning) {
      type = 'miss';
    }

    moves.push({
      ...move,
      index: i,
      classification: type,
      evalBeforeWhite: before.cpWhite,
      evalAfterWhite: after.cpWhite,
      mateBeforeWhite: before.mateWhite,
      mateAfterWhite: after.mateWhite,
      winBefore,
      winAfter,
      winLoss: loss,
      accuracy: moveAccuracy(winBefore, winAfter),
      bestMove: before.bestMove,
      bestSan: before.bestSan,
      bestLineSan: before.pvSan,
      altSan: before.altSan,
      playedBest,
      isOnlyMove,
      sacrificed: sac.given,
      replySan: after.pvSan,
      depth: before.depth,
      explanation: explain({
        move,
        type,
        loss,
        bestSan: before.bestSan,
        bestLineSan: before.pvSan,
        replySan: after.pvSan,
        evalBeforeMover,
        evalAfterMover,
        hadMate,
        mateBefore: before.mateWhite === null ? null : before.mateWhite * sign,
        sac: sac.given,
        altGap,
      }),
    });
  }

  const phases = splitPhases(game, sanList);
  const stats = {
    w: sideStats(moves, 'w', phases),
    b: sideStats(moves, 'b', phases),
  };
  return {
    moves,
    stats,
    opening,
    positions,
    phases,
    keyMoments: findKeyMoments(moves),
  };
}

/* Non-pawn, non-king material left on the board, both sides, in pawns.
 * Starts at 62 and falls as pieces come off. */
function nonPawnMaterial(fen) {
  const chess = new Chess(fen);
  let total = 0;
  for (const row of chess.boardArray()) {
    for (const cell of row) {
      if (cell && cell.type !== 'p' && cell.type !== 'k') total += PIECE_VALUES[cell.type];
    }
  }
  return total;
}

/* Split the game into opening / middlegame / endgame as half-move ranges.
 * The opening runs until theory does (clamped to 10-24 plies so odd games
 * still get a sensible split); the endgame starts once enough pieces have
 * come off. */
export function splitPhases(game, sanList) {
  const n = game.moves.length;

  let bookEnd = 0;
  for (let i = 1; i <= Math.min(n, 24); i++) {
    if (isBookMove(sanList, i)) bookEnd = i;
  }
  const openingEnd = Math.min(n, Math.max(Math.min(bookEnd, 24), Math.min(n, 10)));

  let endgameStart = n;
  for (let i = 0; i < n; i++) {
    if (nonPawnMaterial(game.moves[i].fenAfter) <= 26) {
      endgameStart = i + 1;
      break;
    }
  }
  endgameStart = Math.max(endgameStart, openingEnd);

  return {
    opening: [0, openingEnd],
    middlegame: [openingEnd, endgameStart],
    endgame: [endgameStart, n],
  };
}

/* The handful of moves that actually decided the game. */
function findKeyMoments(moves) {
  return moves
    .filter((m) => ['blunder', 'miss', 'mistake'].includes(m.classification))
    .sort((a, b) => b.winLoss - a.winLoss)
    .slice(0, 3)
    .sort((a, b) => a.index - b.index);
}

function meanAccuracy(list) {
  // Book moves are excluded — reciting theory isn't a measure of your play.
  const scored = list.filter((m) => m.classification !== 'book');
  if (!scored.length) return null;
  return scored.reduce((sum, m) => sum + m.accuracy, 0) / scored.length;
}

function sideStats(moves, color, phases) {
  const mine = moves.filter((m) => m.color === color);
  const counts = {};
  for (const key of Object.keys(CLASSIFICATIONS)) counts[key] = 0;
  for (const m of mine) counts[m.classification]++;

  const accuracy = meanAccuracy(mine) ?? 100;
  const scored = mine.filter((m) => m.classification !== 'book');
  const avgLoss = scored.length
    ? scored.reduce((sum, m) => sum + m.winLoss, 0) / scored.length
    : 0;

  const inPhase = (range) =>
    mine.filter((m) => m.index >= range[0] && m.index < range[1]);

  return {
    counts,
    accuracy,
    avgWinLoss: avgLoss,
    moveCount: mine.length,
    rating: estimateRating(accuracy),
    phases: phases
      ? {
          opening: meanAccuracy(inPhase(phases.opening)),
          middlegame: meanAccuracy(inPhase(phases.middlegame)),
          endgame: meanAccuracy(inPhase(phases.endgame)),
        }
      : null,
  };
}

/* Rough performance band. Deliberately coarse — it is a sanity check, not a
 * rating system. */
function estimateRating(accuracy) {
  const table = [
    [95, 2400],
    [90, 2100],
    [85, 1850],
    [80, 1650],
    [75, 1450],
    [70, 1250],
    [65, 1050],
    [55, 850],
    [0, 650],
  ];
  for (const [threshold, rating] of table) {
    if (accuracy >= threshold) return rating;
  }
  return 600;
}

/* Plain-English feedback for one move. */
function explain(ctx) {
  const {
    move,
    type,
    loss,
    bestSan,
    bestLineSan,
    replySan,
    evalAfterMover,
    hadMate,
    mateBefore,
    sac,
    altGap,
  } = ctx;

  const line = bestLineSan && bestLineSan.length ? bestLineSan.slice(0, 5).join(' ') : null;
  const punish = replySan && replySan.length ? replySan.slice(0, 4).join(' ') : null;
  // Only name an alternative when it is genuinely a different move from the
  // one that was played. Suggesting the move you already made reads as a bug.
  const other = bestSan && bestSan !== move.san ? bestSan : null;
  const cost = loss >= 1 ? `${loss.toFixed(0)}%` : 'almost nothing';

  switch (type) {
    case 'book':
      return 'Still in known opening theory.';
    case 'forced':
      return 'The only legal move, so there was nothing to decide here.';
    case 'brilliant':
      return `A sound sacrifice. You give up about ${sac.toFixed(0)} points of material and the position still favours you${line ? `: ${line}` : '.'}`;
    case 'great':
      return `The only move that holds. Every alternative gives up roughly ${altGap.toFixed(0)}% of your expected score.`;
    case 'best':
      return line
        ? `The engine's top choice. It continues ${line}.`
        : "The engine's top choice.";
    case 'excellent':
      return other
        ? `As good as makes no difference. ${other} scores fractionally higher.`
        : 'Level with the best move.';
    case 'good':
      return other
        ? `Perfectly playable. ${other} was a touch sharper.`
        : 'Perfectly playable.';
    case 'inaccuracy':
      return `This lets ${cost} of your expected score slip.${other ? ` ${other} was cleaner${line ? `: ${line}` : '.'}` : ''}`;
    case 'miss':
      return hadMate
        ? `You had a forced mate here${mateBefore ? ` in ${Math.abs(mateBefore)}` : ''}.${other ? ` ${other} wins${line ? `: ${line}` : '.'}` : ''}`
        : `You were clearly winning and this gives it up.${other ? ` ${other} kept the win${line ? `: ${line}` : '.'}` : ''}`;
    case 'mistake':
      return `${other ? `${other} was much better${line ? ` (${line})` : ''}.` : 'There was much better here.'}${punish ? ` Now ${punish} is strong for your opponent.` : ''}`;
    case 'blunder':
      return `${describeLoss(evalAfterMover)}${other ? ` ${other} was the move${line ? `: ${line}` : '.'}` : ''}${punish ? ` Your opponent's best reply is ${punish}.` : ''}`;
    default:
      return '';
  }
}

function describeLoss(evalAfterMover) {
  if (evalAfterMover <= -MATE_CP + 10000) return 'This walks into a forced mate.';
  if (evalAfterMover < -500) return 'This loses decisive material.';
  if (evalAfterMover < -200) return 'This hands your opponent a serious advantage.';
  return 'This throws away a large part of your position.';
}
