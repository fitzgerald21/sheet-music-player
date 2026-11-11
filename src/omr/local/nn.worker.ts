/// <reference lib="webworker" />
// The neural-network half of "Scan on this device": homr's ONNX models, run by onnxruntime-web.
// A worker is started for one network at a time and then closed, which is the only way to give that
// network's memory back (WebAssembly memory never shrinks).
import * as ort from 'onnxruntime-web/wasm';
import type { DecoderConstants } from './py.worker';
import { emit, serve } from './rpc';

const CACHE = 'homr-models-v1';
const WIN = 320;
const CLASSES = 6;

/** Sent while a model downloads. */
export interface DownloadEvent {
  download: number;
}

/** Fetch a large file once and keep it in Cache Storage, which survives where the HTTP cache may not. */
async function fetchCached(url: string, onBytes: (n: number) => void): Promise<Uint8Array> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open(CACHE);
    const hit = await cache.match(url);
    if (hit) {
      const buf = new Uint8Array(await hit.arrayBuffer());
      onBytes(buf.length);
      return buf;
    }
  } catch {
    cache = null; // private browsing, or storage unavailable
  }
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Could not download ${url.split('/').pop()} (${res.status}).`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  let buf = new Uint8Array(total || 1 << 20);
  let n = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (n + value.length > buf.length) {
      const bigger = new Uint8Array(Math.max(buf.length * 2, n + value.length));
      bigger.set(buf.subarray(0, n));
      buf = bigger;
    }
    buf.set(value, n);
    n += value.length;
    onBytes(value.length);
  }
  const out = buf.subarray(0, n);
  try {
    await cache?.put(url, new Response(out.slice(), { headers: { 'content-type': 'application/octet-stream' } }));
  } catch {
    /* out of quota: fine, it is simply downloaded again next time */
  }
  return out;
}

function argmax(data: Float32Array, from: number, count: number): number {
  let best = 0;
  let max = -Infinity;
  for (let i = 0; i < count; i++) {
    const v = data[from + i];
    if (v > max) {
      max = v;
      best = i;
    }
  }
  return best;
}

/** [B, 6, 320, 320] logits → the class of every pixel. */
function pixelClasses(logits: Float32Array, batch: number): Uint8Array {
  const plane = WIN * WIN;
  const out = new Uint8Array(batch * plane);
  for (let b = 0; b < batch; b++) {
    const base = b * CLASSES * plane;
    for (let p = 0; p < plane; p++) {
      let best = 0;
      let max = logits[base + p];
      for (let c = 1; c < CLASSES; c++) {
        const v = logits[base + c * plane + p];
        if (v > max) {
          max = v;
          best = c;
        }
      }
      out[b * plane + p] = best;
    }
  }
  return out;
}

const HEADS = ['out_rhythms', 'out_pitchs', 'out_lifts', 'out_positions', 'out_articulations', 'out_slurs'];

/**
 * One of the decoder's cross-attention caches. homr's decoder appends the same row to these on every step, and they
 * are large (the whole encoded staff), so instead of copying them out of the network each step they are grown here.
 */
class GrowingCache {
  private buf: Float32Array;
  private len: number;
  private row: Float32Array | null = null;
  constructor(
    first: ort.Tensor,
    private heads: number,
    private width: number,
    maxSteps: number,
  ) {
    this.len = first.dims[2];
    this.buf = new Float32Array(heads * (this.len + maxSteps + 1) * width);
    this.buf.set(first.data as Float32Array);
  }
  /** Take the network's own output once, to learn the row it appends. */
  learn(next: ort.Tensor) {
    const data = next.data as Float32Array;
    const len = next.dims[2];
    const block = len * this.width;
    this.row = new Float32Array(this.heads * this.width);
    for (let h = 0; h < this.heads; h++) this.row.set(data.subarray(h * block + block - this.width, h * block + block), h * this.width);
    this.buf.set(data);
    this.len = len;
  }
  /** What the network would have returned after one more step. */
  grow() {
    const { heads, width, len, buf } = this;
    const row = this.row!;
    for (let h = heads - 1; h >= 0; h--) {
      const from = h * len * width;
      const to = h * (len + 1) * width;
      buf.copyWithin(to, from, from + len * width);
      buf.set(row.subarray(h * width, (h + 1) * width), to + len * width);
    }
    this.len = len + 1;
  }
  tensor(): ort.Tensor {
    return new ort.Tensor('float32', this.buf.subarray(0, this.heads * this.len * this.width), [1, this.heads, this.len, this.width]);
  }
}

/** Greedy decoding of one encoded staff image, the same loop as homr's ScoreDecoder.generate. */
async function decodeStaff(
  decoder: ort.InferenceSession,
  encoded: Float32Array,
  dim: number,
  c: DecoderConstants,
): Promise<{ tokens: Int32Array; attention: Float32Array }> {
  const context = new ort.Tensor('float32', encoded, [1, encoded.length / dim, dim]);
  const contextReduced = new ort.Tensor('float32', encoded.slice(0, dim), [1, 1, dim]);
  const int = (v: number, dims: number[]) => new ort.Tensor('int64', BigInt64Array.from([BigInt(v)]), dims);
  const cache: ort.Tensor[] = Array.from({ length: c.caches }, () => new ort.Tensor('float32', new Float32Array(0), [1, c.heads, 0, c.head_dim]));
  const cross: (GrowingCache | null)[] = Array.from({ length: c.caches }, () => null);
  const cacheOut = Array.from({ length: c.caches }, (_, i) => `cache_out${i}`);
  const allFetches = [...HEADS, 'attention', ...cacheOut];
  let fetches = allFetches;
  // previous symbol: rhythm, pitch, lift, articulation, slur
  let last = [c.bos_token, c.nonote_token, c.nonote_token, c.nonote_token, c.nonote_token];
  const tokens: number[] = [];
  const attention: number[] = [];
  for (let step = 0; step < c.max_seq_len; step++) {
    const feeds: Record<string, ort.Tensor> = {
      rhythms: int(last[0], [1, 1]),
      pitchs: int(last[1], [1, 1]),
      lifts: int(last[2], [1, 1]),
      articulations: int(last[3], [1, 1]),
      slurs: int(last[4], [1, 1]),
      context: step === 0 ? context : contextReduced,
      cache_len: int(step, [1]),
    };
    for (let i = 0; i < c.caches; i++) feeds[`cache_in${i}`] = cross[i]?.tensor() ?? cache[i];
    const out = await decoder.run(feeds, fetches);
    for (let i = 0; i < c.caches; i++) {
      const t = out[cacheOut[i]] as ort.Tensor | undefined;
      if (step === 0 && t && t.dims[2] > 1) cross[i] = new GrowingCache(t, c.heads, c.head_dim, c.max_seq_len);
      else if (cross[i]) t ? cross[i]!.learn(t) : cross[i]!.grow();
      else if (t) cache[i] = t;
    }
    // from the third step on, the cross-attention caches are no longer read back
    if (step === 1) fetches = allFetches.filter((name, k) => k < HEADS.length + 1 || !cross[k - HEADS.length - 1]);
    const pick = HEADS.map((name) => {
      const t = out[name];
      const vocab = t.dims[t.dims.length - 1];
      const data = t.data as Float32Array;
      return argmax(data, data.length - vocab, vocab);
    });
    const [rhythm, pitch, lift, position, articulation, slur] = pick;
    if (rhythm === c.eos_token) break;
    tokens.push(rhythm, pitch, lift, position, articulation, slur);
    const att = out.attention.data as Float32Array;
    attention.push(att[0], att[1]);
    last = [rhythm, pitch, lift, articulation, slur];
  }
  return { tokens: Int32Array.from(tokens), attention: Float32Array.from(attention) };
}

async function load(url: string, threads: number): Promise<ort.InferenceSession> {
  ort.env.wasm.numThreads = threads;
  let bytes: Uint8Array | null = await fetchCached(url, (n) => emit({ download: n } satisfies DownloadEvent));
  const session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all', enableCpuMemArena: false, enableMemPattern: false });
  bytes = null;
  return session;
}

let segnet: ort.InferenceSession | null = null;
let encoder: ort.InferenceSession | null = null;
let decoder: ort.InferenceSession | null = null;

serve({
  configure(ortPath: string): { threads: number } {
    ort.env.wasm.wasmPaths = ortPath;
    return { threads: self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1 };
  },
  async loadSegnet(url: string, threads: number): Promise<void> {
    segnet = await load(url, threads);
  },
  /** patches: float32 [count, 3, 320, 320] → the class of every pixel, uint8 [count, 320, 320] */
  async segment(patches: Float32Array, count: number): Promise<Uint8Array> {
    const out = await segnet!.run({ input: new ort.Tensor('float32', patches, [count, 3, WIN, WIN]) });
    return pixelClasses(out.output.data as Float32Array, count);
  },
  async loadEncoder(url: string, threads: number): Promise<void> {
    encoder = await load(url, threads);
  },
  /** One staff image, float32 [1, 1, 256, 1280] → what the decoder reads, float32 [tokens, dim]. */
  async encode(input: Float32Array): Promise<{ encoded: Float32Array; dim: number }> {
    const out = (await encoder!.run({ input: new ort.Tensor('float32', input, [1, 1, 256, 1280]) })).output;
    return { encoded: out.data as Float32Array, dim: out.dims[2] };
  },
  async loadDecoder(url: string, threads: number): Promise<void> {
    decoder = await load(url, threads);
  },
  /** An encoded staff → the symbols on it. */
  async decode(encoded: Float32Array, dim: number, constants: DecoderConstants): Promise<{ tokens: Int32Array; attention: Float32Array }> {
    return decodeStaff(decoder!, encoded, dim, constants);
  },
});
