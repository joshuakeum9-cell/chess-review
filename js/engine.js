/* engine.js — a small promise-based wrapper around Stockfish speaking UCI.
 *
 * The engine runs entirely in a Web Worker in your browser. Nothing is sent to
 * a server. It is loaded from, in order of preference:
 *   1. vendor/stockfish.wasm.js  (fast WebAssembly build, if you ran `npm run vendor`)
 *   2. a CDN copy of the asm.js build, pulled in through a blob shim
 *      (importScripts is allowed cross-origin, `new Worker(url)` is not)
 */

const CDN_URL = 'https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/stockfish.js';
const LOCAL_CANDIDATES = ['vendor/stockfish.wasm.js', 'vendor/stockfish.js'];

async function createWorker() {
  for (const path of LOCAL_CANDIDATES) {
    try {
      const res = await fetch(path, { method: 'HEAD' });
      if (res.ok) return { worker: new Worker(path), source: path };
    } catch {
      /* not vendored locally — fall through to the CDN */
    }
  }
  const shim = `importScripts(${JSON.stringify(CDN_URL)});`;
  const blobUrl = URL.createObjectURL(
    new Blob([shim], { type: 'application/javascript' })
  );
  return { worker: new Worker(blobUrl), source: 'cdn' };
}

export class Engine {
  constructor() {
    this.worker = null;
    this.source = null;
    this.ready = false;
    this._listeners = new Set();
    this._multipv = 0;
    this._searching = false;
  }

  _onLine(line) {
    for (const fn of [...this._listeners]) fn(line);
  }

  _send(cmd) {
    this.worker.postMessage(cmd);
  }

  /* Resolves once the engine answers with `token`. */
  _await(token, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._listeners.delete(listener);
        reject(new Error(`Engine timed out waiting for "${token}"`));
      }, timeoutMs);
      const listener = (line) => {
        if (line.startsWith(token)) {
          clearTimeout(timer);
          this._listeners.delete(listener);
          resolve(line);
        }
      };
      this._listeners.add(listener);
    });
  }

  async init({ hash = 64 } = {}) {
    if (this.ready) return this;
    const { worker, source } = await createWorker();
    this.worker = worker;
    this.source = source;

    this.worker.onmessage = (e) => {
      const data = typeof e.data === 'string' ? e.data : e.data && e.data.data;
      if (typeof data === 'string') this._onLine(data);
    };
    this.worker.onerror = (e) => {
      this._onLine(`error ${e.message || 'worker failed'}`);
    };

    this._send('uci');
    await this._await('uciok', 90000);
    this._send(`setoption name Hash value ${hash}`);
    this._send('isready');
    await this._await('readyok');
    this.ready = true;
    return this;
  }

  async setMultiPV(n) {
    if (this._multipv === n) return;
    this._multipv = n;
    this._send(`setoption name MultiPV value ${n}`);
    this._send('isready');
    await this._await('readyok');
  }

  async newGame() {
    this._send('ucinewgame');
    this._send('isready');
    await this._await('readyok');
  }

  /* Analyse one position.
   * Returns { lines: [{ multipv, cp, mate, depth, pv:[uci] }], bestMove, depth }
   * Scores are from the point of view of the side to move. */
  async analyse(fen, { depth = 14, multipv = 2, onProgress } = {}) {
    if (!this.ready) throw new Error('Engine not initialised');
    await this.setMultiPV(multipv);

    const lines = new Map();
    let maxDepth = 0;

    const listener = (line) => {
      if (!line.startsWith('info ') || line.includes(' currmove')) return;
      const parsed = parseInfo(line);
      if (!parsed || parsed.cp === null) return;
      lines.set(parsed.multipv, parsed);
      if (parsed.depth > maxDepth) {
        maxDepth = parsed.depth;
        if (onProgress) onProgress(parsed);
      }
    };

    this._listeners.add(listener);
    this._searching = true;
    try {
      this._send(`position fen ${fen}`);
      this._send(`go depth ${depth}`);
      const best = await this._await('bestmove', 180000);
      const bestMove = best.split(/\s+/)[1];
      const ordered = [...lines.values()].sort((a, b) => a.multipv - b.multipv);
      return {
        lines: ordered,
        bestMove: bestMove === '(none)' ? null : bestMove,
        depth: maxDepth,
      };
    } finally {
      this._searching = false;
      this._listeners.delete(listener);
    }
  }

  stop() {
    if (this._searching) this._send('stop');
  }

  quit() {
    if (!this.worker) return;
    try {
      this._send('quit');
    } catch {
      /* worker may already be gone */
    }
    this.worker.terminate();
    this.worker = null;
    this.ready = false;
  }
}

/* `info depth 12 multipv 1 score cp 34 ... pv e2e4 e7e5` */
function parseInfo(line) {
  const tokens = line.split(/\s+/);
  const out = { depth: 0, multipv: 1, cp: null, mate: null, pv: [], nodes: 0, nps: 0 };
  for (let i = 0; i < tokens.length; i++) {
    switch (tokens[i]) {
      case 'depth':
        out.depth = parseInt(tokens[++i], 10);
        break;
      case 'multipv':
        out.multipv = parseInt(tokens[++i], 10);
        break;
      case 'nodes':
        out.nodes = parseInt(tokens[++i], 10);
        break;
      case 'nps':
        out.nps = parseInt(tokens[++i], 10);
        break;
      case 'score':
        if (tokens[i + 1] === 'cp') {
          out.cp = parseInt(tokens[i + 2], 10);
          i += 2;
        } else if (tokens[i + 1] === 'mate') {
          out.mate = parseInt(tokens[i + 2], 10);
          out.cp = out.mate > 0 ? 100000 - out.mate * 100 : -100000 - out.mate * 100;
          i += 2;
        }
        break;
      case 'pv':
        out.pv = tokens.slice(i + 1);
        i = tokens.length;
        break;
      default:
        break;
    }
  }
  // Ignore fail-high/fail-low reports; they are not stable evaluations.
  if (line.includes('lowerbound') || line.includes('upperbound')) return null;
  return out;
}
