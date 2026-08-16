/* Truthfulness tests for the explanation layer.
 *
 * These encode the failures the release audit found: explanations claiming a
 * tied move was "the engine's first choice" while quoting a different move's
 * line, stalemates described as evaluation slips, and pre-existing loose
 * pieces blamed on the wrong move.
 *
 * Run: node test/explain.test.mjs
 */
import { explainMove } from '../js/explain.js';
import { classifyMove, LOSS_SCALE } from '../js/classify.js';

let failures = 0;
function check(label, got, want) {
  const ok = typeof want === 'boolean' ? got === want : got === want;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `: got ${JSON.stringify(got)}`}`);
}

/* A quiet middlegame position where several moves are close: after
 * 1.e4 e5 2.Nf3 Nc6 3.Bc4, Black to move. */
const FEN = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3';
const AFTER_NF6 = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';

console.log('--- tied-with-best explanations ---');
{
  // Played Nf6, engine preferred Bc5. Tied on evaluation.
  const text = explainMove({
    type: 'best',
    move: { uci: 'g8f6', san: 'Nf6', color: 'b', fenBefore: FEN, fenAfter: AFTER_NF6 },
    loss: 0,
    bestMove: 'f8c5',
    bestSan: 'Bc5',
    bestPv: ['f8c5', 'c2c3', 'g8f6'],
    isEngineChoice: false,
    playedPv: ['g8f6', 'd2d3', 'f8c5'],
    expectedBefore: 50,
    expectedAfter: 50,
  });
  check('tied move never claims to be the first choice', /first choice/.test(text), false);
  check('tied move names the engine alternative', /Bc5/.test(text), true);
  check('tied move quotes its own continuation, not the alternative line', /continues 3\.\.\. Nf6/.test(text), true);
}
{
  // Same move when it IS the engine choice keeps the strong claim.
  const text = explainMove({
    type: 'best',
    move: { uci: 'g8f6', san: 'Nf6', color: 'b', fenBefore: FEN, fenAfter: AFTER_NF6 },
    loss: 0,
    bestMove: 'g8f6',
    bestSan: 'Nf6',
    bestPv: ['g8f6', 'd2d3', 'f8c5'],
    isEngineChoice: true,
    expectedBefore: 50,
    expectedAfter: 50,
  });
  check('engine choice keeps the first-choice claim', /first choice/.test(text), true);
}
{
  // Tied move with no known continuation must not invent one.
  const text = explainMove({
    type: 'best',
    move: { uci: 'g8f6', san: 'Nf6', color: 'b', fenBefore: FEN, fenAfter: AFTER_NF6 },
    loss: 0,
    bestMove: 'f8c5',
    bestSan: 'Bc5',
    bestPv: ['f8c5', 'c2c3'],
    isEngineChoice: false,
    playedPv: null,
    expectedBefore: 50,
    expectedAfter: 50,
  });
  check('no invented continuation without the played PV', /Play continues/.test(text), false);
}

console.log('\n--- stalemate awareness ---');
{
  // K+Q vs K: Qf7 stalemates from a mate-in-one position.
  const text = explainMove({
    type: 'miss',
    move: { uci: 'f1f7', san: 'Qf7', color: 'w', fenBefore: '7k/8/6K1/8/8/8/8/5Q2 w - - 0 1', fenAfter: '7k/5Q2/6K1/8/8/8/8/8 b - - 1 1' },
    loss: 50,
    bestMove: 'f1f8',
    bestSan: 'Qf8#',
    bestPv: ['f1f8'],
    terminalAfter: 'draw',
    hadMate: true,
    mateBefore: 1,
    expectedBefore: 100,
    expectedAfter: 50,
  });
  check('stalemate is named', /stalemate/i.test(text), true);
  check('drawn on the spot is stated', /drawn/.test(text), true);
}
{
  // A checkmate delivered must never be described as a draw.
  const text = explainMove({
    type: 'best',
    move: { uci: 'f1f8', san: 'Qf8#', color: 'w', fenBefore: '7k/8/6K1/8/8/8/8/5Q2 w - - 0 1', fenAfter: '5Q1k/8/6K1/8/8/8/8/8 b - - 1 1' },
    loss: 0,
    bestMove: 'f1f8',
    bestSan: 'Qf8#',
    bestPv: ['f1f8'],
    isEngineChoice: true,
    terminalAfter: 'checkmate',
    expectedBefore: 100,
    expectedAfter: 100,
  });
  check('checkmate not described as stalemate', /stalemate/i.test(text), false);
}

console.log('\n--- miss wording ---');
{
  const still = explainMove({
    type: 'miss',
    move: { uci: 'g8f6', san: 'Nf6', color: 'b', fenBefore: FEN, fenAfter: AFTER_NF6 },
    loss: 10,
    bestMove: 'f8c5',
    bestSan: 'Bc5',
    bestPv: ['f8c5'],
    expectedBefore: 88,
    expectedAfter: 78,
  });
  check('still-winning miss is not "gives it back"', /gives it back/.test(still), false);
  const gone = explainMove({
    type: 'miss',
    move: { uci: 'g8f6', san: 'Nf6', color: 'b', fenBefore: FEN, fenAfter: AFTER_NF6 },
    loss: 40,
    bestMove: 'f8c5',
    bestSan: 'Bc5',
    bestPv: ['f8c5'],
    expectedBefore: 90,
    expectedAfter: 50,
  });
  check('win-to-equal miss says gives it back', /gives it back/.test(gone), true);
}

console.log(failures === 0 ? '\nAll explanation tests passed.' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
