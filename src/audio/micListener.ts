// Experimental: listen to an acoustic piano through the microphone and check whether the expected
// notes are sounding. Uses onset detection (spectral flux) plus harmonic energy at each expected pitch.
export interface MicResult {
  /** expected notes currently heard */
  heard: number[];
  /** an attack happened since the last reset */
  onset: boolean;
  level: number;
}

export class MicListener {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private stream: MediaStream | null = null;
  private spec = new Float32Array(0);
  private prev = new Float32Array(0);
  private fluxHistory: number[] = [];
  private onsetFlag = false;
  private lastOnset = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  level = 0;

  async start(source?: MediaStream): Promise<void> {
    this.stream =
      source ??
      (await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }));
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 8192;
    this.analyser.smoothingTimeConstant = 0.2;
    src.connect(this.analyser);
    this.spec = new Float32Array(this.analyser.frequencyBinCount);
    this.prev = new Float32Array(this.analyser.frequencyBinCount);
    this.timer = setInterval(() => this.analyse(), 20);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.ctx = null;
    this.analyser = null;
  }

  private analyse() {
    if (!this.analyser || !this.ctx) return;
    this.prev.set(this.spec);
    this.analyser.getFloatFrequencyData(this.spec);
    const hz = this.ctx.sampleRate / this.analyser.fftSize;
    const lo = Math.floor(60 / hz);
    const hi = Math.floor(4000 / hz);
    let flux = 0;
    let energy = 0;
    for (let i = lo; i < hi; i++) {
      const d = this.spec[i] - this.prev[i];
      if (d > 0 && this.spec[i] > -90) flux += d;
      energy += 10 ** (this.spec[i] / 10);
    }
    this.level = Math.min(1, Math.sqrt(energy) * 30);
    const hist = this.fluxHistory;
    const mean = hist.length ? hist.reduce((a, b) => a + b, 0) / hist.length : flux;
    hist.push(flux);
    if (hist.length > 25) hist.shift();
    const now = performance.now();
    // a new attack: clearly more spectral flux than recently, with a refractory period
    if (flux > mean * 2.2 + 60 && this.level > 0.02 && now - this.lastOnset > 120) {
      this.onsetFlag = true;
      this.lastOnset = now;
    }
  }

  resetOnset() {
    this.onsetFlag = false;
  }

  /** Which of `expected` (MIDI numbers) are sounding now. */
  check(expected: number[]): MicResult {
    if (!this.analyser || !this.ctx) return { heard: [], onset: false, level: 0 };
    const hz = this.ctx.sampleRate / this.analyser.fftSize;
    const sorted = Array.from(this.spec.slice(Math.floor(60 / hz), Math.floor(4000 / hz))).sort((a, b) => a - b);
    const floor = sorted[Math.floor(sorted.length * 0.5)] ?? -100;
    const peakAt = (f: number) => {
      const c = Math.round(f / hz);
      const w = Math.max(1, Math.round((f * 0.025) / hz));
      let m = -200;
      for (let i = c - w; i <= c + w; i++) if (i > 0 && i < this.spec.length) m = Math.max(m, this.spec[i]);
      return m;
    };
    const heard = expected.filter((midi) => {
      const f0 = 440 * 2 ** ((midi - 69) / 12);
      // above C3 a piano's fundamental is strong, so require it (overtones of other notes would fool us);
      // for low notes the fundamental is weak, so the octave overtone also counts
      const e = midi >= 48 ? peakAt(f0) : Math.max(peakAt(f0), peakAt(f0 * 2) - 3);
      return e - floor > 25;
    });
    return { heard, onset: this.onsetFlag, level: this.level };
  }
}
