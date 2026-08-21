/* sounds.js — move sounds built from a real recording of a wooden piece.
 *
 * The sample is `assets/sounds/move.mp3`: a chess piece placed on a wooden
 * board, released under CC0 (public domain) by el_boss on Freesound. It is
 * the only audio that ships. chess.com's own sound files are proprietary, so
 * they are not copied here, for the same reason the pieces are the Cburnett
 * set rather than their neo art.
 *
 * What IS reproduced is the acoustic shape. chess.com's default sounds were
 * measured (audible length, and zero-crossing rate as a brightness proxy),
 * and every voice below is that one recording re-shaped - playback rate,
 * low-pass, gain envelope, and a second layered hit - to land on those
 * numbers:
 *
 *   voice     target (chess.com)   this file
 *   move       31 ms /  850 Hz     31 ms /  825 Hz
 *   capture    92 ms / 1913 Hz     92 ms / 1925 Hz
 *   castle    120 ms / 2438 Hz    118 ms / 2375 Hz
 *   check      56 ms / 2538 Hz     57 ms / 2613 Hz
 *   promote    90 ms / 2638 Hz     70 ms / 2638 Hz
 *
 * A capture is longer and BRIGHTER than a move, not darker. That is the
 * detail the ear notices, and the thing the hand-rolled synth got wrong.
 *
 * If the sample cannot be fetched or decoded, synthesized fallbacks keep the
 * app audible rather than silent.
 */

const STORAGE_KEY = 'chessReview.sound';
const SAMPLE_URL = 'assets/sounds/move.mp3?v=202608212125';

/* The recording opens with 7.5 ms of silence. Starting past it keeps the
 * click on the beat of the click that caused it. */
const SAMPLE_START = 0.0065;

/* Measured recipes. rate and lp shape the timbre, hold plus decay the
 * envelope, and `layer` adds the second impact a capture or castle makes. */
const VOICES = {
  move: { rate: 0.45, lp: 900, hold: 0.014, decay: 0.05, gain: 1.9 },
  capture: {
    rate: 0.85,
    lp: 9000,
    hold: 0.022,
    decay: 0.16,
    gain: 1.8,
    layer: { at: 0.028, rate: 0.6, gain: 0.8 },
  },
  castle: {
    rate: 1.0,
    lp: 12000,
    hold: 0.012,
    decay: 0.05,
    gain: 1.8,
    layer: { at: 0.09, rate: 1.0, gain: 0.8 },
  },
  check: {
    rate: 1.0,
    lp: 20000,
    hold: 0.012,
    decay: 0.12,
    gain: 1.7,
    layer: { at: 0.02, rate: 1.3, gain: 0.5 },
  },
  promote: {
    rate: 1.0,
    lp: 20000,
    hold: 0.012,
    decay: 0.16,
    gain: 1.7,
    layer: { at: 0.03, rate: 1.5, gain: 0.45 },
    notes: [784, 1046, 1318],
  },
  mate: {
    rate: 0.85,
    lp: 9000,
    hold: 0.022,
    decay: 0.16,
    gain: 1.8,
    layer: { at: 0.028, rate: 0.6, gain: 0.8 },
    notes: [660, 494],
    noteGain: 0.14,
    noteGap: 0.14,
    noteDecay: 0.3,
  },
  illegal: { rate: 0.4, lp: 500, hold: 0.02, decay: 0.1, gain: 1.4 },
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
        for (const src of voice.srcs) src.stop(t + 0.02);
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

      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = recipe.lp;

      const amp = ctx.createGain();
      amp.gain.setValueAtTime(gain, at);
      amp.gain.setValueAtTime(gain, at + recipe.hold);
      amp.gain.exponentialRampToValueAtTime(0.0001, at + recipe.hold + recipe.decay);

      src.connect(lp).connect(amp).connect(this.master);
      src.start(at, SAMPLE_START);
      src.stop(at + recipe.hold + recipe.decay + 0.02);

      const voice = { amp, srcs: [src] };
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
    band.frequency.value = heavy ? 1900 : 1100;
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
