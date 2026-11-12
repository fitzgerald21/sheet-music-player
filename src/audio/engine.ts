import * as Tone from 'tone';
import { toneName } from '../model/pitch';
import { PlaybackPlan } from '../model/playback';
import { InstrumentId, Part } from '../model/types';

export const INSTRUMENTS: { id: InstrumentId; label: string }[] = [
  { id: 'piano', label: 'Grand piano' },
  { id: 'epiano', label: 'Electric piano' },
  { id: 'voice', label: 'Voice (ooh)' },
  { id: 'flute', label: 'Flute' },
  { id: 'strings', label: 'Strings' },
  { id: 'organ', label: 'Organ' },
  { id: 'musicbox', label: 'Music box' },
  { id: 'marimba', label: 'Marimba' },
  { id: 'guitar', label: 'Nylon guitar' },
  { id: 'bass', label: 'Bass' },
];

interface Voice {
  output: Tone.ToneAudioNode;
  trigger(midi: number, time: number, dur: number, vel: number): void;
  releaseAll(time?: number): void;
  loaded: Promise<void>;
}

const PIANO_URLS: Record<string, string> = { A0: 'A0.mp3', C8: 'C8.mp3' };
for (let o = 1; o <= 7; o++) for (const n of ['C', 'Ds', 'Fs', 'A']) PIANO_URLS[`${n.replace('s', '#')}${o}`] = `${n}${o}.mp3`;

function sampleBase(): string {
  const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  return `${base}samples/piano/`;
}

function makePiano(): Voice {
  let resolve!: () => void;
  const loaded = new Promise<void>((r) => (resolve = r));
  const sampler = new Tone.Sampler({ urls: PIANO_URLS, baseUrl: sampleBase(), release: 1.1, onload: () => resolve() });
  const eq = new Tone.EQ3({ low: 1, mid: 0, high: -1.5 });
  sampler.connect(eq);
  return {
    output: eq,
    loaded,
    trigger: (midi, time, dur, vel) => {
      if (sampler.loaded) sampler.triggerAttackRelease(toneName(midi), Math.max(0.05, dur), time, vel);
    },
    releaseAll: (t) => sampler.releaseAll(t),
  };
}

function polyVoice(make: () => Tone.PolySynth, chain: Tone.ToneAudioNode[], gain = 0, velCurve = 1): Voice {
  const synth = make();
  synth.maxPolyphony = 48;
  synth.volume.value = gain;
  let node: Tone.ToneAudioNode = synth;
  for (const c of chain) {
    node.connect(c);
    node = c;
  }
  return {
    output: node,
    loaded: Promise.resolve(),
    trigger: (midi, time, dur, vel) => synth.triggerAttackRelease(Tone.Frequency(midi, 'midi').toFrequency(), Math.max(0.04, dur), time, Math.pow(vel, velCurve)),
    releaseAll: (t) => synth.releaseAll(t),
  };
}

function makeInstrument(id: InstrumentId): Voice {
  switch (id) {
    case 'piano':
      return makePiano();
    case 'epiano':
      return polyVoice(
        () =>
          new Tone.PolySynth(Tone.FMSynth, {
            harmonicity: 1,
            modulationIndex: 2.6,
            oscillator: { type: 'sine' },
            modulation: { type: 'sine' },
            envelope: { attack: 0.002, decay: 1.6, sustain: 0.25, release: 0.9 },
            modulationEnvelope: { attack: 0.002, decay: 0.5, sustain: 0.1, release: 0.5 },
          }),
        [new Tone.Tremolo(4.5, 0.25).start(), new Tone.Filter(3800, 'lowpass')],
        -8,
      );
    case 'voice':
      return polyVoice(
        () =>
          new Tone.PolySynth(Tone.Synth, {
            oscillator: { type: 'fattriangle', count: 3, spread: 14 },
            envelope: { attack: 0.08, decay: 0.3, sustain: 0.85, release: 0.45 },
          }),
        [new Tone.Vibrato(5.2, 0.09), new Tone.Filter({ frequency: 1700, type: 'lowpass', rolloff: -24 }), new Tone.Filter(320, 'peaking')],
        -9,
        0.8,
      );
    case 'flute':
      return polyVoice(
        () =>
          new Tone.PolySynth(Tone.Synth, {
            oscillator: { type: 'custom', partials: [1, 0.25, 0.08, 0.03] },
            envelope: { attack: 0.06, decay: 0.2, sustain: 0.8, release: 0.3 },
          }),
        [new Tone.Vibrato(4.8, 0.06), new Tone.Filter(4000, 'lowpass')],
        -8,
      );
    case 'strings':
      return polyVoice(
        () =>
          new Tone.PolySynth(Tone.Synth, {
            oscillator: { type: 'fatsawtooth', count: 3, spread: 22 },
            envelope: { attack: 0.22, decay: 0.3, sustain: 0.85, release: 1.1 },
          }),
        [new Tone.Vibrato(5, 0.03), new Tone.Filter({ frequency: 2200, type: 'lowpass', rolloff: -24 })],
        -16,
        0.7,
      );
    case 'organ':
      return polyVoice(
        () =>
          new Tone.PolySynth(Tone.Synth, {
            oscillator: { type: 'custom', partials: [1, 0.6, 0.35, 0.25, 0, 0.15, 0, 0.1] },
            envelope: { attack: 0.01, decay: 0.05, sustain: 1, release: 0.12 },
          }),
        [new Tone.Chorus(1.5, 2.5, 0.3).start(), new Tone.Filter(5000, 'lowpass')],
        -15,
        0.4,
      );
    case 'musicbox':
      return polyVoice(
        () =>
          new Tone.PolySynth(Tone.FMSynth, {
            harmonicity: 4.01,
            modulationIndex: 7,
            oscillator: { type: 'sine' },
            modulation: { type: 'sine' },
            envelope: { attack: 0.001, decay: 1.4, sustain: 0, release: 1.4 },
            modulationEnvelope: { attack: 0.001, decay: 0.25, sustain: 0, release: 0.2 },
          }),
        [new Tone.Filter(6000, 'lowpass')],
        -12,
      );
    case 'marimba':
      return polyVoice(
        () =>
          new Tone.PolySynth(Tone.FMSynth, {
            harmonicity: 3.99,
            modulationIndex: 1.6,
            oscillator: { type: 'sine' },
            modulation: { type: 'sine' },
            envelope: { attack: 0.001, decay: 0.55, sustain: 0, release: 0.5 },
            modulationEnvelope: { attack: 0.001, decay: 0.08, sustain: 0, release: 0.1 },
          }),
        [new Tone.Filter(3500, 'lowpass')],
        -7,
      );
    case 'guitar':
      return polyVoice(
        () =>
          new Tone.PolySynth(Tone.Synth, {
            oscillator: { type: 'custom', partials: [1, 0.5, 0.33, 0.2, 0.12, 0.08] },
            envelope: { attack: 0.003, decay: 1.4, sustain: 0.05, release: 0.6 },
          }),
        [new Tone.Filter({ frequency: 2600, type: 'lowpass', rolloff: -24 })],
        -10,
      );
    case 'bass':
      return polyVoice(
        () =>
          new Tone.PolySynth(Tone.Synth, {
            oscillator: { type: 'custom', partials: [1, 0.4, 0.15] },
            envelope: { attack: 0.005, decay: 0.6, sustain: 0.5, release: 0.3 },
          }),
        [new Tone.Filter(900, 'lowpass')],
        -6,
      );
  }
}

export interface PlayOptions {
  speed: number;
  metronome: boolean;
  countIn: boolean;
  loop: boolean;
}

export type EngineState = 'stopped' | 'playing' | 'paused';

class Engine {
  private initialized = false;
  private meter?: Tone.Meter;
  /** Output level 0..1 (for tests / UI). */
  level(): number {
    const v = this.meter?.getValue();
    return typeof v === 'number' ? v : 0;
  }
  private master!: Tone.Gain;
  private instruments = new Map<string, Voice>();
  private channels: Tone.Channel[] = [];
  private chordChannel?: Tone.Channel;
  private click_?: Tone.Synth;
  private timer: ReturnType<typeof setInterval> | null = null;
  private plan: PlaybackPlan | null = null;
  private noteIdx = 0;
  private beatQueue: { time: number; accent: boolean }[] = [];
  private beatIdx = 0;
  private ctxStart = 0;
  private scoreStart = 0;
  private opts: PlayOptions = { speed: 1, metronome: false, countIn: false, loop: false };
  private partInstruments: InstrumentId[] = [];
  state: EngineState = 'stopped';
  pausedAt = 0;
  onEnd: (() => void) | null = null;
  pianoLoaded: Promise<void> = Promise.resolve();

  /** Called when the sound output stops responding during playback (e.g. after a phone call or the camera). */
  onStall: (() => void) | null = null;
  /** When sound was last sent out, to know whether the output may have gone to sleep. */
  private lastSound = 0;
  private stallSince = 0;
  private checkedAt = 0;
  private stallClock = -1;
  private stallNudged = false;

  /**
   * Makes sure the audio clock is really running. On iPhones the audio can be "interrupted" by the
   * camera, a call or locking the screen; it then reports itself as started while standing still.
   */
  private async wake(): Promise<boolean> {
    const ctx = Tone.getContext().rawContext as unknown as AudioContext;
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const moving = async () => {
      const t = ctx.currentTime;
      await pause(70);
      return ctx.currentTime > t;
    };
    const settle = (p: Promise<unknown>) => Promise.race([p.catch(() => undefined), pause(800)]);
    if (ctx.state === 'running' && (await moving())) return true;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (ctx.state === 'running') await settle(ctx.suspend());
      await settle(ctx.resume());
      if (await moving()) return true;
    }
    return false;
  }

  /** The app is in front again after being in the background. */
  cameBack() {
    this.checkedAt = 0;
    this.lastSound = 0;
    if (!this.initialized) return;
    const ctx = Tone.getContext().rawContext as unknown as AudioContext;
    if (ctx.state !== 'running') void ctx.resume().catch(() => undefined);
    // give a song that was playing a fresh chance to recover before it is reported as interrupted
    this.stallClock = -1;
    this.stallNudged = false;
  }

  /** Must be called from a user gesture (iOS). */
  async init(): Promise<void> {
    const ctx = Tone.getContext().rawContext as unknown as AudioContext;
    const wasRunning = ctx.state === 'running';
    // never wait forever on a resume that does not answer
    await Promise.race([Tone.start().catch(() => undefined), new Promise((r) => setTimeout(r, 1500))]);
    // the check takes a moment, so it is skipped while sound is flowing (tapping notes while editing)
    if (!wasRunning || performance.now() - this.checkedAt > 4000) {
      if (!(await this.wake())) throw new Error('AUDIO_ASLEEP');
      this.checkedAt = performance.now();
    }
    if (!wasRunning) this.lastSound = 0;
    try {
      // Let iOS play audio even when the ringer switch is on silent.
      const nav = navigator as Navigator & { audioSession?: { type: string } };
      if (nav.audioSession) nav.audioSession.type = 'playback';
    } catch {
      /* ignore */
    }
    if (this.initialized) return;
    this.initialized = true;
    const reverb = new Tone.Reverb({ decay: 2.6, preDelay: 0.012, wet: 0.17 });
    const comp = new Tone.Compressor({ threshold: -20, ratio: 3, attack: 0.006, release: 0.25 });
    const limiter = new Tone.Limiter(-1);
    this.master = new Tone.Gain(1.5);
    this.master.chain(reverb, comp, limiter, Tone.getDestination());
    this.meter = new Tone.Meter({ normalRange: true, smoothing: 0.6 });
    limiter.connect(this.meter);
    await reverb.ready;
    this.click_ = new Tone.Synth({ oscillator: { type: 'triangle' }, envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.02 } });
    this.click_.volume.value = -10;
    this.click_.connect(comp);
    this.pianoLoaded = this.getInstrument('piano').loaded;
  }

  private getInstrument(id: InstrumentId): Voice {
    let v = this.instruments.get(id);
    if (!v) {
      v = makeInstrument(id);
      v.output.connect(this.master);
      this.instruments.set(id, v);
    }
    return v;
  }

  /** Apply instrument / volume / mute / solo settings. */
  configureParts(parts: Part[]) {
    if (!this.initialized) return;
    const anySolo = parts.some((p) => p.solo);
    this.partInstruments = parts.map((p) => p.instrument);
    parts.forEach((p, i) => {
      if (!this.channels[i]) this.channels[i] = new Tone.Channel().connect(this.master);
      const ch = this.channels[i];
      ch.volume.rampTo(p.volume, 0.05);
      ch.mute = !!p.muted || (anySolo && !p.solo);
      this.getInstrument(p.instrument);
    });
    if (!this.chordChannel) this.chordChannel = new Tone.Channel({ volume: -10 }).connect(this.master);
  }

  async ready(): Promise<void> {
    await Promise.all([...this.instruments.values()].map((v) => v.loaded));
  }

  position(): number {
    if (this.state === 'playing') return Math.max(0, (Tone.now() - this.ctxStart) * this.opts.speed + this.scoreStart);
    return this.pausedAt;
  }

  /** score-time seconds -> audio-context time */
  private ctxTime(scoreTime: number): number {
    return this.ctxStart + (scoreTime - this.scoreStart) / this.opts.speed;
  }

  play(plan: PlaybackPlan, from: number, opts: PlayOptions, muteParts: boolean[]) {
    this.stopInternal(false);
    this.plan = plan;
    this.opts = opts;
    this.muted = muteParts;
    // After silence the phone's speaker or Bluetooth link needs a moment to wake up, and whatever is
    // played in that moment is lost. Give it a head start and something inaudible to wake up on.
    const idle = performance.now() - this.lastSound > 2500;
    const lead = idle ? 0.4 : 0.12;
    if (idle) this.prime(lead);
    this.lastSound = performance.now();
    this.stallClock = -1;
    this.stallNudged = false;
    let countInDur = 0;
    this.beatQueue = [];
    // metronome beats (score time)
    for (const m of plan.measures)
      for (let b = 0; b < m.beats; b++) this.beatQueue.push({ time: m.time + b * m.beatDur, accent: b === 0 });
    if (opts.countIn) {
      const m = plan.measures.find((x) => x.end > from) ?? plan.measures[0];
      if (m) countInDur = m.beats * m.beatDur;
      for (let b = 0; m && b < m.beats; b++) this.beatQueue.push({ time: from - countInDur + b * m.beatDur, accent: b === 0, countIn: true } as never);
      this.beatQueue.sort((a, b) => a.time - b.time);
    }
    this.scoreStart = from;
    this.ctxStart = Tone.now() + lead + countInDur / opts.speed;
    // notes are nudged a few milliseconds early or late for a human feel; one that lands just before
    // the starting point still belongs to it
    this.noteIdx = plan.notes.findIndex((n) => n.time >= from - 0.03);
    if (this.noteIdx < 0) this.noteIdx = plan.notes.length;
    this.beatIdx = this.beatQueue.findIndex((b) => b.time >= from - countInDur - 0.001);
    if (this.beatIdx < 0) this.beatIdx = this.beatQueue.length;
    this.state = 'playing';
    this.timer = setInterval(() => this.tick(), 25);
    this.tick();
  }

  private muted: boolean[] = [];

  /** A sound too quiet to hear, so the output is awake when the first note arrives. */
  private prime(seconds: number) {
    try {
      const ctx = Tone.getContext().rawContext as unknown as AudioContext;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.0004;
      osc.frequency.value = 220;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + seconds + 0.05);
    } catch {
      /* not essential */
    }
  }

  /** True when the audio clock has stood still for too long; tries once to restart it first. */
  private stalled(now: number): boolean {
    const wall = performance.now();
    if (now !== this.stallClock) {
      this.stallClock = now;
      this.stallSince = wall;
      this.stallNudged = false;
      return false;
    }
    const frozen = wall - this.stallSince;
    if (frozen > 600 && !this.stallNudged) {
      this.stallNudged = true;
      void (Tone.getContext().rawContext as unknown as AudioContext).resume().catch(() => undefined);
    }
    return frozen > 2000;
  }

  private tick() {
    const plan = this.plan;
    if (!plan || this.state !== 'playing') return;
    const now = Tone.now();
    if (this.stalled(now)) {
      this.pausedAt = this.position();
      this.stopInternal(false);
      this.state = 'paused';
      this.onStall?.();
      return;
    }
    this.lastSound = performance.now();
    const horizon = (now - this.ctxStart + 0.2) * this.opts.speed + this.scoreStart;
    while (this.noteIdx < plan.notes.length && plan.notes[this.noteIdx].time < horizon) {
      const n = plan.notes[this.noteIdx++];
      const inst = n.part < 0 ? 'piano' : this.partInstruments[n.part] ?? 'piano';
      if (n.part >= 0 && this.channels[n.part]?.mute) continue;
      const t = Math.max(now + 0.005, this.ctxTime(n.time));
      this.routeTrigger(inst, n.part, n.midi, t, n.dur / this.opts.speed, n.velocity);
    }
    while (this.beatIdx < this.beatQueue.length && this.beatQueue[this.beatIdx].time < horizon) {
      const b = this.beatQueue[this.beatIdx++] as { time: number; accent: boolean; countIn?: boolean };
      if ((this.opts.metronome || b.countIn) && this.click_) {
        const t = Math.max(now + 0.005, this.ctxTime(b.time));
        this.click_.triggerAttackRelease(b.accent ? 'A5' : 'E5', 0.03, t, b.accent ? 0.9 : 0.55);
      }
    }
    if (this.position() > plan.duration + 0.05) {
      if (this.opts.loop) {
        this.play(plan, plan.measures[0]?.time ?? 0, this.opts, this.muted);
      } else {
        this.stopInternal(true);
        this.pausedAt = 0;
        this.onEnd?.();
      }
    }
  }

  private routeTrigger(inst: InstrumentId, part: number, midi: number, time: number, dur: number, vel: number) {
    const voice = this.getInstrument(inst);
    // per-part channel volume: instruments are shared, so emulate part volume via velocity scaling
    const ch = part >= 0 ? this.channels[part] : this.chordChannel;
    const db = ch ? ch.volume.value : 0;
    const scale = Math.pow(10, db / 20);
    voice.trigger(midi, time, dur, Math.min(1, vel * scale));
  }

  pause() {
    if (this.state !== 'playing') return;
    this.pausedAt = this.position();
    this.stopInternal(true);
    this.state = 'paused';
  }

  stop() {
    this.stopInternal(true);
    this.pausedAt = 0;
    this.state = 'stopped';
  }

  private stopInternal(release: boolean) {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (release) for (const v of this.instruments.values()) v.releaseAll(Tone.now());
    this.state = 'stopped';
  }

  /** Play a single note immediately (used while editing). */
  preview(midis: number[], instrument: InstrumentId = 'piano') {
    if (!this.initialized) return;
    const v = this.getInstrument(instrument);
    const t = Tone.now() + 0.01;
    for (const m of midis) v.trigger(m, t, 0.45, 0.6);
  }

  /** Play one note of a part right now (used by wait mode). */
  playPartNote(part: number, midi: number, dur: number, vel: number) {
    if (!this.initialized) return;
    const inst = part < 0 ? 'piano' : this.partInstruments[part] ?? 'piano';
    if (part >= 0 && this.channels[part]?.mute) return;
    this.routeTrigger(inst, part, midi, Tone.now() + 0.005, dur, vel);
  }

  click(accent: boolean) {
    this.click_?.triggerAttackRelease(accent ? 'A5' : 'E5', 0.03, Tone.now() + 0.005, accent ? 0.9 : 0.55);
  }

  setSpeed(speed: number) {
    if (this.state === 'playing' && this.plan) {
      const pos = this.position();
      this.play(this.plan, pos, { ...this.opts, speed, countIn: false }, this.muted);
    } else this.opts.speed = speed;
  }
}

export const engine = new Engine();

// Leaving the app (or locking the phone) puts the sound to sleep. On the way back, restart it if it
// can be restarted without a tap, and make the next play check the audio from scratch.
if (typeof document !== 'undefined') {
  const back = () => {
    if (document.visibilityState === 'visible') engine.cameBack();
  };
  document.addEventListener('visibilitychange', back);
  window.addEventListener('pageshow', back);
}
if (import.meta.env?.DEV) Object.assign(window, { __smpEngine: engine, __smpTone: Tone });
