// The iPhone/iPad/Mac app (see apple/) shows this same web app in a WKWebView and adds what Safari
// leaves out: MIDI keyboards, saving files, printing and keeping the screen awake. In a normal
// browser `available` is false and nothing here does anything.
type Platform = 'ios' | 'mac';

export type NativeMessage =
  | { type: 'midi.connect' }
  | { type: 'midi.bluetooth' }
  | { type: 'awake'; on: boolean }
  | { type: 'save'; name: string; base64: string }
  | { type: 'print' };

/** Calls the app makes into the page. */
interface Receive {
  midi?: (status: number, d1: number, d2: number) => void;
  devices?: (names: string[]) => void;
}

type NativeWindow = Window & {
  webkit?: { messageHandlers?: { smp?: { postMessage(msg: NativeMessage): void } } };
  __smpPlatform?: Platform;
  __smpNative?: Receive;
};

const w = typeof window !== 'undefined' ? (window as NativeWindow) : undefined;
const handler = w?.webkit?.messageHandlers?.smp;
const receive: Receive = {};
if (w && handler) w.__smpNative = receive;

export const nativeApp = {
  available: !!handler,
  platform: (handler ? w?.__smpPlatform ?? null : null) as Platform | null,
  receive,
  post(msg: NativeMessage) {
    handler?.postMessage(msg);
  },
  /** Hand a file to the app, which shows the share sheet (iPhone/iPad) or a save dialog (Mac). */
  save(name: string, blob: Blob) {
    const reader = new FileReader();
    reader.onload = () => this.post({ type: 'save', name, base64: String(reader.result).replace(/^[^,]*,/, '') });
    reader.readAsDataURL(blob);
  },
};
