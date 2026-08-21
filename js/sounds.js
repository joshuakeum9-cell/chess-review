/* sounds.js — move sounds, synthesized at runtime with the Web Audio API.
 *
 * No audio files ship with the app. chess.com's sound files are proprietary
 * (the same reason the pieces are the Cburnett set rather than their neo
 * art), so these are original approximations of the events their review
 * plays: a wooden click when a piece lands, a heavier knock for a capture,
 * a double knock for castling, a bright pair of notes for check.
 *
 * Every sound is built from two primitives: a band-passed noise burst for
 * the attack transient, and a short decaying oscillator for the body. That
 * is what a piece hitting a board actually is - a click plus a thunk.
 */

const STORAGE_KEY = 'chessReview.sound';

/* Browsers refuse to start audio outside a user gesture, so the context is
 * created on the first play attempt (which always follows a click or a key
 * press here) and resumed if the browser parked it. */
export class SoundBoard {
  constructor() {
    this.enabled = readPreference();
    this.ctx = null;
    this.master = null;
    this.noiseBuffer = null;
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
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  play(kind) {
    if (!this.enabled) return;
    const ctx = this.unlock();
    if (!ctx) return;
    const t = ctx.currentTime + 0.001;
    const voice = VOICES[kind] || VOICES.move;
    voice(this, t);
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

  /* ---- primitives ---- */

  /* Band-passed noise: the attack transient, the part that reads as "click". */
  _noise(t0, { gain = 0.3, decay = 0.05, freq = 1800, q = 1 } = {}) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = freq;
    band.Q.value = q;
    const amp = ctx.createGain();
    envelope(amp.gain, t0, gain, decay);
    src.connect(band).connect(amp).connect(this.master);
    src.start(t0);
    src.stop(t0 + decay + 0.05);
  }

  /* A short decaying oscillator: the wooden body under the click. */
  _tone(t0, { freq = 200, endFreq = null, gain = 0.3, decay = 0.08, type = 'sine' } = {}) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, t0 + decay);
    const amp = ctx.createGain();
    envelope(amp.gain, t0, gain, decay);
    osc.connect(amp).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + decay + 0.05);
  }

  /* The plain piece-lands sound, reused as the base of most of the others. */
  _knock(t0, scale = 1) {
    this._noise(t0, { gain: 0.3 * scale, decay: 0.045, freq: 2000, q: 1.1 });
    this._tone(t0, { freq: 215, endFreq: 150, gain: 0.34 * scale, decay: 0.07 });
    this._tone(t0, { freq: 620, gain: 0.1 * scale, decay: 0.03, type: 'triangle' });
  }
}

const VOICES = {
  move(sb, t) {
    sb._knock(t);
  },

  /* Heavier, grittier, and a touch longer: two pieces, not one. */
  capture(sb, t) {
    sb._noise(t, { gain: 0.42, decay: 0.09, freq: 1150, q: 0.6 });
    sb._tone(t, { freq: 165, endFreq: 92, gain: 0.44, decay: 0.13 });
    sb._tone(t, { freq: 430, gain: 0.12, decay: 0.05, type: 'triangle' });
    // the capturing piece settling a beat after the collision
    sb._noise(t + 0.014, { gain: 0.16, decay: 0.04, freq: 2400, q: 1.2 });
  },

  /* King, then rook. */
  castle(sb, t) {
    sb._knock(t);
    sb._knock(t + 0.095, 0.85);
  },

  check(sb, t) {
    sb._knock(t);
    sb._tone(t + 0.03, { freq: 1180, gain: 0.11, decay: 0.07, type: 'sine' });
    sb._tone(t + 0.1, { freq: 1560, gain: 0.1, decay: 0.09, type: 'sine' });
  },

  promote(sb, t) {
    sb._knock(t, 0.9);
    const notes = [784, 1046, 1318];
    notes.forEach((freq, i) => {
      sb._tone(t + 0.045 + i * 0.055, { freq, gain: 0.12, decay: 0.11, type: 'triangle' });
    });
  },

  /* Checkmate: the knock, then the game closing. */
  mate(sb, t) {
    sb._knock(t);
    sb._tone(t + 0.06, { freq: 660, gain: 0.15, decay: 0.18, type: 'triangle' });
    sb._tone(t + 0.2, { freq: 494, gain: 0.15, decay: 0.34, type: 'triangle' });
  },

  /* Played once when a review finishes: rising, so it reads as "ready". */
  ready(sb, t) {
    sb._tone(t, { freq: 659, gain: 0.12, decay: 0.14, type: 'triangle' });
    sb._tone(t + 0.11, { freq: 880, gain: 0.12, decay: 0.22, type: 'triangle' });
  },

  illegal(sb, t) {
    sb._tone(t, { freq: 160, endFreq: 110, gain: 0.14, decay: 0.12, type: 'square' });
  },
};

/* Exponential decay to near-silence: gain cannot ramp to a true zero. */
function envelope(param, t0, peak, decay) {
  param.setValueAtTime(0.0001, t0);
  param.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + 0.002);
  param.exponentialRampToValueAtTime(0.0001, t0 + decay);
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
