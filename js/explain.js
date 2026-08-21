/* explain.js — the coaching voice.
 *
 * The rule here is that every sentence has to be earned by something read off
 * the board. "This loses material" is only said when static exchange says a
 * piece can be won; a fork is only named when a piece really does attack two
 * targets; a mate is only claimed when the engine reports one. Generic filler
 * is worse than saying less, because a player who checks the board and finds
 * the claim false stops trusting the rest.
 */

import {
  moveFacts,
  hangingPieces,
  forkTargets,
  backRankRisk,
  materialSwing,
  lineToSan,
  formatLine,
  PIECE_NAMES,
} from './tactics.js?v=202608212125';
import { Chess } from './chess.js?v=202608212125';

const PLURAL = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function pawnsText(cp) {
  const pawns = Math.abs(cp) / 100;
  if (pawns >= 8.5) return 'a queen';
  if (pawns >= 4.5) return 'a rook';
  if (pawns >= 2.9) return 'a piece';
  if (pawns >= 1.6) return 'the exchange';
  if (pawns >= 0.9) return 'a pawn';
  return null;
}

/* What the opponent's best reply does to you, named concretely. */
function punishment(fenAfterMove, replyPv, mover) {
  if (!replyPv || !replyPv.length) return null;
  const facts = moveFacts(fenAfterMove, replyPv[0]);
  if (!facts) return null;

  const sans = lineToSan(fenAfterMove, replyPv, 4);
  const line = formatLine(fenAfterMove, sans);
  const swing = materialSwing(fenAfterMove, replyPv, mover, 6);

  if (facts.givesMate) return { text: `${facts.san} is mate`, line };
  // When the reply is a capture, name what it takes: "Nxh5 wins the queen"
  // reads true to a player watching the queen leave the board, where the
  // net-swing bucket ("wins a rook", queen minus knight) reads like a bug.
  if (facts.isCapture && facts.capturedName && ['queen', 'rook'].includes(facts.capturedName) && swing.delta <= -280) {
    return { text: `${facts.san} wins the ${facts.capturedName}`, line };
  }
  if (swing.delta <= -280) {
    const what = pawnsText(swing.delta);
    return { text: `${facts.san} wins ${what || 'material'}`, line };
  }
  if (facts.isCapture && swing.delta <= -90) {
    return { text: `${facts.san} just takes the ${facts.capturedName}`, line };
  }
  if (facts.givesCheck) return { text: `${facts.san} comes with check`, line };
  return { text: `${facts.san} is the reply`, line };
}

/* Why the engine's move was better, in terms of what it does. */
function bestMoveIdea(fenBefore, bestPv) {
  if (!bestPv || !bestPv.length) return null;
  const facts = moveFacts(fenBefore, bestPv[0]);
  if (!facts) return null;

  const board = new Chess(fenBefore);
  const mover = board.turn;
  const sans = lineToSan(fenBefore, bestPv, 6);
  const line = formatLine(fenBefore, sans);
  const swing = materialSwing(fenBefore, bestPv, mover, 8);

  let idea = null;
  if (facts.givesMate) idea = 'mates on the spot';
  else if (swing.delta >= 280) idea = `wins ${pawnsText(swing.delta) || 'material'}`;
  else if (facts.isCapture && swing.delta >= 90) idea = `wins the ${facts.capturedName}`;
  else {
    // Not tactical, so say what it does structurally.
    const after = new Chess(fenBefore);
    after.move(bestPv[0]);
    const forks = forkTargets(after.fen(), facts.to);
    if (forks.length >= 2) {
      idea = `forks the ${forks.map((f) => f.name).join(' and ')}`;
    } else if (facts.isCastle) {
      idea = 'gets the king to safety';
    } else if (hangingPieces(fenBefore, mover).length > hangingPieces(after.fen(), mover).length) {
      idea = 'deals with the loose piece first';
    }
  }
  return { san: facts.san, idea, line };
}

/* The main entry point. Returns a short paragraph. */
export function explainMove(ctx) {
  const {
    type,
    move, // {uci, san, color, fenBefore, fenAfter}
    loss,
    bestMove, // uci
    bestSan,
    bestPv, // uci[]
    replyPv, // uci[] from the position after the move
    playedPv = null, // uci[] continuation of the PLAYED move, when known
    playedLineSan = null,
    isEngineChoice = false,
    terminalAfter = null, // 'checkmate' | 'draw' when the move ended the game
    expectedBefore,
    expectedAfter,
    sacrificed,
    hadMate,
    mateBefore,
    keptMate,
    alternativeCost,
    openingName,
    phase,
  } = ctx;

  const facts = moveFacts(move.fenBefore, move.uci);
  const mover = move.color;
  const differs = bestSan && bestSan !== move.san;
  const best = differs ? bestMoveIdea(move.fenBefore, bestPv) : null;
  const hurt = punishment(move.fenAfter, replyPv, mover);

  // A move that ended the game in a draw from a winning position is almost
  // always a stalemate delivered by accident. Name it: "this loses 50% of
  // expected score" is technically true and completely misses the point.
  const board = new Chess(move.fenAfter);
  const isStalemate = terminalAfter === 'draw' && board.isStalemate();

  // Only pieces this move NEWLY left takeable. Leading with a piece that was
  // already hanging before the move blames the wrong decision, and can bury
  // the move's real cost behind a stray pawn.
  const hangingBefore = new Set(
    hangingPieces(move.fenBefore, mover).map((h) => h.square + h.type)
  );
  const nowHanging = hangingPieces(move.fenAfter, mover).filter(
    (h) => !hangingBefore.has(h.square + h.type)
  );

  // The continuation an explanation may quote for the played move. The best
  // move's PV is a different move's future and must never be shown as this
  // move's "play continues".
  const ownLine = playedLineSan && playedLineSan.length
    ? playedLineSan
    : playedPv && playedPv.length
      ? lineToSan(move.fenBefore, playedPv, 5)
      : null;

  switch (type) {
    case 'book':
      return openingName
        ? `Still theory: this is the ${openingName}.`
        : 'Still inside known opening theory.';

    case 'forced':
      return facts && facts.givesCheck
        ? 'The only legal move, and it comes with check.'
        : 'The only legal move, so there was nothing to decide.';

    case 'brilliant': {
      const what = pawnsText(sacrificed) || 'material';
      const why = best && best.line ? ` The point runs ${best.line}.` : '';
      return `A genuine sacrifice. You give up ${what} and the position still holds, which is exactly the kind of move that is easy to reject over the board.${why}`;
    }

    case 'great': {
      const margin = alternativeCost ? Math.round(alternativeCost) : null;
      const alt = margin
        ? ` Every other move gives up around ${margin}% of your expected score.`
        : '';
      const why = best && best.line ? ` It continues ${best.line}.` : '';
      return `The only move that holds here.${alt}${why}`;
    }

    case 'best': {
      if (isEngineChoice) {
        // Only the engine's actual first choice may borrow its idea and PV.
        const own = bestMoveIdea(move.fenBefore, bestPv);
        const idea = own && own.idea ? `, which ${own.idea}` : '';
        const line = bestPv && bestPv.length
          ? ` Play continues ${formatLine(move.fenBefore, lineToSan(move.fenBefore, bestPv, 5))}.`
          : '';
        return `The engine's first choice${idea}.${line}`;
      }
      // Tied with the engine's pick but a different move. Say that, and quote
      // this move's own continuation or nothing: quoting the other move's
      // line here was the single largest source of false explanation claims.
      const line = ownLine && ownLine.length
        ? ` Play continues ${formatLine(move.fenBefore, ownLine)}.`
        : '';
      return `Every bit as strong as the engine's ${bestSan || 'choice'}.${line}`;
    }

    case 'excellent':
      return differs
        ? `As good as makes no difference. ${bestSan} scores a fraction higher, but nothing here changes.`
        : 'Level with the best move.';

    case 'good':
      return differs
        ? `Perfectly playable. ${bestSan} was a touch more precise${best && best.idea ? `: it ${best.idea}` : ''}.`
        : 'Perfectly playable.';

    case 'inaccuracy': {
      const cost = `This lets about ${Math.round(loss)}% of your expected score slip.`;
      const loose = nowHanging.length
        ? ` It also leaves the ${nowHanging[0].name} on ${nowHanging[0].square} loose.`
        : '';
      const better = best
        ? ` ${best.san} was cleaner${best.idea ? `: it ${best.idea}` : ''}.`
        : '';
      return `${cost}${loose}${better}`;
    }

    case 'miss': {
      if (isStalemate) {
        return `This is stalemate: the opponent has no legal move and the game is drawn on the spot.${hadMate && best ? ` ${best.san} ${mateBefore ? `mates in ${Math.abs(mateBefore)}` : 'wins'}: ${best.line}.` : ''}`;
      }
      if (hadMate && !keptMate) {
        const inN = mateBefore ? ` in ${Math.abs(mateBefore)}` : '';
        return `There was a forced mate${inN} here and this lets it go.${best ? ` ${best.san} finishes it: ${best.line}.` : ''}`;
      }
      const had = Math.round(expectedBefore);
      const now = Math.round(expectedAfter);
      // "Gives it back" would overstate a win that is merely smaller now.
      if (expectedAfter >= 60) {
        return `A faster win was there and this lets it slip, from about ${had}% to ${now}%.${best ? ` ${best.san} kept full control: ${best.line}.` : ''}`;
      }
      return `You were winning and this gives it back, from about ${had}% down to ${now}%.${best ? ` ${best.san} kept it: ${best.line}.` : ''}`;
    }

    case 'mistake':
    case 'blunder': {
      const parts = [];

      // Lead with the concrete consequence, if there is one. When both a
      // newly hanging piece and a tactical reply exist, lead with whichever
      // costs more: a stray pawn must not bury a fork that wins a rook.
      const replySwing = replyPv && replyPv.length
        ? -materialSwing(move.fenAfter, replyPv, mover, 6).delta
        : 0;
      const hangGain = nowHanging.length ? nowHanging[0].gain : 0;

      if (isStalemate) {
        parts.push('This is stalemate: the opponent has no legal move and the game is drawn on the spot.');
        if (hadMate && best) {
          parts.push(`${best.san} ${mateBefore ? `mates in ${Math.abs(mateBefore)}` : 'wins'}: ${best.line}.`);
          return parts.join(' ');
        }
      } else if (facts && nowHanging.length && hangGain >= replySwing - 100) {
        const h = nowHanging[0];
        parts.push(
          `This leaves the ${h.name} on ${h.square} hanging.`
        );
      } else if (hurt && /mate/.test(hurt.text)) {
        parts.push('This walks into a forced mate.');
      } else if (expectedAfter <= 5) {
        parts.push('This loses the game outright.');
      } else if (type === 'blunder') {
        parts.push(`This throws away about ${Math.round(loss)}% of your expected score.`);
      } else {
        parts.push(`This costs about ${Math.round(loss)}% of your expected score.`);
      }

      if (hurt) parts.push(`${hurt.text}: ${hurt.line}.`);
      if (best) {
        parts.push(
          `${best.san} was the move${best.idea ? `, which ${best.idea}` : ''}${best.line ? `: ${best.line}` : ''}.`
        );
      }

      // Only mention a back rank when it is genuinely the theme.
      if (
        !nowHanging.length &&
        hurt &&
        /mate/.test(hurt.text) &&
        backRankRisk(move.fenAfter, mover)
      ) {
        parts.push('Your back rank is the weakness: the king has no escape square.');
      }

      return parts.join(' ');
    }

    default:
      return '';
  }
}
