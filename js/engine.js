/* engine.js — Stockfish in Web Workers, speaking UCI.
 *
 * Two layers:
 *   Engine     — one Stockfish instance in one Web Worker (promise API).
 *   EnginePool — several Engines side by side. Each worker is single-threaded,
 *                but N workers analyse N *different positions* at once, which
 *                is what makes whole-game analysis fast: a 100-position game
 *                on 4 workers runs ~4x quicker than one engine grinding
 *                through the list.
 *
 * Everything runs in your browser. Nothing is sent to a server.
 *
 * Engine binary, in order of preference:
 *   1. vendor/stockfish.wasm.js — WebAssembly build, shipped with the app,
 *      3-5x faster than asm.js.
 *   2. vendor/stockfish.js     — asm.js build, for browsers without wasm.
 *   3. CDN asm.js build through a blob shim (importScripts is allowed
 *      cross-origin, `new Worker(url)` is not). Last resort — e.g. someone
 *      serving the app without the vendor directory.
 */

const CDN_URL = 'https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/stockfish.js';

const wasmSupported =
  typeof WebAssembly === 'object' &&
  WebAssembly.validate(
    Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00)
  );

let cachedSource = null;

/* Work out once which engine build is available, then reuse the answer for
 * every worker in the pool. */
async function resolveSource() {
  if (cachedSource) return cachedSource;
  const candidates = [];
  if (wasmSupported) candidates.push('vendor/stockfish.wasm.js');
  candidates.push('vendor/stockfish.js');

  for (const path of candidates) {
    try {
      const res = await fetch(path, { method: 'HEAD' });
      if (res.ok) {
        cachedSource = { kind: 'url', path };
        return cachedSource;
      }
    } catch {
      /* not served locally — keep looking */
    }
  }

  const shim = `importScripts(${JSON.stringify(CDN_URL)});`;
  const blobUrl = URL.createObjectURL(
    new Blob([shim], { type: 'application/javascript' })
  );
  cachedSource = { kind: 'cdn', path: blobUrl };
  return cachedSource;
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

  async init({ hash = 32 } = {}) {
    if (this.ready) return this;
    const source = await resolveSource();
    this.worker = new Worker(source.path);
    this.source = source.kind === 'cdn' ? 'cdn' : source.path;

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

/* ------------------------------------------------------------------ */
/* EnginePool                                                          */
/* ------------------------------------------------------------------ */

/* How many workers to run. One core is left for the page itself; capped
 * because each engine carries its own memory and past ~6 the returns fade. */
export function defaultPoolSize() {
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  return Math.max(2, Math.min(6, cores - 1));
}

export class EnginePool {
  constructor(size = defaultPoolSize()) {
    this.size = size;
    this.engines = [];
    this.ready = false;
    this.source = null;
  }

  async init() {
    if (this.ready) return this;
    // Boot in parallel; if some workers fail (low memory), keep the ones
    // that made it — one engine is enough to function.
    const boots = Array.from({ length: this.size }, () =>
      new Engine().init().then(
        (engine) => engine,
        () => null
      )
    );
    this.engines = (await Promise.all(boots)).filter(Boolean);
    if (!this.engines.length) {
      throw new Error('No engine worker could be started');
    }
    this.size = this.engines.length;
    this.source = this.engines[0].source;
    this.ready = true;
    return this;
  }

  async newGame() {
    await Promise.all(this.engines.map((e) => e.newGame()));
  }

  /* Analyse one position on the first idle engine (used by explore mode). */
  async analyseOne(fen, opts) {
    const engine = this.engines.find((e) => !e._searching) || this.engines[0];
    return engine.analyse(fen, opts);
  }

  /* Analyse many positions concurrently, preserving input order in the
   * result. `jobs` is an array of FEN strings or nulls (null slots are
   * skipped and come back as null — the caller fills them in itself).
   *
   * onResult(index, result, doneCount) fires as each position finishes —
   * note: out of order, that's the point. */
  async analyseAll(jobs, { depth, multipv, onResult, shouldStop } = {}) {
    const results = new Array(jobs.length).fill(null);
    let next = 0;
    let done = 0;

    const runner = async (engine) => {
      for (;;) {
        if (shouldStop && shouldStop()) return;
        const index = next++;
        if (index >= jobs.length) return;
        if (jobs[index] === null) {
          done++;
          continue;
        }
        const result = await engine.analyse(jobs[index], { depth, multipv });
        results[index] = result;
        done++;
        if (onResult) onResult(index, result, done);
      }
    };

    await Promise.all(this.engines.map((engine) => runner(engine)));
    return results;
  }

  stopAll() {
    for (const engine of this.engines) engine.stop();
  }

  quit() {
    for (const engine of this.engines) engine.quit();
    this.engines = [];
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
