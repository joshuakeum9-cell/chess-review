/* classify.js — how a move gets its verdict.
 *
 * The measure is expected score, not centipawns.
 *
 * Centipawns answer "who is better and by how much", which is not the
 * question. A move that drops the evaluation from +9.0 to +6.0 loses 300
 * centipawns and changes nothing; a move that drops +0.3 to -0.5 loses less
 * and throws the game away. What matters is how much of the *result* you gave
 * up, so everything below is denominated in expected score: 100 means you
 * score a full point with best play, 50 means a draw, 0 means you lose.
 *
 * Expected score comes from Stockfish's own win/draw/loss statistics
 * (UCI_ShowWDL) rather than a curve fitted to centipawns. That distinction
 * carries real information: +0.0 in a sharp middlegame and +0.0 in an
 * opposite-coloured-bishop ending are both "equal", but the engine reports
 * 90% draws for one and 99.4% for the other, and only the second is a
 * position where nothing you do matters much. A fitted sigmoid cannot see the
 * difference. Where WDL is unavailable the sigmoid is used as a fallback.
 */

import { Chess, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING } from './chess.js?v=202608220228';

/* Colors follow the measured default review palette; the glyph drawings and
 * chip rendering live in js/icons.js. */
export const CLASSIFICATIONS = {
  brilliant: { label: 'Brilliant', symbol: '!!', color: '#26c2a3', rank: 0 },
  great: { label: 'Great', symbol: '!', color: '#749bbf', rank: 1 },
  best: { label: 'Best', symbol: '★', color: '#81b64c', rank: 2 },
  excellent: { label: 'Excellent', symbol: '👍', color: '#81b64c', rank: 3 },
  good: { label: 'Good', symbol: '✓', color: '#95b776', rank: 4 },
  book: { label: 'Book', symbol: '▤', color: '#d5a47d', rank: 5 },
  forced: { label: 'Forced', symbol: '⭢', color: '#9c9c9c', rank: 6 },
  inaccuracy: { label: 'Inaccuracy', symbol: '?!', color: '#f7c631', rank: 7 },
  miss: { label: 'Miss', symbol: '✕', color: '#ff7769', rank: 8 },
  mistake: { label: 'Mistake', symbol: '?', color: '#ffa459', rank: 9 },
  blunder: { label: 'Blunder', symbol: '??', color: '#fa412d', rank: 10 },
};

export const PIECE_VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
export const MATE_CP = 100000;

/* ------------------------------------------------------------------ */
/* expected score                                                      */
/* ------------------------------------------------------------------ */

/* Fallback when the engine does not report WDL. Lichess's fitted curve. */
export function expectedFromCp(cp) {
  if (cp >= MATE_CP - 10000) return 100;
  if (cp <= -MATE_CP + 10000) return 0;
  const clamped = Math.max(-2000, Math.min(2000, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clamped)) - 1);
}

/* Which scale the classifier measures loss on.
 *
 * 'cp'    the fitted centipawn curve  (default, and it earned it)
 * 'wdl'   the engine's own win/draw/loss expectation
 * 'blend' the average of the two
 *
 * Win/draw/loss looks like the better measure and is the more principled
 * statement about the *result*. It is not the better measure of a *move*,
 * and this was settled by experiment rather than argument. Measured against
 * Lichess's judgments over 18 games (bench/scale-bench.mjs):
 *
 *   scale   recall  precision  exact   F1
 *   wdl     52.0%   61.5%      46.9%   56.4%
 *   cp      61.0%   86.2%      58.7%   71.4%
 *   blend   50.4%   68.9%      50.0%   58.2%
 *
 * The reason is saturation. Past roughly two and a half pawns a strong engine
 * wins essentially every time, so win/draw/loss reports 100 and keeps
 * reporting 100 however much further ahead you get. Every move in a winning
 * position then looks identical, including the ones that threw half the
 * advantage away, and the scale has no resolution left exactly where a lot of
 * real errors happen. The centipawn curve keeps its resolution across the
 * whole practical range.
 *
 * Win/draw/loss is still used, for volatility: how drawish a position is
 * remains the right thing to weight accuracy by, and it does not saturate in
 * the same damaging way.
 */
export let LOSS_SCALE = 'cp';
export function setLossScale(scale) {
  LOSS_SCALE = scale;
}

/* Expected score 0-100 for the side to move.
 * `wdl` is per-mille {win, draw, loss} as Stockfish reports it. */
export function expectedScore({ wdl = null, cp = 0, mate = null } = {}) {
  if (mate !== null && mate !== undefined) return mate > 0 ? 100 : 0;
  const curve = expectedFromCp(cp);
  if (!wdl || !Number.isFinite(wdl.win)) return curve;
  const fromWdl = (wdl.win + wdl.draw / 2) / 10;

  if (LOSS_SCALE === 'cp') return curve;
  if (LOSS_SCALE === 'wdl') return fromWdl;

  /* Blend. Win/draw/loss is the better read on whether a position is truly
   * drawn or truly decided, which is what stops dead positions being graded.
   * But it saturates: past about two and a half pawns a strong engine wins
   * every time, so it reports 100 and keeps reporting 100 however much
   * further ahead you get. Two moves that both leave you "winning" then look
   * identical when one of them threw away half the advantage.
   *
   * Averaging the two keeps the draw-awareness while restoring resolution in
   * the range where advantages are actually won and lost. */
  return (fromWdl + curve) / 2;
}

/* How decisive the position is: 0 means a certain draw, 100 means the result
 * is entirely undetermined. Used to tell "nothing matters here" positions
 * from sharp ones. */
export function volatility({ wdl = null, cp = 0 } = {}) {
  if (wdl && Number.isFinite(wdl.draw)) return 100 - wdl.draw / 10;
  // Without WDL, infer sharpness from how far from equal the score is.
  return Math.min(100, 30 + Math.abs(cp) / 20);
}

/* ------------------------------------------------------------------ */
/* static exchange evaluation                                          */
/* ------------------------------------------------------------------ */

/* What the side to move nets by initiating captures on `square`, in
 * centipawns, assuming both sides keep taking while it pays.
 *
 * This is how a real sacrifice is told apart from an ordinary trade. Walking
 * the engine's principal variation and looking at material cannot do it: in
 * any capture sequence you are transiently down a piece, so every recapture
 * looks like a sacrifice. SEE answers the actual question, which is whether
 * the material comes back.
 */
export function staticExchange(chess, square, side, depth = 0) {
  if (depth > 32) return 0;
  const index = typeof square === 'string' ? squareIndex(square) : square;

  const attackers = chess.attackersOf(index, side);
  if (!attackers.length) return 0;

  const victim = chess.board[index];
  if (!victim) return 0;
  const victimValue = PIECE_VALUES[victim.type];

  // Always take with the cheapest attacker.
  const attacker = attackers[0];
  const next = chess.clone();
  next.board[index] = { type: attacker.type, color: side };
  next.board[attacker.square] = null;

  const opponent = side === 'w' ? 'b' : 'w';
  const gain = victimValue - staticExchange(next, index, opponent, depth + 1);

  // Either side may decline to continue the exchange, so a losing capture is
  // simply not played. That "stand pat" is what makes the result the true
  // material outcome rather than the outcome of capturing blindly.
  return Math.max(0, gain);
}

function squareIndex(name) {
  return 'abcdefgh'.indexOf(name[0]) + (8 - parseInt(name[1], 10)) * 16;
}

/* Material the mover invested in this move, in centipawns.
 * Positive means they gave material up. */
export function sacrificeSize(fenBefore, move) {
  const before = new Chess(fenBefore);
  const mover = before.turn;
  const captured = before.get(move.to);
  const capturedValue = captured ? PIECE_VALUES[captured.type] : 0;

  const after = new Chess(fenBefore);
  if (!after.move(move.uci)) return 0;

  // What the opponent nets by capturing on the destination square.
  const opponent = mover === 'w' ? 'b' : 'w';
  const recapture = staticExchange(after, move.to, opponent);
  if (recapture <= 0) return 0; // nothing hanging, so nothing sacrificed

  return recapture - capturedValue;
}

/* ------------------------------------------------------------------ */
/* classification                                                      */
/* ------------------------------------------------------------------ */

/* Thresholds on expected-score loss, in points of expected result.
 *
 * These are not round numbers picked by feel. They were swept against
 * Lichess's own judgments over 1419 plies of real games (bench/tune.mjs),
 * scoring each combination on how well it reproduces an outside opinion.
 * Moving `good` from 5 to 6 and `inaccuracy` from 10 to 12 lifted precision
 * from 75.7% to 86.0% for 5.7 points of recall, which is the right trade: a
 * verdict the player checks and disagrees with costs more trust than a mild
 * inaccuracy left unmarked.
 */
const LOSS = {
  excellent: 2,
  good: 6,
  inaccuracy: 12,
  mistake: 18,
};

/* Positions where the result is already settled. Nothing you do there is
 * really a blunder, and grading them as such is the single biggest source of
 * false positives: an extra queen thrown away while still mating is not the
 * same mistake as one that loses a drawn game. */
const DECIDED_HIGH = 97;
const DECIDED_LOW = 3;

/**
 * @param {object} ctx
 *  before        expected score for the mover before the move, plus wdl/cp/mate
 *  after         expected score for the mover after the move
 *  played        {uci, san}
 *  bestMove      engine's first choice (uci)
 *  candidates    [{uci, expected}] from the same search, best first
 *  legalCount    number of legal moves in the position
 *  isBook        position still in the opening dataset
 *  sacrificed    centipawns invested, from sacrificeSize()
 *  hadMate       mover had a forced mate available
 *  keptMate      mover still has a forced mate
 */
export function classifyMove(ctx) {
  const {
    before,
    after,
    played,
    bestMove,
    candidates = [],
    legalCount = 20,
    isBook = false,
    sacrificed = 0,
    hadMate = false,
    keptMate = false,
    isRecapture = false,
    inCheck = false,
  } = ctx;

  const expBefore = before.expected;
  const expAfter = after.expected;
  const rawLoss = Math.max(0, expBefore - expAfter);

  const isEngineChoice = played.uci === bestMove;
  // Positions routinely have several moves of identical value. Which one the
  // engine happens to list first is arbitrary, so a move level with it is a
  // best move too.
  const tiedWithBest = rawLoss <= 0.5;
  const playedBest = isEngineChoice || tiedWithBest;
  const loss = playedBest ? 0 : rawLoss;

  // How many moves keep the position within a hair of the best. A position
  // with one saving move is a different test from one with six good ones.
  const viable = candidates.filter((c) => expBefore - c.expected <= 3).length;
  const onlyGoodMove = viable === 1 && candidates.length > 1;
  const secondBest = candidates[1];
  const alternativeCost = secondBest ? expBefore - secondBest.expected : null;

  const decided =
    (expBefore >= DECIDED_HIGH && expAfter >= DECIDED_HIGH) ||
    (expBefore <= DECIDED_LOW && expAfter <= DECIDED_LOW);

  const result = {
    loss,
    rawLoss,
    playedBest,
    isEngineChoice,
    viable,
    onlyGoodMove,
    alternativeCost,
    decided,
    accuracy: accuracyForLoss(loss),
  };

  if (legalCount === 1) return { ...result, type: 'forced' };
  if (isBook) return { ...result, type: 'book', loss: 0, accuracy: 100 };

  // --- brilliant ----------------------------------------------------
  // A sound sacrifice that a human could plausibly miss. Every clause here
  // exists to kill a specific false positive.
  if (
    sacrificed >= 150 && // a real piece, not an exchange shuffle
    loss <= 2 && // still essentially the best move
    playedBest && // and actually the engine's choice
    expAfter >= 45 && // you are not worse for it
    expBefore < 85 && // not already winning, where sacs are routine cleanup
    !hadMate && // giving material into a mate you already had is not brilliance
    !isRecapture && // taking back is never the brilliant part
    !inCheck // nor is a forced escape that happens to shed material
  ) {
    return { ...result, type: 'brilliant' };
  }

  // --- great --------------------------------------------------------
  // The one move that held, in a position where finding it was a real
  // decision.
  //
  // The trap here is that "only move that does not lose" describes most
  // recaptures. If the opponent takes your bishop, taking back is the only
  // move that keeps material, every alternative drops a piece, and none of
  // that makes it a great move: it is the move anybody plays without
  // thinking. Left unguarded this fired on 4.7% of all plies, roughly five
  // times what it should be.
  if (
    playedBest &&
    !decided &&
    onlyGoodMove &&
    !isRecapture && // taking back is not a discovery
    !inCheck && // nor is getting out of check with the one legal escape
    legalCount >= 5 && // there has to have been a choice to get wrong
    alternativeCost !== null &&
    alternativeCost >= 10
  ) {
    return { ...result, type: 'great' };
  }

  if (playedBest) return { ...result, type: 'best' };

  // Nothing meaningful is at stake, so nothing here is an error.
  if (decided) {
    return { ...result, type: loss < LOSS.good ? 'excellent' : 'good' };
  }

  // --- missed win ---------------------------------------------------
  // Miss covers letting a win shrink: you had a forced mate or a decisive
  // advantage, played something that keeps less of it, and are still in the
  // game. It must NOT swallow outright collapses: throwing a won position
  // into a draw (a delivered stalemate is the classic case) or into a loss
  // is a blunder however winning you were the move before, and labelling it
  // "miss" both softens the verdict and produces explanation text that talks
  // about a missed mate while the game just ended.
  const wasWinning = hadMate || expBefore >= 85;
  const stillWinning = keptMate || expAfter >= 85;
  const missedMate = hadMate && !keptMate;
  if (wasWinning && !stillWinning && loss >= LOSS.good && loss < LOSS.mistake) {
    return { ...result, type: 'miss', missedMate };
  }

  if (loss < LOSS.excellent) return { ...result, type: 'excellent' };
  if (loss < LOSS.good) return { ...result, type: 'good' };
  if (loss < LOSS.inaccuracy) return { ...result, type: 'inaccuracy' };
  if (loss < LOSS.mistake) return { ...result, type: 'mistake' };
  return { ...result, type: 'blunder', missedMate };
}

/* ------------------------------------------------------------------ */
/* accuracy                                                            */
/* ------------------------------------------------------------------ */

/* Per-move accuracy from expected-score loss. Lichess's published curve,
 * which maps a loss of 0 to 100% and decays fast enough that a single
 * blunder is felt without swamping everything else. */
export function accuracyForLoss(loss) {
  const raw = 103.1668 * Math.exp(-0.04354 * loss) - 3.1669;
  return Math.max(0, Math.min(100, raw));
}

/* Volatility weights for game accuracy, Lichess's published method.
 *
 * For each move, take a sliding window of the win% series around it and use
 * the standard deviation of that window as the move's weight. A mistake made
 * while the evaluation is swinging (sharp position, both sides erring) counts
 * more than one made while the line is flat. Window size scales with game
 * length, clamped to [2, 8]; weights clamped to [0.5, 12].
 *
 * `winPercents` is the white-POV win% for every position, length = plies + 1.
 * Returns one weight per ply.
 */
export function volatilityWeights(winPercents) {
  const plies = winPercents.length - 1;
  if (plies <= 0) return [];
  const windowSize = Math.max(2, Math.min(8, Math.ceil(plies / 10)));
  const weights = new Array(plies);
  for (let i = 0; i < plies; i++) {
    const start = Math.max(0, i + 2 - windowSize);
    const slice = winPercents.slice(start, i + 2);
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const variance = slice.reduce((a, b) => a + (b - mean) * (b - mean), 0) / slice.length;
    weights[i] = Math.max(0.5, Math.min(12, Math.sqrt(variance)));
  }
  return weights;
}

/* Game accuracy for one side.
 *
 * A plain mean is wrong: it treats a mistake in a dead-drawn endgame the same
 * as one in a razor-sharp middlegame, and it lets a long tail of trivial
 * moves bury a decisive error. Following Lichess's published method, each
 * move is weighted by the local volatility of the win% series, and the
 * weighted mean is combined with a harmonic mean, which punishes the worst
 * moves rather than letting them average out.
 *
 * `moves` is [{ accuracy, weight }] for one player, in game order.
 */
export function gameAccuracy(moves) {
  const scored = moves.filter((m) => m.counts !== false);
  if (!scored.length) return 100;
  if (scored.length === 1) return scored[0].accuracy;

  const weights = scored.map((m) => Math.max(0.5, Math.min(12, m.weight ?? 1)));
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  const weightedMean =
    scored.reduce((sum, m, i) => sum + m.accuracy * weights[i], 0) / totalWeight;

  const harmonic =
    scored.length / scored.reduce((sum, m) => sum + 1 / Math.max(m.accuracy, 1), 0);

  return Math.max(0, Math.min(100, (weightedMean + harmonic) / 2));
}

/* Accuracy computed from a bare evaluation series, white POV, using the same
 * formula end to end. Used by the benchmarks to compute what Lichess would
 * say from its own evals, and usable on ours for cross-checking. `series` is
 * [{cp, mate}] per position, length = plies + 1. Returns {white, black}.
 *
 * `startTurn` matters: games loaded from a position (Lichess "From Position",
 * puzzles, adjourned games) can have Black moving first, and assuming
 * white-first silently attributes every move to the wrong player. That is not
 * a theoretical case; it produced 28-point accuracy "disagreements" in the
 * benchmark before it was caught. */
export function accuracyFromSeries(series, startTurn = 'w') {
  const win = series.map((s) =>
    s.mate !== null && s.mate !== undefined ? (s.mate > 0 ? 100 : 0) : expectedFromCp(s.cp)
  );
  const weights = volatilityWeights(win);
  const white = [];
  const black = [];
  for (let i = 0; i + 1 < win.length; i++) {
    const whiteMoves = startTurn === 'w' ? i % 2 === 0 : i % 2 === 1;
    const before = whiteMoves ? win[i] : 100 - win[i];
    const after = whiteMoves ? win[i + 1] : 100 - win[i + 1];
    const acc = accuracyForLoss(Math.max(0, before - after));
    (whiteMoves ? white : black).push({ accuracy: acc, weight: weights[i] });
  }
  return { white: gameAccuracy(white), black: gameAccuracy(black) };
}

/* Estimated game rating from accuracy, by linear interpolation between
 * anchor points rather than coarse steps.
 *
 * The old step table ran about 250 Elo below what chess.com's Game Review
 * shows for the same game. The anchors here are calibrated against real
 * chess.com review output (accuracy 89.8 -> their 2100, 81.2 -> their 1900,
 * verified on an actual reviewed game) with a plausible curve continued
 * through the rest of the range. Still an estimate, not a rating: chess.com's
 * own number also folds in factors accuracy alone cannot see. */
export function performanceBand(accuracy) {
  const anchors = [
    [99, 3000],
    [96, 2600],
    [93, 2300],
    [90, 2100],
    [85, 2000],
    [81, 1900],
    [75, 1700],
    [68, 1450],
    [60, 1200],
    [50, 950],
    [0, 650],
  ];
  if (accuracy >= anchors[0][0]) return anchors[0][1];
  for (let i = 0; i + 1 < anchors.length; i++) {
    const [hiA, hiR] = anchors[i];
    const [loA, loR] = anchors[i + 1];
    if (accuracy >= loA) {
      const t = (accuracy - loA) / (hiA - loA);
      return Math.round((loR + t * (hiR - loR)) / 50) * 50;
    }
  }
  return 650;
}

/* ------------------------------------------------------------------ */
/* game phase                                                          */
/* ------------------------------------------------------------------ */

export function nonPawnMaterial(fen) {
  const chess = new Chess(fen);
  let total = 0;
  for (const row of chess.boardArray()) {
    for (const cell of row) {
      if (cell && cell.type !== PAWN && cell.type !== KING) total += PIECE_VALUES[cell.type];
    }
  }
  return total;
}

export function phaseOf(fen, bookPlies, ply) {
  if (ply <= bookPlies) return 'opening';
  return nonPawnMaterial(fen) <= 2600 ? 'endgame' : 'middlegame';
}
