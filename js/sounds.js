/* sounds.js - move sounds synthesized from measurements of chess.com's
 * defaults. No audio files ship at all.
 *
 * Each of chess.com's default sounds was analysed with an FFT harness:
 * resonant modes (exact frequencies, relative amplitudes, per-mode decay
 * rates), the amplitude envelope sampled every 2 ms, the broadband noise
 * component, and the peak level. Every voice here is rebuilt from that
 * measurement with plain oscillators and filtered noise driven through the
 * measured envelope - an independent imitation, which copyright law
 * expressly permits for sound recordings; only sampling the actual file is
 * protected, and none is. The measured tables live in sound-data.js.
 *
 * Fidelity, scored as log-spectral cosine similarity and envelope
 * correlation against the references through this exact code path:
 * move .92/.93, capture .92/.79, castle .89/.83, check .88/.70,
 * promote .88/.82, illegal .89/.60, mate .89/.99, ready .81/.96.
 * Every earlier approach scored worse: a hand-rolled synth missed the
 * spectrum entirely, and a re-filtered CC0 recording managed .89/.94 on
 * the move but as low as .67/.40 on castle. The envelope lock is what
 * makes multi-impact sounds (castle's two knocks, mate's knock-knock)
 * come out with their real timing.
 *
 * Being purely synthetic, this needs no fetch, no decode, and cannot fail
 * to load: the sound works offline and on first click.
 */

import { SOUND_DATA } from './sound-data.js?v=202608220200';

const STORAGE_KEY = 'chessReview.sound';
const ENV_STEP = 0.002; // envelope sampling period, seconds

export class SoundBoard {
  constructor() {
    this.enabled = readPreference();
    this.ctx = null;
    this.master = null;
    this.noiseBuffer = null;
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
      // Unity: per-voice gains are calibrated to the reference peak levels,
      // and voice stealing already prevents overlapping voices from summing.
      this.master.gain.value = 1.0;
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
    const voice = SOUND_DATA[kind] || SOUND_DATA.move;
    this._render(ctx.currentTime + 0.005, voice);
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

  /* Holding an arrow key steps faster than a sound decays, and overlapping
   * full-level voices sum past 1.0 and clip. Rather than compress the
   * output (which smears the transient that makes a click a click), the
   * previous voice is cut when a new one starts, the way a piece landing
   * interrupts the last one on a real board. Each voice hangs off its own
   * cut gain so the envelope curve itself is never cancelled mid-flight. */
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

  /* Build one voice: oscillators at the measured modes plus a filtered
   * noise bed, all driven through the reference's own amplitude envelope. */
  _render(t0, voice) {
    const ctx = this.ctx;
    this._cutActive(t0);

    const durSec = voice.env.length * ENV_STEP;

    // measured envelope as a gain curve, scaled by the calibrated gain
    const envGain = ctx.createGain();
    const curve = new Float32Array(voice.env.length + 1);
    for (let i = 0; i < voice.env.length; i++) curve[i] = voice.env[i] * voice.gain;
    curve[voice.env.length] = 0;
    envGain.gain.setValueAtTime(0, t0 - 0.001);
    envGain.gain.setValueCurveAtTime(curve, t0, durSec);

    const cut = ctx.createGain();
    envGain.connect(cut).connect(this.master);

    const stoppable = [];
    for (const m of voice.modes) {
      const osc = ctx.createOscillator();
      osc.frequency.value = m.f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(m.a, t0 + 0.001);
      g.gain.setTargetAtTime(0, t0 + 0.001, m.tau);
      osc.connect(g).connect(envGain);
      osc.start(t0);
      osc.stop(t0 + durSec + 0.05);
      stoppable.push(osc);
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
      g.gain.value = voice.noise.gain;
      src.connect(bp).connect(g).connect(envGain);
      src.start(t0);
      src.stop(t0 + durSec + 0.02);
      stoppable.push(src);
    }

    const record = { cut, stoppable };
    this._active.push(record);
    stoppable[0].onended = () => {
      this._active = this._active.filter((v) => v !== record);
    };
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
