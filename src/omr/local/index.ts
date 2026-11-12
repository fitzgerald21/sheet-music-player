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

/**
 * How many decoders to run side by side, and with how many threads each, out of the threads the device
 * allows (one without cross-origin isolation). Two decoders with two threads each read a page about as
 * fast as four with one, for a quarter of the extra memory: each decoder needs roughly 250 MB of its own.
 * iPhones and iPads close a tab that uses too much memory, so they keep one.
 */
export function decoderPlan(threads: number): { count: number; threads: number } {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const apple = /iPhone|iPad|iPod/.test(nav.userAgent) || (/Mac/.test(nav.platform) && nav.maxTouchPoints > 1);
  if (threads < 2 || apple || (nav.deviceMemory !== undefined && nav.deviceMemory < 4)) return { count: 1, threads };
  return { count: 2, threads: Math.max(1, Math.floor(threads / 2)) };
}

const CRASH = 'The on-device reader stopped unexpectedly – this device may not have enough free memory for it.';
/** Patches per run of the segmentation network. Small keeps memory down and costs no speed on the CPU. */
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

/**
 * Reads the pages. `onPage` hears about each page as soon as it is written – usually well before the
 * last page is done – so that slower follow-up work (the AI step) can start on it.
 */
export async function scanLocal(
  images: ArrayBuffer[],
  onProgress: (p: LocalProgress) => void,
  signal: AbortSignal,
  onPage?: (page: number, xml: string) => void,
): Promise<LocalResult> {
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
        // threads need a large block of shared memory up front; a phone short of memory may manage with one
        ({ threads } = await nn.call<{ threads: number }>('configure', base + 'ort/', attempt > 1 ? 1 : 4));
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
    // Python and the network run in separate workers, so the pages overlap: while Python looks for the
    // staffs on one page, the network is already looking at the next. Each worker answers calls in the
    // order they were made, so the next page's patches are asked for before this page's staff search.
    const prepare = (p: number) => {
      const ready = (async () => {
        const count = await py.call<number>('open', p, images[p]);
        return { count, patches: await py.call<Uint8Array>('patches', p, 0, count) };
      })();
      ready.catch(() => undefined);
      return ready;
    };
    const staffs: number[] = [];
    const detecting: Promise<void>[] = [];
    let next = pages ? prepare(0) : null;
    for (let p = 0; p < pages; p++) {
      onProgress({ page: p, phase: 'segment', fraction: 0 });
      const current = next!;
      next = p + 1 < pages ? prepare(p + 1) : null;
      try {
        const stored: Promise<unknown>[] = [];
        await timed('segment', async () => {
          const { count, patches } = await current;
          const size = patches.length / Math.max(1, count);
          for (let i = 0; i < count; i += BATCH) {
            const n = Math.min(BATCH, count - i);
            const classes = await nn.call<Uint8Array>('segment', patches.slice(i * size, (i + n) * size), n);
            stored.push(py.call('classes', p, i, classes));
            onProgress({ page: p, phase: 'segment', fraction: (i + n) / count });
          }
        });
        const found = py.call<number>('detect', p);
        detecting[p] = Promise.all(stored)
          .then(() => found)
          .then(
            (n) => {
              staffs[p] = n;
            },
            (e) => fail(p, e),
          );
        found.catch(() => undefined);
        onProgress({ page: p, phase: 'detect' });
      } catch (e) {
        fail(p, e);
      }
    }
    // ---- 2. find the staffs (image processing in Python) – whatever is still running ---------------
    await timed('detect', Promise.all(detecting));

    // ---- 4 (for each page as soon as all its lines are read). write MusicXML ----------------------
    const results: LocalResult['pages'] = [];
    const writing: Promise<void>[] = [];
    const write = (p: number) =>
      (writing[p] ??= (async () => {
        onProgress({ page: p, phase: 'write' });
        try {
          const xml = await timed('write', py.call<string>('finish', p));
          results[p] = { xml };
          onProgress({ page: p, phase: 'done' });
          onPage?.(p, xml);
        } catch (e) {
          fail(p, e);
        }
      })());

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
          await timed('encode', async () => {
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
      downloading = false;
      // Every line of music is decoded on its own, so several decoders can work side by side, each on
      // a different line. That scales far better than giving one decoder more threads, because each
      // step of the decoder is too small to share out well. Each decoder holds its own copy of the network.
      const plan = decoderPlan(threads);
      const url = base + m.models.decoder.file;
      const decoders: RpcClient[] = [];
      await timed('loadModels', async () => {
        if (plan.count === 1 && plan.threads === threads) {
          await nn.call('loadDecoder', url, threads);
          decoders.push(nn);
          return;
        }
        stop(nn);
        const ready = await Promise.all(
          Array.from({ length: plan.count }, async (_, k) => {
            const worker = start('nn');
            try {
              const { threads: t } = await worker.call<{ threads: number }>('configure', base + 'ort/', plan.threads);
              await worker.call('loadDecoder', url, t);
              return worker;
            } catch (e) {
              stop(worker);
              if (k === 0) throw e;
              return null; // a helper that could not start (memory): the others do its share
            }
          }),
        );
        decoders.push(...ready.filter((w): w is RpcClient => w !== null));
      });
      const jobs = todo().flatMap((p) => Array.from({ length: staffs[p] }, (_, s) => ({ p, s })));
      const done = images.map(() => 0);
      await timed('decode', () =>
        Promise.all(
          decoders.map(async (decoder) => {
            for (let job = jobs.shift(); job; job = jobs.shift()) {
              const { p, s } = job;
              if (!alive(p)) continue;
              try {
                const { tokens, attention } = await decoder.call<{ tokens: Int32Array; attention: Float32Array }>('decode', encoded[p][s].encoded, encoded[p][s].dim, constants);
                await py.call('staffResult', p, s, tokens, attention);
                done[p]++;
                step(p, staffs[p] + done[p] * 4, `Read ${done[p]} of ${staffs[p]} lines…`);
                if (done[p] === staffs[p]) void write(p);
              } catch (e) {
                // a decoder that ran out of memory leaves its line to the others, if there are any
                if (decoder.crashed && decoders.some((d) => d !== decoder && !d.crashed)) {
                  jobs.push(job);
                  return;
                }
                fail(p, e);
              }
            }
          }),
        ),
      );
      encoded.length = 0;
      decoders.forEach(stop);
    }
    if (workers.has(nn)) stop(nn);

    // pages without lines of music, and whatever is still being written
    for (let p = 0; p < pages; p++) if (alive(p)) void write(p);
    await Promise.all(writing);
    for (let p = 0; p < pages; p++) if (!results[p]) results[p] = { error: errors[p] ?? 'This page could not be read.' };
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
