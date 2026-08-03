/* perft — exhaustively counts legal move sequences and compares against the
 * published reference values. If these pass, move generation is correct
 * (castling, en passant, promotion, pins, discovered check, the lot).
 * Run: node test/perft.mjs
 */
import { Chess, parsePgn } from '../js/chess.js';

function perft(game, depth) {
  if (depth === 0) return 1;
  const moves = game._generateMoves({ legal: true });
  if (depth === 1) return moves.length;
  let nodes = 0;
  for (const move of moves) {
    game._makeMove(move);
    nodes += perft(game, depth - 1);
    game._undoMove();
  }
  return nodes;
}

const positions = [
  {
    name: 'startpos',
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    expect: [20, 400, 8902, 197281],
  },
  {
    name: 'kiwipete',
    fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    expect: [48, 2039, 97862],
  },
  {
    name: 'position 3 (ep / promotion heavy)',
    fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
    expect: [14, 191, 2812, 43238],
  },
  {
    name: 'position 4 (promotions)',
    fen: 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1',
    expect: [6, 264, 9467],
  },
  {
    name: 'position 5',
    fen: 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
    expect: [44, 1486, 62379],
  },
];

let failures = 0;
for (const pos of positions) {
  for (let depth = 1; depth <= pos.expect.length; depth++) {
    const game = new Chess(pos.fen);
    const t0 = Date.now();
    const got = perft(game, depth);
    const want = pos.expect[depth - 1];
    const ok = got === want;
    if (!ok) failures++;
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${pos.name} depth ${depth}: ` +
        `${got}${ok ? '' : ` (expected ${want})`}  [${Date.now() - t0}ms]`
    );
  }
}

/* Round-trip a real PGN with castling, promotion, en passant and check. */
const pgn = `[Event "Test"]
[Result "1-0"]

1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 6. Be3 e5 7. Nb3 Be6
8. f3 Be7 9. Qd2 O-O 10. O-O-O Nbd7 11. g4 b5 12. g5 b4 13. Ne2 Ne8 14. f4 a5
15. f5 a4 16. Nbd4 exd4 17. Nxd4 b3 18. Kb1 bxc2+ 19. Nxc2 Bb3 20. axb3 axb3 1-0`;

try {
  const parsed = parsePgn(pgn);
  const ok = parsed.moves.length === 40 && parsed.moves[39].san === 'axb3';
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  pgn round-trip: ${parsed.moves.length} plies, ` +
      `last = ${parsed.moves[parsed.moves.length - 1].san}`
  );
} catch (err) {
  failures++;
  console.log(`FAIL  pgn round-trip: ${err.message}`);
}

/* Underpromotion, en passant and checkmate detection in SAN. */
const edge = new Chess('4k3/6P1/8/8/8/8/8/4K3 w - - 0 1');
const sans = edge.moves().sort().join(',');
const edgeOk = sans.includes('g8=N') && sans.includes('g8=Q+');
if (!edgeOk) failures++;
console.log(`${edgeOk ? 'PASS' : 'FAIL'}  promotion SAN: ${sans}`);

/* Fool's mate: after 1. f3 e5 2. g4, Qh4 is mate. */
const mate = new Chess('rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq g3 0 2');
const mateOk = mate.moves().includes('Qh4#');
if (!mateOk) failures++;
console.log(`${mateOk ? 'PASS' : 'FAIL'}  checkmate SAN detection`);

/* En passant must be legal and must remove the captured pawn. */
const ep = new Chess('rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3');
const epMove = ep.move('exf6');
const epOk = epMove !== null && ep.get('f5') === null && ep.get('f6') !== null;
if (!epOk) failures++;
console.log(`${epOk ? 'PASS' : 'FAIL'}  en passant capture removes the pawn`);

/* Castling rights must vanish when the rook is captured on its home square. */
const cr = new Chess('r3k2r/8/8/8/8/8/6b1/R3K2R b KQkq - 0 1');
cr.move('Bxh1');
const crOk = !cr.fen().includes('K') || cr.fen().split(' ')[2] === 'Qkq';
if (!crOk) failures++;
console.log(`${crOk ? 'PASS' : 'FAIL'}  castling rights lost on rook capture (${cr.fen().split(' ')[2]})`);

console.log(failures === 0 ? '\nAll perft checks passed.' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
