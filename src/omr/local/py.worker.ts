/// <reference lib="webworker" />
// The Python half of "Scan on this device": homr's image processing, run by Pyodide.
// homr is AGPL-3.0, https://github.com/liebharc/homr. See homr_driver.py for the phases.
import driverSource from './homr_driver.py?raw';
import { serve } from './rpc';

const PYODIDE_URL = 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/';

export interface DecoderConstants {
  max_seq_len: number;
  eos_token: number;
  bos_token: number;
  nonote_token: number;
  caches: number;
  heads: number;
  head_dim: number;
}

interface PyBuffer {
  data: Float32Array;
  release(): void;
}
interface PyArray {
  getBuffer(type?: string): PyBuffer;
  destroy(): void;
}
interface PyJob {
  segnet_patches(): number;
  segnet_batch(start: number, count: number): PyArray;
  set_segnet_classes(start: number, classes: Uint8Array): void;
  detect(): number;
  staff_input(index: number): PyArray;
  set_staff_output(index: number, tokens: Int32Array, attention: Float32Array): void;
  finish(): string;
  destroy(): void;
}
interface Pyodide {
  loadPackage(names: string[]): Promise<void>;
  unpackArchive(data: ArrayBuffer, format: string): void;
  runPython(code: string): unknown;
  FS: { writeFile(path: string, data: Uint8Array): void; unlink(path: string): void };
  globals: { get(name: string): unknown };
}

let py: Pyodide;
const jobs = new Map<number, PyJob>();

function take(proxy: PyArray): Float32Array {
  const buf = proxy.getBuffer('f32');
  try {
    return buf.data.slice();
  } finally {
    buf.release();
    proxy.destroy();
  }
}

/** Python tracebacks are long; the last line says what went wrong. */
function tidy<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    throw new Error(text.trim().split('\n').pop() || text);
  }
}

const job = (page: number) => {
  const j = jobs.get(page);
  if (!j) throw new Error('This page is no longer open.');
  return j;
};

serve({
  async init(base: string, wheel: string): Promise<DecoderConstants> {
    const { loadPyodide } = (await import(/* @vite-ignore */ PYODIDE_URL + 'pyodide.mjs')) as { loadPyodide(o: { indexURL: string }): Promise<Pyodide> };
    py = await loadPyodide({ indexURL: PYODIDE_URL });
    await py.loadPackage(['numpy', 'opencv-python', 'pillow', 'typing-extensions']);
    const res = await fetch(base + wheel);
    if (!res.ok) throw new Error(`Could not download the music reader (${res.status}).`);
    py.unpackArchive(await res.arrayBuffer(), 'wheel');
    py.runPython(driverSource);
    const proxy = (py.globals.get('decoder_constants') as () => { toJs(o: object): DecoderConstants; destroy(): void })();
    const constants = proxy.toJs({ dict_converter: Object.fromEntries });
    proxy.destroy();
    return constants;
  },
  /** Opens a page image; answers how many 320x320 patches the segmentation network must see. */
  open(page: number, image: ArrayBuffer): number {
    const path = `/tmp/page${page}.img`;
    py.FS.writeFile(path, new Uint8Array(image));
    const create = py.globals.get('Job') as (path: string) => PyJob;
    const j = tidy(() => create(path));
    jobs.set(page, j);
    return tidy(() => j.segnet_patches());
  },
  patches: (page: number, start: number, count: number): Float32Array => tidy(() => take(job(page).segnet_batch(start, count))),
  classes: (page: number, start: number, classes: Uint8Array): void => tidy(() => job(page).set_segnet_classes(start, classes)),
  /** Finds the staffs; answers how many staff images there are to read. */
  detect: (page: number): number => tidy(() => job(page).detect()),
  staff: (page: number, index: number): Float32Array => tidy(() => take(job(page).staff_input(index))),
  staffResult: (page: number, index: number, tokens: Int32Array, attention: Float32Array): void =>
    tidy(() => job(page).set_staff_output(index, tokens, attention)),
  finish: (page: number): string => tidy(() => job(page).finish()),
  close(page: number): void {
    jobs.get(page)?.destroy();
    jobs.delete(page);
    try {
      py.FS.unlink(`/tmp/page${page}.img`);
    } catch {
      /* already gone */
    }
  },
});
