/* sounds.js - move sounds built from a real recording of a chess piece.
 *
 * The sample is `assets/sounds/move.mp3`: "ficha de ajedrez" by lucho0880 on
 * Freesound, released under CC0 (public domain). It is the only audio that
 * ships. chess.com's own sound files are proprietary, so they are not copied
 * here, for the same reason the pieces are the Cburnett set rather than their
 * neo art.
 *
 * What IS reproduced is the acoustic shape, measured off their defaults with
 * an FFT: where the energy sits across the spectrum, how long the sound runs,
 * and how fast the attack is. Two numbers matter more than the rest. Their
 * move sound puts ~79% of its energy between 300 Hz and 1 kHz - a low-mid
 * tock with almost nothing above 3 kHz - and its attack is 0.9 ms, which is
 * to say instant. The capture is the bright one: ~62% between 1 and 3 kHz.
 *
 *   voice    target (chess.com)                 this file
 *   move      31 ms, centroid 1032 Hz, 79% low   36 ms, 1016 Hz, 70% low
 *   capture   92 ms, centroid 1962 Hz, 62% mid   85 ms, 2191 Hz, 65% mid
 *   check     56 ms, centroid 3262 Hz            39 ms, 3077 Hz
 *   castle   120 ms, two impacts                126 ms, two impacts
 *
 * The processing is deliberately gentle: playback rate stays between 0.95 and
 * 1.0 so the recording is never stretched, and the filters shelve the balance
 * rather than cutting the top off. An earlier version fitted a zero-crossing
 * proxy instead, which drove it to 0.45x speed behind a 900 Hz low-pass. That
 * matched the number and sounded warped and muffled, because slowing a sample
 * smears the very attack that makes a click read as a click. Match the
 * spectrum, not a proxy, and protect the transient.
 *
 * If the sample cannot be fetched or decoded, synthesized fallbacks keep the
 * app audible rather than silent.
 */

const STORAGE_KEY = 'chessReview.sound';
const SAMPLE_URL = 'assets/sounds/move.mp3?v=202608212141';

/* Measured recipes. `rate` stays near 1 so the recording is never stretched,
 * `filters` shelve the spectral balance onto the target, hold plus decay set
 * the length, and `layer` adds the second impact a capture or a castle
 * physically makes. */
const VOICES = {
  move: {
    rate: 0.95,
    filters: [{ type: 'lowpass', freq: 2400, q: 0.5 }],
    hold: 0.024,
    decay: 0.05,
    gain: 0.5,
  },
  capture: {
    rate: 1.0,
    filters: [
      { type: 'lowshelf', freq: 800, gain: -10 },
      { type: 'highshelf', freq: 1400, gain: 12 },
      { type: 'lowpass', freq: 5000, q: 0.5 },
    ],
    hold: 0.02,
    decay: 0.22,
    gain: 0.448,
    layer: { at: 0.03, rate: 0.8, gain: 0.7 },
  },
  castle: {
    rate: 0.95,
    filters: [{ type: 'lowpass', freq: 2400, q: 0.5 }],
    hold: 0.024,
    decay: 0.05,
    gain: 0.543,
    layer: { at: 0.09, rate: 0.95, gain: 1.0 },
  },
  check: {
    rate: 1.0,
    filters: [{ type: 'highshelf', freq: 2200, gain: 20 }],
    hold: 0.012,
    decay: 0.11,
    gain: 0.222,
  },
  promote: {
    rate: 1.0,
    filters: [{ type: 'highshelf', freq: 2200, gain: 14 }],
    hold: 0.012,
    decay: 0.12,
    gain: 0.36,
    notes: [784, 1046, 1318],
  },
  mate: {
    rate: 1.0,
    filters: [
      { type: 'lowshelf', freq: 800, gain: -10 },
      { type: 'highshelf', freq: 1400, gain: 12 },
      { type: 'lowpass', freq: 5000, q: 0.5 },
    ],
    hold: 0.02,
    decay: 0.22,
    gain: 0.45,
    layer: { at: 0.03, rate: 0.8, gain: 0.7 },
    notes: [660, 494],
    noteGain: 0.14,
    noteGap: 0.14,
    noteDecay: 0.3,
  },
  illegal: {
    rate: 0.9,
    filters: [{ type: 'lowpass', freq: 700, q: 0.7 }],
    hold: 0.02,
    decay: 0.09,
    gain: 0.62,
  },
  /* Not a chess.com sound: this one marks the review finishing. */
  ready: { notes: [659, 880], noteGain: 0.13, noteGap: 0.11, noteDecay: 0.2 },
};

export class SoundBoard {
  constructor() {
    this.enabled = readPreference();
    this.ctx = null;
    this.master = null;
    this.buffer = null;
    this.noiseBuffer = null;
    this.startAt = 0;
    this._loading = null;
    this._active = [];
  }

  setEnabled(on) {
    this.enabled = !!on;
    try {
      localStorage.setItem(STORAGE_KEY, this.enabled ? 'on' : 'off');
    } catch {
      /* private mode: the preference just does not persist */
    }
    if (this.enabled) this.unlock();
  }

  /* Safe to call from any user gesture; cheap after the first time. */
  unlock() {
    if (!this.ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      try {
        this.ctx = new Ctor();
      } catch {
        return null;
      }
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.ctx.destination);
      this.noiseBuffer = makeNoise(this.ctx);
      this._load();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  _load() {
    if (this._loading) return this._loading;
    this._loading = fetch(SAMPLE_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`sample ${res.status}`);
        return res.arrayBuffer();
      })
      .then((bytes) => this.ctx.decodeAudioData(bytes))
      .then((buf) => {
        this.buffer = buf;
        this.startAt = findOnset(buf);
      })
      .catch(() => {
        this.buffer = null; // the synthesized fallback covers it
      });
    return this._loading;
  }

  play(kind) {
    if (!this.enabled) return;
    const ctx = this.unlock();
    if (!ctx) return;
    const recipe = VOICES[kind] || VOICES.move;
    const t = ctx.currentTime + 0.001;

    if (recipe.rate !== undefined) {
      if (this.buffer) this._hit(t, recipe);
      else this._synthFallback(t, kind);
    }
    if (recipe.notes) {
      const gap = recipe.noteGap ?? 0.055;
      const gain = recipe.noteGain ?? 0.12;
      const decay = recipe.noteDecay ?? 0.11;
      const lead = recipe.rate === undefined ? 0 : 0.045;
      recipe.notes.forEach((freq, i) => {
        this._tone(t + lead + i * gap, { freq, gain, decay, type: 'triangle' });
      });
    }
  }

  /* Picks the right sound for a move from its SAN, which every move object
   * carries: 'x' capture, 'O-O' castle, '=' promotion, '+/#' check/mate. */
  playMove(move) {
    if (!move) return;
    const san = move.san || '';
    if (san.includes('#')) return this.play('mate');
    if (san.includes('+')) return this.play('check');
    if (san.includes('=')) return this.play('promote');
    if (san.startsWith('O-O')) return this.play('castle');
    if (san.includes('x') || move.captured) return this.play('capture');
    this.play('move');
  }

  /* Holding an arrow key steps faster than a hit decays, and three at full
   * level sum past 1.0 and clip. Rather than compress the output (which
   * smears the very transient that makes a click sound like a click), the
   * previous hit is cut short when a new one starts, the way a piece landing
   * interrupts the last one on a real board. */
  _cutActive(t) {
    for (const voice of this._active) {
      try {
        voice.amp.gain.cancelScheduledValues(t);
        voice.amp.gain.setTargetAtTime(0.0001, t, 0.0015);
        voice.src.stop(t + 0.02);
      } catch {
        /* already finished */
      }
    }
    this._active = [];
  }

  /* One shaped strike of the recording, plus its layered second impact. */
  _hit(t0, recipe) {
    this._cutActive(t0);
    const strike = (at, rate, gain) => {
      const ctx = this.ctx;
      const src = ctx.createBufferSource();
      src.buffer = this.buffer;
      src.playbackRate.value = rate;

      let node = src;
      for (const spec of recipe.filters || []) {
        const filter = ctx.createBiquadFilter();
        filter.type = spec.type;
        filter.frequency.value = spec.freq;
        if (spec.q !== undefined) filter.Q.value = spec.q;
        if (spec.gain !== undefined) filter.gain.value = spec.gain;
        node = node.connect(filter);
      }

      const amp = ctx.createGain();
      amp.gain.setValueAtTime(gain, at);
      amp.gain.setValueAtTime(gain, at + recipe.hold);
      amp.gain.exponentialRampToValueAtTime(0.0001, at + recipe.hold + recipe.decay);

      node.connect(amp).connect(this.master);
      // Start on the transient: the file carries silence in front of it, and
      // how much survives decoding varies by browser, so the onset is measured.
      src.start(at, this.startAt);
      src.stop(at + recipe.hold + recipe.decay + 0.03);

      const voice = { amp, src };
      this._active.push(voice);
      src.onended = () => {
        this._active = this._active.filter((v) => v !== voice);
      };
    };

    strike(t0, recipe.rate, recipe.gain);
    if (recipe.layer) {
      strike(t0 + recipe.layer.at, recipe.layer.rate, recipe.gain * recipe.layer.gain);
    }
  }

  /* A short decaying oscillator, for the musical accents. */
  _tone(t0, { freq = 200, gain = 0.3, decay = 0.08, type = 'sine' } = {}) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(Math.max(gain, 0.0002), t0 + 0.002);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
    osc.connect(amp).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + decay + 0.05);
  }

  /* Used only when the recording is unavailable: a noise burst for the
   * attack over a short decaying body. Cruder, but never silent. */
  _synthFallback(t0, kind) {
    const heavy = kind === 'capture' || kind === 'mate';
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = heavy ? 1900 : 700;
    band.Q.value = 0.8;
    const decay = heavy ? 0.09 : 0.035;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(heavy ? 0.4 : 0.3, t0 + 0.002);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
    src.connect(band).connect(amp).connect(this.master);
    src.start(t0);
    src.stop(t0 + decay + 0.05);
    this._tone(t0, { freq: heavy ? 165 : 215, gain: 0.3, decay: heavy ? 0.12 : 0.06 });
  }
}

/* First sample that carries real signal, backed off by a few frames so the
 * attack is never clipped. Measured rather than hardcoded: mp3 decoders
 * disagree about how much encoder padding to keep. */
function findOnset(buffer) {
  const d = buffer.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  if (peak < 1e-6) return 0;
  const threshold = peak * 0.02;
  for (let i = 0; i < d.length; i++) {
    if (Math.abs(d[i]) > threshold) {
      return Math.max(0, (i - 24) / buffer.sampleRate);
    }
  }
  return 0;
}

function makeNoise(ctx) {
  const frames = Math.floor(ctx.sampleRate * 0.4);
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

function readPreference() {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}
