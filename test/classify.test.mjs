/* Unit tests for the pieces of the classifier that must be right regardless
 * of what the engine says: static exchange evaluation, sacrifice detection,
 * expected score, opening recognition and the accuracy curve.
 *
 * Run: node test/classify.test.mjs
 */
import { Chess } from '../js/chess.js';
import {
  staticExchange,
  sacrificeSize,
  expectedScore,
  expectedFromCp,
  volatility,
  accuracyForLoss,
  gameAccuracy,
  classifyMove,
  nonPawnMaterial,
} from '../js/classify.js';
import { identifyOpening, bookDepth, lookupPosition, OPENING_COUNT } from '../js/openings.js';

let failures = 0;
function check(label, got, want, tolerance = 0) {
  const ok =
    typeof want === 'number' ? Math.abs(got - want) <= tolerance : got === want;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${got}${ok ? '' : ` want ${want}`}`);
}

console.log('--- static exchange evaluation ---');
{
  // Free pawn: rook takes an undefended pawn.
  const c = new Chess('4k3/8/8/8/8/4p3/8/4RK2 w - - 0 1');
  check('free pawn is +100', staticExchange(c, 'e3', 'w'), 100);
}
{
  // Defended pawn: Rxd3 loses the rook to cxd3, so the capture is declined
  // and the exchange is worth nothing.
  const c = new Chess('4k3/8/8/8/2p5/3p4/8/3RK3 w - - 0 1');
  check('rook taking a pawn-defended pawn wins nothing', staticExchange(c, 'd3', 'w'), 0);
}
{
  // Equal trade: knight takes knight, defended once, we recapture.
  const c = new Chess('4k3/8/2n5/8/3N4/8/8/4K3 w - - 0 1');
  check('undefended knight is +320', staticExchange(c, 'c6', 'w'), 320);
}
{
  // Nothing on the square and nothing attacking it.
  const c = new Chess('4k3/8/8/8/8/8/8/4K3 w - - 0 1');
  check('empty quiet square is 0', staticExchange(c, 'd4', 'w'), 0);
}

console.log('\n--- sacrifice detection ---');
{
  // Ordinary recapture must NOT read as a sacrifice: this is the exact bug
  // that produced eight "brilliant" moves in one game.
  const fen = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2';
  const chess = new Chess(fen);
  const move = chess.moves({ verbose: true }).find((m) => m.san === 'exd5');
  check('pawn takes pawn is not a sacrifice', sacrificeSize(fen, move) <= 0, true);
}
{
  // The Greek gift: Bxh7+ gives a bishop for a pawn defended by the king.
  const fen = 'rnbq1rk1/ppp2ppp/4pn2/3p4/3P4/2NB1N2/PPP2PPP/R1BQK2R w KQ - 0 7';
  const chess = new Chess(fen);
  const move = chess.moves({ verbose: true }).find((m) => m.toSquare === 'h7');
  check('Bxh7+ is detected as a sacrifice', move ? sacrificeSize(fen, move) : 0, 230);
}
{
  // Winning a piece is not a sacrifice, however forcing it looks.
  const fen = '4k3/8/2n5/8/3N4/8/8/4K3 w - - 0 1';
  const chess = new Chess(fen);
  const move = chess.moves({ verbose: true }).find((m) => m.toSquare === 'c6');
  check('capturing a free knight is not a sacrifice', sacrificeSize(fen, move) <= 0, true);
}

console.log('\n--- expected score ---');
check('mate is 100', expectedScore({ mate: 3 }), 100);
check('being mated is 0', expectedScore({ mate: -2 }), 0);
check('equal cp is 50', expectedFromCp(0), 50, 0.01);
check(
  'wdl beats cp for a dead draw',
  expectedScore({ wdl: { win: 3, draw: 994, loss: 3 }, cp: 0 }),
  50,
  0.1
);
check(
  'wdl reflects a winning position',
  expectedScore({ wdl: { win: 1000, draw: 0, loss: 0 }, cp: 755 }),
  100
);
check('dead draw has low volatility', volatility({ wdl: { win: 3, draw: 994, loss: 3 } }) < 5, true);
check(
  'sharp position has high volatility',
  volatility({ wdl: { win: 450, draw: 100, loss: 450 } }) > 80,
  true
);

console.log('\n--- accuracy curve ---');
check('no loss is 100%', accuracyForLoss(0), 100, 0.01);
check('10 point loss', accuracyForLoss(10) < 70, true);
check('50 point loss is near zero', accuracyForLoss(50) < 15, true);
check(
  'harmonic mean punishes one blunder',
  gameAccuracy([
    { accuracy: 100, volatility: 50 },
    { accuracy: 100, volatility: 50 },
    { accuracy: 100, volatility: 50 },
    { accuracy: 10, volatility: 50 },
  ]) < 80,
  true
);
check(
  'clean game scores high',
  gameAccuracy(Array.from({ length: 30 }, () => ({ accuracy: 98, volatility: 50 }))) > 95,
  true
);

console.log('\n--- classification ---');
const baseCandidates = [
  { uci: 'e2e4', expected: 55 },
  { uci: 'd2d4', expected: 54 },
  { uci: 'g1f3', expected: 53 },
];
check(
  'engine choice is Best',
  classifyMove({
    before: { expected: 55 },
    after: { expected: 55 },
    played: { uci: 'e2e4' },
    bestMove: 'e2e4',
    candidates: baseCandidates,
  }).type,
  'best'
);
check(
  'only legal move is Forced',
  classifyMove({
    before: { expected: 20 },
    after: { expected: 10 },
    played: { uci: 'a1a2' },
    bestMove: 'a1a2',
    legalCount: 1,
  }).type,
  'forced'
);
check(
  'big drop is a Blunder',
  classifyMove({
    before: { expected: 55 },
    after: { expected: 15 },
    played: { uci: 'h2h4' },
    bestMove: 'e2e4',
    candidates: baseCandidates,
  }).type,
  'blunder'
);
check(
  'losing a won game is a Miss',
  classifyMove({
    before: { expected: 95 },
    after: { expected: 60 },
    played: { uci: 'h2h4' },
    bestMove: 'e2e4',
    candidates: baseCandidates,
  }).type,
  'miss'
);
check(
  'already-lost position does not blunder further',
  classifyMove({
    before: { expected: 2 },
    after: { expected: 0 },
    played: { uci: 'h2h4' },
    bestMove: 'e2e4',
    candidates: baseCandidates,
  }).type !== 'blunder',
  true
);
check(
  'already-won position does not blunder',
  classifyMove({
    before: { expected: 99 },
    after: { expected: 98 },
    played: { uci: 'h2h4' },
    bestMove: 'e2e4',
    candidates: baseCandidates,
  }).type !== 'blunder',
  true
);
check(
  'tie with best still counts as Best',
  classifyMove({
    before: { expected: 55 },
    after: { expected: 54.8 },
    played: { uci: 'd2d4' },
    bestMove: 'e2e4',
    candidates: baseCandidates,
  }).type,
  'best'
);
check(
  'only-move that holds is Great',
  classifyMove({
    before: { expected: 50 },
    after: { expected: 50 },
    played: { uci: 'e2e4' },
    bestMove: 'e2e4',
    candidates: [
      { uci: 'e2e4', expected: 50 },
      { uci: 'd2d4', expected: 25 },
    ],
  }).type,
  'great'
);
check(
  'sacrifice while already winning is not Brilliant',
  classifyMove({
    before: { expected: 92 },
    after: { expected: 92 },
    played: { uci: 'e2e4' },
    bestMove: 'e2e4',
    candidates: baseCandidates,
    sacrificed: 300,
  }).type !== 'brilliant',
  true
);
check(
  'sound sacrifice from a level position is Brilliant',
  classifyMove({
    before: { expected: 55 },
    after: { expected: 55 },
    played: { uci: 'e2e4' },
    bestMove: 'e2e4',
    candidates: baseCandidates,
    sacrificed: 300,
  }).type,
  'brilliant'
);

console.log('\n--- opening book ---');
check('book has thousands of positions', OPENING_COUNT > 3000, true);
{
  const g = new Chess();
  const fens = [];
  for (const san of ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']) {
    g.move(san);
    fens.push(g.fen());
  }
  const op = identifyOpening(fens);
  check('names the Ruy Lopez', /Ruy Lopez/.test(op.name || ''), true);
  check('reports an ECO code', /^C6/.test(op.eco || ''), true);
  check('book depth reaches the last theory move', bookDepth(fens), 5);
}
{
  // Transposition: the same position by a different move order must resolve.
  const a = new Chess();
  for (const san of ['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4']) a.move(san);
  const b = new Chess();
  for (const san of ['c4', 'Nf6', 'd4', 'e6', 'Nc3', 'Bb4']) b.move(san);
  const nameA = lookupPosition(a.fen());
  const nameB = lookupPosition(b.fen());
  check('transposition resolves to the same opening', nameA && nameB && nameA.n === nameB.n, true);
  check('and it is the Nimzo-Indian', /Nimzo/.test((nameA && nameA.n) || ''), true);
}

console.log('\n--- phase detection ---');
check(
  'start position is not an endgame',
  nonPawnMaterial('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1') > 2600,
  true
);
check('bare kings and pawns is an endgame', nonPawnMaterial('4k3/pppppppp/8/8/8/8/PPPPPPPP/4K3 w - - 0 1') <= 2600, true);

console.log(failures === 0 ? '\nAll classifier tests passed.' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
