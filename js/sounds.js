/* sounds.js - the app's sound board.
 *
 * The six core sounds (capture, castle, check, checkmate, game_over,
 * stalemate) are the actual chess.com sound effects, shipped as mp3 files
 * in assets/sounds/ at Joshua's direction. They are the property of
 * Chess.com, used here in a free educational project, and will be removed
 * on request (also noted in the README credits).
 *
 * The plain move sound is not among the files, but stalemate.mp3 opens
 * with exactly the move knock (measured: the first impact ends well before
 * the game-over knock-knock that follows at 58 ms), so the move sound is
 * sliced out of it at decode time rather than shipping a seventh file.
 *
 * Everything else stays synthesized from the measured tables in
 * sound-data.js: promote, illegal and ready have no supplied file, and
 * every sampled voice keeps its synthesized model as a fallback, so the
 * app is never silent while files load or if a fetch fails.
 */

import { SOUND_DATA } from './sound-data.js?v=202608220504';

const STORAGE_KEY = 'chessReview.sound';
const ENV_STEP = 0.002; // envelope sampling period, seconds

/* The real recordings. The bump script restamps the ?v= cache-busters. */
const SAMPLE_FILES = {
  capture: 'assets/sounds/capture.mp3?v=202608220504',
  castle: 'assets/sounds/castle.mp3?v=202608220504',
  check: 'assets/sounds/check.mp3?v=202608220504',
  checkmate: 'assets/sounds/checkmate.mp3?v=202608220504',
  game_over: 'assets/sounds/game_over.mp3?v=202608220504',
  stalemate: 'assets/sounds/stalemate.mp3?v=202608220504',
};

/* How much of stalemate.mp3 is the move knock. */
const MOVE_SLICE_SEC = 0.052;
const MOVE_FADE_SEC = 0.008;

export class SoundBoard {
  constructor() {
    this.enabled = readPreference();
    this.ctx = null;
    this.master = null;
    this.noiseBuffer = null;
    this.buffers = {};
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
      this.master.gain.value = 1.0;
      this.master.connect(this.ctx.destination);
      this.noiseBuffer = makeNoise(this.ctx);
      this._loadSamples();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  _loadSamples() {
    if (this._loading) return this._loading;
    this._loading = Promise.all(
      Object.entries(SAMPLE_FILES).map(([kind, url]) =>
        fetch(url)
          .then((res) => {
            if (!res.ok) throw new Error(`${kind} ${res.status}`);
            return res.arrayBuffer();
          })
          .then((bytes) => this.ctx.decodeAudioData(bytes))
          .then((buf) => {
            // The files carry 0.4-0.6 s of leading silence from their
            // encoding; playing from 0 would lag every click by that much.
            this.buffers[kind] = { buffer: buf, offset: onsetOf(buf) };
            if (kind === 'stalemate') {
              const move = sliceMove(this.ctx, buf);
              if (move) this.buffers.move = { buffer: move, offset: 0 };
            }
          })
          .catch(() => {
            /* the synthesized fallback covers this voice */
          })
      )
    );
    return this._loading;
  }

  play(kind) {
    if (!this.enabled) return;
    const ctx = this.unlock();
    if (!ctx) return;
    const t = ctx.currentTime + 0.005;
    const sample = this.buffers[kind];
    if (sample) return this._playBuffer(t, sample.buffer, sample.offset);
    const voice = SOUND_DATA[kind];
    if (voice) this._render(t, voice);
  }

  /* Picks the right sound for a move from its SAN, which every move object
   * carries: 'x' capture, 'O-O' castle, '=' promotion, '+/#' check/mate. */
  playMove(move) {
    if (!move) return;
    const san = move.san || '';
    if (san.includes('#')) return this.play('checkmate');
    if (san.includes('+')) return this.play('check');
    if (san.includes('=')) return this.play('promote');
    if (san.startsWith('O-O')) return this.play('castle');
    if (san.includes('x') || move.captured) return this.play('capture');
    this.play('move');
  }

  /* Holding an arrow key steps faster than a sound decays, and overlapping
   * full-level voices sum past 1.0 and clip. Rather than compress the
   * output (which smears the transient that makes a click a click), the
   * previous voice is cut when a new one starts, the way a piece landing
   * interrupts the last one on a real board. */
  _cutActive(t) {
    for (const voice of this._active) {
      try {
        voice.cut.gain.cancelScheduledValues(t);
        voice.cut.gain.setTargetAtTime(0.0001, t, 0.0015);
        for (const node of voice.stoppable) node.stop(t + 0.02);
      } catch {
        /* already finished */
      }
    }
    this._active = [];
  }

  /* One of the real recordings, straight through, from its onset. */
  _playBuffer(t0, buffer, offset = 0) {
    const ctx = this.ctx;
    this._cutActive(t0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const cut = ctx.createGain();
    src.connect(cut).connect(this.master);
    src.start(t0, offset);
    const record = { cut, stoppable: [src] };
    this._active.push(record);
    src.onended = () => {
      this._active = this._active.filter((v) => v !== record);
    };
  }

  /* Synthesized voice (promote, illegal, ready, and fallbacks): oscillators
   * at measured mode frequencies, either as one bank through the measured
   * envelope or as discrete strikes; see sound-data.js for the tables. */
  _render(t0, voice) {
    const ctx = this.ctx;
    this._cutActive(t0);

    const stoppable = [];
    const cut = ctx.createGain();
    cut.connect(this.master);

    let dest = cut;
    let durSec;
    if (voice.env) {
      durSec = voice.env.length * ENV_STEP;
      const envGain = ctx.createGain();
      const curve = new Float32Array(voice.env.length + 1);
      for (let i = 0; i < voice.env.length; i++) curve[i] = voice.env[i] * voice.gain;
      curve[voice.env.length] = 0;
      envGain.gain.setValueAtTime(0, t0 - 0.001);
      envGain.gain.setValueCurveAtTime(curve, t0, durSec);
      envGain.connect(cut);
      dest = envGain;
    } else {
      const last = voice.strikes[voice.strikes.length - 1];
      durSec = last.at + 0.35;
    }

    const srcGain = voice.env ? 1 : voice.gain;

    const strikes = voice.strikes || [{ at: 0, gain: 1 }];
    for (const st of strikes) {
      const ts = t0 + st.at;
      const attack = st.attack ?? voice.attack ?? 0.001;
      const tauScale = st.tauScale ?? 1;
      for (const m of st.modes || voice.modes) {
        const osc = ctx.createOscillator();
        osc.frequency.value = m.f;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, ts);
        g.gain.linearRampToValueAtTime(m.a * st.gain * srcGain, ts + attack);
        g.gain.setTargetAtTime(0, ts + attack, m.tau * tauScale);
        osc.connect(g).connect(dest);
        osc.start(ts);
        osc.stop(t0 + durSec + 0.1);
        stoppable.push(osc);
      }
      const click = st.click ?? voice.click;
      if (click && click.gain > 0) {
        const src = ctx.createBufferSource();
        src.buffer = this.noiseBuffer;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = click.f;
        bp.Q.value = 0.7;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, ts);
        g.gain.linearRampToValueAtTime(click.gain * st.gain * srcGain, ts + attack);
        g.gain.setTargetAtTime(0, ts + attack, click.tau);
        src.connect(bp).connect(g).connect(dest);
        src.start(ts, 0.01 * (1 + strikes.indexOf(st)));
        src.stop(ts + 0.12);
        stoppable.push(src);
      }
      if (voice.noise) {
        const src = ctx.createBufferSource();
        src.buffer = this.noiseBuffer;
        src.loop = true;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = voice.noise.f;
        bp.Q.value = 0.6;
        const g = ctx.createGain();
        g.gain.value = voice.noise.gain * srcGain;
        src.connect(bp).connect(g).connect(dest);
        src.start(t0);
        src.stop(t0 + durSec + 0.02);
        stoppable.push(src);
      }
    }

    const record = { cut, stoppable };
    this._active.push(record);
    stoppable[0].onended = () => {
      this._active = this._active.filter((v) => v !== record);
    };
  }
}

/* Cut the opening move knock out of the stalemate recording: from its
 * onset to just before the game-over knocks, with a short fade so the cut
 * is silent. */
/* First sample carrying real signal, backed off 2 ms so no attack clips. */
function onsetOf(buffer) {
  const d = buffer.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  if (peak < 1e-6) return 0;
  for (let i = 0; i < d.length; i++) {
    if (Math.abs(d[i]) > peak * 0.02) {
      return Math.max(0, (i - Math.round(buffer.sampleRate * 0.002)) / buffer.sampleRate);
    }
  }
  return 0;
}

function sliceMove(ctx, buffer) {
  const d = buffer.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  if (peak < 1e-6) return null;
  const onset = Math.round(onsetOf(buffer) * buffer.sampleRate);
  const frames = Math.round(buffer.sampleRate * MOVE_SLICE_SEC);
  const fade = Math.round(buffer.sampleRate * MOVE_FADE_SEC);
  const out = ctx.createBuffer(1, frames, buffer.sampleRate);
  const o = out.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    let v = d[onset + i] || 0;
    if (i > frames - fade) v *= (frames - i) / fade;
    o[i] = v;
  }
  return out;
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
