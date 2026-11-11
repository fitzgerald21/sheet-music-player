// "Scan on this device": reads sheet music with homr (AGPL-3.0, https://github.com/liebharc/homr)
// entirely in the browser. This file runs on the page and directs two kinds of worker:
//   py.worker – homr's Python image processing, in Pyodide
//   nn.worker – homr's three neural networks, in onnxruntime-web, loaded one after the other
import type { DecoderConstants } from './py.worker';
import type { DownloadEvent } from './nn.worker';
import { RpcClient } from './rpc';

export type LocalPhase = 'download' | 'segment' | 'detect' | 'read' | 'write' | 'done';
export interface LocalProgress {
  /** page index, or -1 for work shared by all pages */
  page: number;
  phase: LocalPhase;
  /** 0..1 within the phase, when known */
  fraction?: number;
  detail?: string;
}
export interface LocalResult {
  pages: { xml?: string; error?: string }[];
  /** seconds spent in each phase, for diagnostics */
  timings: Record<string, number>;
}

interface Manifest {
  homr: string;
  wheel: string;
  models: Record<'segnet' | 'encoder' | 'decoder', { file: string; bytes: number }>;
}

const CRASH = 'The on-device reader stopped unexpectedly – this device may not have enough free memory for it.';
/** Patches per run of the segmentation network. Small keeps memory down and costs no speed. */
const BATCH = 1;

/** Folder with the models and runtime that scripts/fetch-homr.mjs downloads. */
const homrBase = () => new URL(`${import.meta.env.BASE_URL}homr/`, location.href).href;

let manifest: Promise<Manifest | null> | null = null;
function loadManifest(): Promise<Manifest | null> {
  manifest ??= fetch(homrBase() + 'manifest.json', { cache: 'no-cache' })
    .then(async (r) => (r.ok ? ((await r.json()) as Manifest) : null))
    .then((m) => (m?.models ? m : null))
    .catch(() => null);
  return manifest;
}

/** True when this copy of the app was built with the homr files. */
export async function localScanAvailable(): Promise<boolean> {
  return (await loadManifest()) !== null;
}

/** Size of the one-time download, in MB (models plus the Python runtime). */
export async function localDownloadMB(): Promise<number> {
  const m = await loadManifest();
  if (!m) return 0;
  return Math.round((m.models.segnet.bytes + m.models.encoder.bytes + m.models.decoder.bytes) / 1e6) + 45;
}

export async function scanLocal(images: ArrayBuffer[], onProgress: (p: LocalProgress) => void, signal: AbortSignal): Promise<LocalResult> {
  const m = await loadManifest();
  if (!m) throw new Error('On-device scanning is not included in this copy of the app.');
  const base = homrBase();
  const workers = new Set<RpcClient>();
  const timings: Record<string, number> = {};
  const t0 = performance.now();
  const timed = async <T>(name: string, work: Promise<T> | (() => Promise<T>)): Promise<T> => {
    const start = performance.now();
    try {
      return await (typeof work === 'function' ? work() : work);
    } finally {
      timings[name] = Math.round(((timings[name] ?? 0) + (performance.now() - start) / 1000) * 10) / 10;
    }
  };

  const totalBytes = m.models.segnet.bytes + m.models.encoder.bytes + m.models.decoder.bytes;
  let gotBytes = 0;
  let downloading = true;
  const onEvent = (event: unknown) => {
    const bytes = (event as DownloadEvent).download;
    if (typeof bytes !== 'number') return;
    gotBytes += bytes;
    if (downloading) onProgress({ page: -1, phase: 'download', fraction: Math.min(1, gotBytes / totalBytes), detail: `${Math.round(gotBytes / 1e6)} of ${Math.round(totalBytes / 1e6)} MB` });
  };
  const start = (kind: 'py' | 'nn') => {
    const worker =
      kind === 'py'
        ? new Worker(new URL('./py.worker.ts', import.meta.url), { type: 'module' })
        : new Worker(new URL('./nn.worker.ts', import.meta.url), { type: 'module' });
    const client = new RpcClient(worker, onEvent, CRASH);
    workers.add(client);
    return client;
  };
  const stop = (client: RpcClient) => {
    client.terminate();
    workers.delete(client);
  };

  const run = async (): Promise<LocalResult> => {
    const pages = images.length;
    const errors: (string | undefined)[] = [];
    const alive = (p: number) => errors[p] === undefined;
    const fail = (p: number, e: unknown) => {
      if (signal.aborted) throw e;
      errors[p] = e instanceof Error ? e.message : String(e);
    };

    onProgress({ page: -1, phase: 'download', fraction: 0 });
    const py = start('py');
    const pyReady = timed('setup', py.call<DecoderConstants>('init', base, m.wheel));
    pyReady.catch(() => undefined);

    // ---- 1. find the symbols on every page (segmentation network) ----------------------------
    // Starting WebAssembly can fail when the browser has not yet let go of an earlier scan's memory
    // (iOS Safari). A short wait usually cures it.
    let nn = start('nn');
    let threads = 1;
    for (let attempt = 1; ; attempt++) {
      try {
        ({ threads } = await nn.call<{ threads: number }>('configure', base + 'ort/'));
        await timed('loadModels', nn.call('loadSegnet', base + m.models.segnet.file, threads));
        break;
      } catch (e) {
        if (signal.aborted || attempt >= 3 || !/memory|backend/i.test(String(e))) throw e;
        stop(nn);
        await new Promise((r) => setTimeout(r, 2500));
        nn = start('nn');
      }
    }
    const constants = await pyReady;
    for (let p = 0; p < pages; p++) {
      onProgress({ page: p, phase: 'segment', fraction: 0 });
      try {
        await timed('segment', async () => {
          const patches = await py.call<number>('open', p, images[p]);
          for (let i = 0; i < patches; i += BATCH) {
            const count = Math.min(BATCH, patches - i);
            const input = await py.call<Float32Array>('patches', p, i, count);
            const classes = await nn.call<Uint8Array>('segment', input, count);
            await py.call('classes', p, i, classes);
            onProgress({ page: p, phase: 'segment', fraction: (i + count) / patches });
          }
        });
      } catch (e) {
        fail(p, e);
      }
    }

    // ---- 2. find the staffs (image processing in Python) -----------------------------------------
    const staffs: number[] = [];
    for (let p = 0; p < pages; p++) {
      if (!alive(p)) continue;
      onProgress({ page: p, phase: 'detect' });
      try {
        staffs[p] = await timed('detect', py.call<number>('detect', p));
      } catch (e) {
        fail(p, e);
      }
    }

    // ---- 3. read every staff: the encoder network on all pages, then the decoder network ---------
    const todo = () => images.map((_, p) => p).filter((p) => alive(p) && staffs[p]);
    const step = (p: number, done: number, detail: string) => onProgress({ page: p, phase: 'read', fraction: done / (staffs[p] * 5), detail });
    const encoded: { encoded: Float32Array; dim: number }[][] = [];
    if (todo().length) {
      todo().forEach((p) => step(p, 0, 'Looking at each line…'));
      await timed('loadModels', nn.call('loadEncoder', base + m.models.encoder.file, threads));
      for (const p of todo()) {
        encoded[p] = [];
        try {
          await timed('read', async () => {
            for (let s = 0; s < staffs[p]; s++) {
              const input = await py.call<Float32Array>('staff', p, s);
              encoded[p].push(await nn.call('encode', input));
              step(p, s + 1, 'Looking at each line…');
            }
          });
        } catch (e) {
          fail(p, e);
        }
      }
    }
    if (todo().length) {
      await timed('loadModels', nn.call('loadDecoder', base + m.models.decoder.file, threads));
      downloading = false;
      for (const p of todo()) {
        const count = staffs[p];
        try {
          await timed('read', async () => {
            for (let s = 0; s < count; s++) {
              step(p, count + s * 4, `Reading line ${s + 1} of ${count}…`);
              const { tokens, attention } = await nn.call<{ tokens: Int32Array; attention: Float32Array }>('decode', encoded[p][s].encoded, encoded[p][s].dim, constants);
              await py.call('staffResult', p, s, tokens, attention);
            }
          });
        } catch (e) {
          fail(p, e);
        }
        encoded[p] = [];
      }
    }
    stop(nn);

    // ---- 4. write MusicXML -----------------------------------------------------------------------
    const results: LocalResult['pages'] = [];
    for (let p = 0; p < pages; p++) {
      if (alive(p)) {
        onProgress({ page: p, phase: 'write' });
        try {
          results[p] = { xml: await timed('write', py.call<string>('finish', p)) };
          onProgress({ page: p, phase: 'done' });
          continue;
        } catch (e) {
          fail(p, e);
        }
      }
      results[p] = { error: errors[p] ?? 'This page could not be read.' };
    }
    timings.total = Math.round((performance.now() - t0) / 100) / 10;
    return { pages: results, timings };
  };

  return new Promise<LocalResult>((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      for (const w of [...workers]) stop(w);
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException('Cancelled', 'AbortError'));
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort);
    run().then(
      (r) => {
        cleanup();
        resolve(r);
      },
      (e) => {
        cleanup();
        reject(e);
      },
    );
  });
}
