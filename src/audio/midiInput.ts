// MIDI input (digital pianos over USB / Bluetooth). In Chrome, Edge, Firefox and on Android this is
// Web MIDI. Safari and every iPhone/iPad browser lack it, so the iPhone/iPad/Mac app passes the
// keyboard's messages in from Core MIDI instead (src/native.ts).
import { nativeApp } from '../native';

export type MidiListener = (e: { type: 'on' | 'off'; midi: number; velocity: number; time: number; source: 'device' | 'screen' }) => void;

class MidiIn {
  private access: MIDIAccess | null = null;
  private listeners = new Set<MidiListener>();
  readonly held = new Set<number>();
  devices: string[] = [];
  onDevices: ((names: string[]) => void) | null = null;

  get supported(): boolean {
    return nativeApp.available || (typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator);
  }

  /** The iPhone/iPad app can show the system's Bluetooth MIDI pairing sheet. */
  get canBluetooth(): boolean {
    return nativeApp.platform === 'ios';
  }

  bluetooth() {
    nativeApp.post({ type: 'midi.bluetooth' });
  }

  async connect(): Promise<string[]> {
    if (!this.supported) throw new Error('This browser cannot connect to MIDI keyboards (try Chrome or Edge on a computer or Android, or the Sheet Music Player app on iPhone, iPad and Mac).');
    if (nativeApp.available) return this.connectNative();
    if (!this.access) {
      this.access = await navigator.requestMIDIAccess();
      this.access.onstatechange = () => this.bind();
    }
    this.bind();
    return this.devices;
  }

  /** Connect without asking: in the app, or in a browser that has already been given permission. */
  async autoConnect(): Promise<string[]> {
    if (!this.supported) return [];
    if (!nativeApp.available && !this.access) {
      try {
        const p = await navigator.permissions.query({ name: 'midi' as PermissionName });
        if (p.state !== 'granted') return [];
      } catch {
        return [];
      }
    }
    return this.connect().catch(() => []);
  }

  private connectNative(): Promise<string[]> {
    return new Promise((resolve) => {
      // the app answers with the list of keyboards, and again whenever one is plugged in or removed
      const giveUp = setTimeout(() => resolve(this.devices), 1500);
      nativeApp.receive.devices = (names) => {
        this.devices = names;
        this.onDevices?.(names);
        clearTimeout(giveUp);
        resolve(names);
      };
      nativeApp.receive.midi = (status, d1, d2) => this.message(status, d1, d2);
      nativeApp.post({ type: 'midi.connect' });
    });
  }

  private bind() {
    if (!this.access) return;
    this.devices = [];
    this.access.inputs.forEach((input) => {
      this.devices.push(input.name ?? 'MIDI device');
      input.onmidimessage = (ev) => {
        const d = ev.data;
        if (!d || d.length < 2) return;
        this.message(d[0], d[1], d[2] ?? 0);
      };
    });
    this.onDevices?.(this.devices);
  }

  private message(status: number, d1: number, d2: number) {
    const kind = status & 0xf0;
    if (kind === 0x90 && d2 > 0) this.emit('on', d1, d2 / 127, 'device');
    else if (kind === 0x80 || (kind === 0x90 && d2 === 0)) this.emit('off', d1, 0, 'device');
  }

  /** Also used by tests / the on-screen keyboard. */
  emit(type: 'on' | 'off', midi: number, velocity = 0.7, source: 'device' | 'screen' = 'screen') {
    if (type === 'on') this.held.add(midi);
    else this.held.delete(midi);
    const e = { type, midi, velocity, time: performance.now(), source };
    for (const l of this.listeners) l(e);
  }

  subscribe(l: MidiListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

export const midiIn = new MidiIn();
if (import.meta.env?.DEV) (window as unknown as { __smpMidi: MidiIn }).__smpMidi = midiIn;
