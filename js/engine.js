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

/* Engine builds, best first.
 *
 * Stockfish 16 evaluates with a neural network (NNUE) rather than the
 * hand-written heuristics of the 2018 build below it. That is the difference
 * between "roughly right about tactics" and "right about quiet positional
 * judgement too", which is exactly what move classification depends on. It
 * costs a 38 MB network file, downloaded once and then cached.
 *
 * The older builds stay as fallbacks for browsers without WebAssembly SIMD,
 * and for anyone serving the app without the vendor directory. */
const BUILDS = [
  {
    id: 'sf17',
    label: 'Stockfish 17.1',
    js: 'vendor/sf17/stockfish-17.1-lite-single-03e3232.js',
    // Benchmarked against Lichess cloud evaluations, the lite network matches
    // the full one on evaluation error (69.5 vs 75.2 mean centipawns) while
    // being a tenth of the download and more than twice as fast. The full
    // build's apparent edge disappears once it is not grading itself.
    needsWasm: true,
    wdl: true,
  },
  {
    id: 'sf10-wasm',
    label: 'Stockfish 10',
    js: 'vendor/stockfish.wasm.js',
    needsWasm: true,
  },
  { id: 'sf10-asm', label: 'Stockfish 10 (asm.js)', js: 'vendor/stockfish.js' },
];

const failedBuilds = new Set();
let cachedBuild = null;
let nnueWarmed = null;

function cdnBuild() {
  const shim = `importScripts(${JSON.stringify(CDN_URL)});`;
  return {
    id: 'cdn',
    label: 'Stockfish 10 (CDN)',
    js: URL.createObjectURL(new Blob([shim], { type: 'application/javascript' })),
  };
}

/* Pull the network file once up front so the pool's workers all read it from
 * the browser cache instead of racing for the same 38 MB. */
function warmNnue(build) {
  if (!build.nnue) return Promise.resolve();
  if (!nnueWarmed) nnueWarmed = fetch(build.nnue).then((r) => r.arrayBuffer()).catch(() => null);
  return nnueWarmed;
}

/* Work out once which engine build is available, then reuse the answer for
 * every worker in the pool. */
async function resolveBuild() {
  if (cachedBuild && !failedBuilds.has(cachedBuild.id)) return cachedBuild;
  for (const build of BUILDS) {
    if (failedBuilds.has(build.id)) continue;
    if (build.needsWasm && !wasmSupported) continue;
    try {
      const res = await fetch(build.js, { method: 'HEAD' });
      if (!res.ok) continue;
    } catch {
      continue; // not served locally, keep looking
    }
    cachedBuild = build;
    return build;
  }
  cachedBuild = cdnBuild();
  return cachedBuild;
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

  async init({ hash = 16, build = null } = {}) {
    if (this.ready) return this;
    const chosen = build || (await resolveBuild());
    await warmNnue(chosen);
    this.build = chosen;
    this.worker = new Worker(chosen.js);
    this.source = chosen.label;

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

    if (chosen.wdl) {
      // Ask for win/draw/loss statistics alongside the centipawn score. This
      // is what lets a verdict be measured in expected score rather than a
      // curve fitted to centipawns; see classify.js.
      this._send('setoption name UCI_ShowWDL value true');
    }

    if (chosen.nnue) {
      // The network is off by default in this build and has to be switched on
      // explicitly. Without this you get the classical evaluation, which is
      // the whole thing we upgraded away from.
      this._send('setoption name Use NNUE value true');
      this._send(`setoption name EvalFile value ${chosen.nnue}`);
    } else if (!chosen.wdl) {
      // Stockfish 10 defaults to a positive contempt, which deliberately skews
      // the score in favour of whoever is to move so it plays on for a win.
      // Right for playing, wrong for analysis: the skew flips sign every ply
      // and shows up as phantom losses on perfectly good moves. Later builds
      // dropped the option entirely.
      this._send('setoption name Contempt value 0');
      this._send('setoption name Analysis Contempt value Off');
    }

    this._send('isready');
    await this._await('readyok', 120000);

    if (chosen.nnue) {
      // Confirm the network actually loaded rather than silently falling back.
      const enabled = await this._confirmNnue();
      if (!enabled) throw new Error('NNUE network failed to load');
    }

    this.ready = true;
    return this;
  }

  /* Stockfish announces "info string NNUE evaluation enabled." once the
   * network is in place. Run a token search and listen for it. */
  async _confirmNnue() {
    let seen = false;
    const listener = (line) => {
      if (line.includes('NNUE evaluation enabled')) seen = true;
      if (line.includes('Use NNUE') && line.includes('classical')) seen = false;
    };
    this._listeners.add(listener);
    try {
      this._send('position startpos');
      this._send('go depth 1');
      await this._await('bestmove', 120000);
    } finally {
      this._listeners.delete(listener);
    }
    return seen;
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
   * Scores are from the point of view of the side to move.
   *
   * `searchmoves` restricts the search to the given root moves, which is how
   * we score one specific move at the same depth as the rest.
   *
   * All returned lines come from a single search iteration. That matters: the
   * engine reports candidate 1 at depth 16 before candidate 3 has climbed past
   * depth 15, and scores from different iterations are not comparable. Mixing
   * them makes sound moves look like mistakes. */
  async analyse(fen, { depth = 14, multipv = 2, searchmoves = null, fresh = false, onProgress } = {}) {
    if (!this.ready) throw new Error('Engine not initialised');
    await this.setMultiPV(multipv);

    // Whole-game analysis gets reproducibility from a fixed work split
    // instead (see analyseAll), so this is only for one-off searches whose
    // history should not leak in.
    if (fresh) {
      this._send('ucinewgame');
      this._send('isready');
      await this._await('readyok');
    }

    // depth -> (multipv -> info)
    const byDepth = new Map();
    let maxDepth = 0;

    const listener = (line) => {
      if (!line.startsWith('info ') || line.includes(' currmove')) return;
      const parsed = parseInfo(line);
      if (!parsed || parsed.cp === null) return;
      if (!byDepth.has(parsed.depth)) byDepth.set(parsed.depth, new Map());
      byDepth.get(parsed.depth).set(parsed.multipv, parsed);
      if (parsed.depth > maxDepth) {
        maxDepth = parsed.depth;
        if (onProgress) onProgress(parsed);
      }
    };

    this._listeners.add(listener);
    this._searching = true;
    try {
      this._send(`position fen ${fen}`);
      const go = searchmoves && searchmoves.length
        ? `go depth ${depth} searchmoves ${searchmoves.join(' ')}`
        : `go depth ${depth}`;
      this._send(go);
      const best = await this._await('bestmove', 180000);
      const bestMove = best.split(/\s+/)[1];

      // Deepest iteration that reported the full set of candidates.
      const depths = [...byDepth.keys()].sort((a, b) => b - a);
      const widest = depths.reduce(
        (most, d) => Math.max(most, byDepth.get(d).size),
        0
      );
      const settled = depths.find((d) => byDepth.get(d).size === widest);
      const chosen = settled === undefined ? new Map() : byDepth.get(settled);
      const ordered = [...chosen.values()].sort((a, b) => a.multipv - b.multipv);

      return {
        lines: ordered,
        bestMove: bestMove === '(none)' ? null : bestMove,
        depth: settled === undefined ? maxDepth : settled,
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

    // Try the best available build. If it cannot actually run here (no SIMD,
    // network file missing, not enough memory) fall back a rung and retry
    // rather than leaving the user with nothing.
    for (let attempt = 0; attempt < BUILDS.length + 1; attempt++) {
      const build = await resolveBuild();

      // Each NNUE worker keeps its own copy of the 38 MB network, so the pool
      // has to respect how much memory the machine actually has.
      const roomy =
        typeof navigator !== 'undefined' && (navigator.deviceMemory || 8) >= 8;
      const size = build.nnue
        ? Math.min(this.size, roomy ? 6 : 3)
        : this.size;

      let first;
      try {
        first = await new Engine().init({ build });
      } catch {
        failedBuilds.add(build.id);
        cachedBuild = null;
        continue;
      }

      const rest = await Promise.all(
        Array.from({ length: size - 1 }, () =>
          new Engine().init({ build }).then(
            (engine) => engine,
            () => null
          )
        )
      );

      this.engines = [first, ...rest.filter(Boolean)];
      this.size = this.engines.length;
      this.source = first.source;
      this.ready = true;
      return this;
    }

    throw new Error('No engine worker could be started');
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
   * result. Each job is either null (skipped, comes back null) or an object
   * { fen, searchmoves?, multipv? }.
   *
   * onResult(index, result, doneCount) fires as each position finishes, out
   * of order. That is the point. */
  async analyseAll(jobs, { depth, multipv, onResult, shouldStop } = {}) {
    const results = new Array(jobs.length).fill(null);
    let done = 0;

    /* Work is split up front rather than pulled off a shared queue.
     *
     * That matters for two reasons. A worker keeps its transposition table
     * between searches, so neighbouring positions in the same game make each
     * other much cheaper: handing each worker a contiguous run of the game
     * rather than whatever it grabs next is a large speed win. And because the
     * split is fixed, every worker sees the same positions in the same order
     * on every run, so the review is reproducible without having to throw the
     * table away each time.
     *
     * Blocks are interleaved so no single worker ends up with the whole
     * middlegame, which is where the slow positions live. */
    const workers = this.engines.length;
    const BLOCK = 4;
    const assignments = Array.from({ length: workers }, () => []);
    for (let i = 0; i < jobs.length; i++) {
      assignments[Math.floor(i / BLOCK) % workers].push(i);
    }

    const runner = async (engine, indices) => {
      for (const index of indices) {
        if (shouldStop && shouldStop()) return;
        const job = jobs[index];
        if (job === null || job === undefined) {
          done++;
          continue;
        }
        const result = await engine.analyse(job.fen, {
          depth,
          multipv: job.multipv || multipv,
          searchmoves: job.searchmoves || null,
        });
        results[index] = result;
        done++;
        if (onResult) onResult(index, result, done);
      }
    };

    await Promise.all(
      this.engines.map((engine, i) => runner(engine, assignments[i]))
    );
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
  const out = { depth: 0, multipv: 1, cp: null, mate: null, wdl: null, pv: [], nodes: 0, nps: 0 };
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
      case 'wdl':
        // Per-mille win / draw / loss for the side to move.
        out.wdl = {
          win: parseInt(tokens[i + 1], 10),
          draw: parseInt(tokens[i + 2], 10),
          loss: parseInt(tokens[i + 3], 10),
        };
        i += 3;
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
