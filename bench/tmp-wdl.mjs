import { NodeEngine } from './engine-node.mjs';
const e = await new NodeEngine('sf17lite').init();
e.send('setoption name UCI_ShowWDL value true');
e.send('isready'); await e.expect('readyok');
const tests = [
  ['startpos', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'],
  ['drawish R ending +1 pawn', '8/5pk1/6p1/8/8/6P1/5PK1/R6r w - - 0 1'],
  ['sharp middlegame', 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQ1RK1 b kq - 5 4'],
  ['white up a queen', 'rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'],
  ['opposite bishops draw', '8/5k2/4b3/8/8/4B3/5K2/8 w - - 0 1'],
];
for (const [label, fen] of tests) {
  await e.newGame(); e.resetBuffer();
  e.send(`position fen ${fen}`); e.send('go depth 14');
  await e.expect('bestmove');
  const info = e._buffer.filter(l=>l.includes(' wdl ')).slice(-1)[0] || '(no wdl)';
  const m = info.match(/score cp (-?\d+).*? wdl (\d+) (\d+) (\d+)/);
  if (m) { const [cp,w,d,l] = m.slice(1).map(Number); console.log(`${label.padEnd(26)} cp ${String(cp).padStart(5)}  W/D/L ${w}/${d}/${l}  expected ${(((w+d/2)/1000)*100).toFixed(1)}%`); }
  else console.log(label.padEnd(26), info.slice(0,70));
}
e.quit(); process.exit(0);
