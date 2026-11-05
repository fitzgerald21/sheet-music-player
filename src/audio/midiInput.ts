// Web MIDI input (digital pianos over USB / Bluetooth). Chrome, Edge, Firefox and Android support it;
// iPhone/iPad Safari does not.
export type MidiListener = (e: { type: 'on' | 'off'; midi: number; velocity: number; time: number }) => void;

class MidiIn {
  private access: MIDIAccess | null = null;
  private listeners = new Set<MidiListener>();
  readonly held = new Set<number>();
  devices: string[] = [];
  onDevices: ((names: string[]) => void) | null = null;

  get supported(): boolean {
    return typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator;
  }

  async connect(): Promise<string[]> {
    if (!this.supported) throw new Error('This browser cannot connect to MIDI keyboards (try Chrome, Edge or Android).');
    if (!this.access) {
      this.access = await navigator.requestMIDIAccess();
      this.access.onstatechange = () => this.bind();
    }
    this.bind();
    return this.devices;
  }

  private bind() {
    if (!this.access) return;
    this.devices = [];
    this.access.inputs.forEach((input) => {
      this.devices.push(input.name ?? 'MIDI device');
      input.onmidimessage = (ev) => {
        const d = ev.data;
        if (!d || d.length < 2) return;
        const kind = d[0] & 0xf0;
        if (kind === 0x90 && d[2] > 0) this.emit('on', d[1], d[2] / 127);
        else if (kind === 0x80 || (kind === 0x90 && d[2] === 0)) this.emit('off', d[1], 0);
      };
    });
    this.onDevices?.(this.devices);
  }

  /** Also used by tests / the on-screen keyboard. */
  emit(type: 'on' | 'off', midi: number, velocity = 0.7) {
    if (type === 'on') this.held.add(midi);
    else this.held.delete(midi);
    const e = { type, midi, velocity, time: performance.now() };
    for (const l of this.listeners) l(e);
  }

  subscribe(l: MidiListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

export const midiIn = new MidiIn();
if (import.meta.env?.DEV) (window as unknown as { __smpMidi: MidiIn }).__smpMidi = midiIn;
