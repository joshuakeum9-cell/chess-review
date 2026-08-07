/* engine-node.mjs — run a Stockfish wasm build under Node for benchmarking.
 *
 * The browser code talks to a Web Worker; here we talk to the same emscripten
 * module directly. Same UCI protocol, same option handling, so numbers
 * measured here transfer to the app.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const SRC = 'node_modules/stockfish/src/';

export const BUILDS = {
  // The app's vendored copy, so this benchmark measures exactly what ships
  // rather than whatever npm last installed.
  sf16: {
    label: 'Stockfish 16 NNUE',
    entry: 'vendor/sf16/stockfish-nnue-16-single.js',
    wasm: 'vendor/sf16/stockfish-nnue-16-single.wasm',
    nnue: 'nn-5af11540bbfe.nnue',
    api: 'worker',
  },
  sf17lite: {
    label: 'Stockfish 17.1 lite',
    entry: `${SRC}stockfish-17.1-lite-single-03e3232.js`,
    wasm: `${SRC}stockfish-17.1-lite-single-03e3232.wasm`,
    api: 'ccall',
  },
  sf17: {
    label: 'Stockfish 17.1 full',
    entry: `${SRC}stockfish-17.1-single-a496a04.js`,
    // The full build ships its wasm split into six files that have to be
    // concatenated back together before instantiation.
    parts: {
      prefix: `${SRC}stockfish-17.1-single-a496a04`,
      count: 6,
    },
    api: 'ccall',
  },
};

export class NodeEngine {
  constructor(buildId = 'sf17lite') {
    this.spec = BUILDS[buildId];
    if (!this.spec) throw new Error(`unknown build ${buildId}`);
    this.listeners = new Set();
    this.multipv = 0;
  }

  async init({ hash = 64 } = {}) {
    const mod = require(join(root, this.spec.entry));

    // Stockfish 17's `command` export runs the whole search synchronously and
    // prints as it goes, so by the time we could await anything the output has
    // already been and gone. Everything is buffered and consumed by cursor,
    // which works for both that and the 16 build's async Worker API.
    this._buffer = [];
    this._cursor = 0;
    const emit = (line) => {
      const text = String(line);
      this._buffer.push(text);
      for (const fn of [...this.listeners]) fn(text);
    };

    if (this.spec.api === 'ccall') {
      // Stockfish 17 exposes a synchronous `command` export and prints to
      // stdout rather than the Worker message API the 16 build uses.
      const factory = mod();
      // This loader funnels engine output through `listener` and only falls
      // back to console when one is absent, so `print` alone is not enough.
      const config = { listener: emit, print: emit, printErr: () => {} };
      if (this.spec.parts) {
        const chunks = [];
        for (let i = 0; i < this.spec.parts.count; i++) {
          chunks.push(readFileSync(join(root, `${this.spec.parts.prefix}-part-${i}.wasm`)));
        }
        config.wasmBinary = Buffer.concat(chunks);
      } else {
        config.locateFile = () => join(root, this.spec.wasm);
      }
      const engine = await factory(config);
      this._raw = engine;
      this._post = (cmd) => engine.ccall('command', null, ['string'], [cmd]);
    } else {
      // Same two-step factory as above, but this build exposes the Worker
      // style message API instead of a `command` export.
      const factory = mod();
      const engine = await factory({
        locateFile: () => join(root, this.spec.wasm),
        listener: emit,
        print: emit,
        printErr: () => {},
      });
      if (typeof engine.addMessageListener === 'function') engine.addMessageListener(emit);
      this._raw = engine;
      // In this build postMessage is an alias for the pthread broadcast, which
      // does nothing single-threaded. Commands go through onCustomMessage.
      this._post = (cmd) =>
        engine.__IS_SINGLE_THREADED__ || engine.__IS_NON_NESTED__
          ? engine.onCustomMessage(cmd)
          : engine.postMessage(cmd, true);
    }

    this.send('uci');
    await this.expect('uciok', 120000);
    this.send(`setoption name Hash value ${hash}`);
    if (this.spec.nnue) {
      this.send('setoption name Use NNUE value true');
      this.send(`setoption name EvalFile value ${this.spec.nnue}`);
    }
    this.send('isready');
    await this.expect('readyok', 120000);
    return this;
  }

  send(cmd) {
    this._post(cmd);
  }

  /* Consume buffered output up to `token`, waiting only if it has not
   * arrived yet. */
  expect(token, timeoutMs = 600000) {
    for (let i = this._cursor; i < this._buffer.length; i++) {
      if (this._buffer[i].startsWith(token)) {
        this._cursor = i + 1;
        return Promise.resolve(this._buffer[i]);
      }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(fn);
        reject(new Error(`timeout waiting for ${token}`));
      }, timeoutMs);
      const fn = (line) => {
        if (line.startsWith(token)) {
          clearTimeout(timer);
          this.listeners.delete(fn);
          this._cursor = this._buffer.length;
          resolve(line);
        }
      };
      this.listeners.add(fn);
    });
  }

  /* Drop buffered output; call before a search so the buffer cannot grow
   * without bound over a long benchmark. */
  resetBuffer() {
    this._buffer.length = 0;
    this._cursor = 0;
  }

  async setMultiPV(n) {
    if (this.multipv === n) return;
    this.multipv = n;
    this.send(`setoption name MultiPV value ${n}`);
    this.send('isready');
    await this.expect('readyok');
  }

  async newGame() {
    this.send('ucinewgame');
    this.send('isready');
    await this.expect('readyok');
  }

  /* Mirrors the browser Engine.analyse contract, including the
   * one-settled-iteration rule. */
  async analyse(fen, { depth = 14, multipv = 1, searchmoves = null, movetime = null } = {}) {
    await this.setMultiPV(multipv);
    this.resetBuffer();

    const t0 = Date.now();
    this.send(`position fen ${fen}`);
    const limit = movetime ? `movetime ${movetime}` : `depth ${depth}`;
    this.send(
      searchmoves && searchmoves.length
        ? `go ${limit} searchmoves ${searchmoves.join(' ')}`
        : `go ${limit}`
    );
    const best = await this.expect('bestmove');
    const ms = Date.now() - t0;

    const byDepth = new Map();
    let maxDepth = 0;
    let nodes = 0;
    for (const line of this._buffer) {
      if (!line.startsWith('info ') || line.includes(' currmove')) continue;
      if (line.includes('lowerbound') || line.includes('upperbound')) continue;
      const p = parseInfo(line);
      if (!p || p.cp === null) continue;
      if (p.nodes) nodes = p.nodes;
      if (!byDepth.has(p.depth)) byDepth.set(p.depth, new Map());
      byDepth.get(p.depth).set(p.multipv, p);
      if (p.depth > maxDepth) maxDepth = p.depth;
    }

    const depths = [...byDepth.keys()].sort((a, b) => b - a);
    const widest = depths.reduce((m, d) => Math.max(m, byDepth.get(d).size), 0);
    const settled = depths.find((d) => byDepth.get(d).size === widest);
    const chosen = settled === undefined ? new Map() : byDepth.get(settled);

    return {
      lines: [...chosen.values()].sort((a, b) => a.multipv - b.multipv),
      bestMove: best.split(/\s+/)[1],
      depth: settled ?? maxDepth,
      ms,
      nodes,
    };
  }

  quit() {
    try {
      this.send('quit');
    } catch {
      /* already gone */
    }
  }
}

export function parseInfo(line) {
  const t = line.split(/\s+/);
  const out = { depth: 0, multipv: 1, cp: null, mate: null, pv: [], nodes: 0 };
  for (let i = 0; i < t.length; i++) {
    switch (t[i]) {
      case 'depth': out.depth = +t[++i]; break;
      case 'multipv': out.multipv = +t[++i]; break;
      case 'nodes': out.nodes = +t[++i]; break;
      case 'score':
        if (t[i + 1] === 'cp') { out.cp = +t[i + 2]; i += 2; }
        else if (t[i + 1] === 'mate') {
          out.mate = +t[i + 2];
          out.cp = out.mate > 0 ? 100000 - out.mate * 100 : -100000 - out.mate * 100;
          i += 2;
        }
        break;
      case 'pv': out.pv = t.slice(i + 1); i = t.length; break;
      default: break;
    }
  }
  return out;
}
