// Small server: serves the built app and proxies transcription requests to Claude so the
// API key can stay on the server. Run `npm run dev` (with Vite) or `npm start` after `npm run build`.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { execFile } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';
import { transcribePages, TranscriptionError, Effort, PageImage } from '../src/omr/transcribe';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../dist');
const PORT = Number(process.env.PORT ?? (process.env.NODE_ENV === 'production' ? 8080 : 8787));
const hasKey = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
// Optional free OMR engine: set AUDIVERIS_CMD to the Audiveris launcher (e.g. /opt/audiveris/bin/Audiveris).
const AUDIVERIS = process.env.AUDIVERIS_CMD && fs.existsSync(process.env.AUDIVERIS_CMD) ? process.env.AUDIVERIS_CMD : '';
const UA = 'SheetMusicPlayer/0.2 (personal sheet music app)';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function readBody(req: http.IncomingMessage, limit = 60 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleTranscribe(req: http.IncomingMessage, res: http.ServerResponse) {
  if (!hasKey) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'The server has no ANTHROPIC_API_KEY. Add your key in Settings instead.' }));
    return;
  }
  let body: { images: PageImage[]; model?: string; effort?: Effort };
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: (e as Error).message }));
    return;
  }
  if (!Array.isArray(body.images) || !body.images.length || body.images.length > 20) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Send 1–20 images.' }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) abort.abort();
  });
  const send = (o: unknown) => res.write(JSON.stringify(o) + '\n');
  const client = new Anthropic();
  try {
    const pages = await transcribePages(client, body.images, {
      model: body.model,
      effort: body.effort,
      signal: abort.signal,
      onProgress: (p) => send({ type: 'progress', ...p }),
    });
    send({ type: 'result', pages });
  } catch (e) {
    send({ type: 'error', message: e instanceof Error ? e.message : String(e), kind: e instanceof TranscriptionError ? e.kind : 'api' });
  }
  res.end();
}

// ---------- IMSLP (search + file lists; downloads happen on imslp.org) ----------
async function imslpApi(params: Record<string, string>) {
  const u = new URL('https://imslp.org/api.php');
  for (const [k, v] of Object.entries({ ...params, format: 'json' })) u.searchParams.set(k, v);
  const r = await fetch(u, { headers: { 'user-agent': UA } });
  if (!r.ok) throw new Error(`IMSLP ${r.status}`);
  return r.json();
}

async function handleImslp(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '', 'http://x');
  const json = (code: number, o: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(o));
  };
  try {
    if (url.pathname === '/api/imslp/search') {
      const q = (url.searchParams.get('q') ?? '').slice(0, 200);
      if (!q) return json(400, { error: 'missing q' });
      const fold = (x: string) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      const words = fold(q).split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
      const titles = new Set<string>();
      const search = async (srsearch: string, extra: Record<string, string> = {}) => {
        const j = await imslpApi({ action: 'query', list: 'search', srsearch, srnamespace: '0', srlimit: '50', ...extra });
        for (const r of j.query?.search ?? []) titles.add(r.title);
      };
      await Promise.all([search(q), search(q, { srwhat: 'title' })]);
      // IMSLP search is accent-sensitive: also search single words and match titles without accents
      if (titles.size < 8) await Promise.all(words.slice(0, 3).map((w) => search(w).catch(() => {})));
      const all = [...titles].filter((t) => /\(.+\)$/.test(t));
      const scored = all
        .map((t) => ({ t, hits: words.filter((w) => fold(t).includes(w)).length }))
        .filter((x) => x.hits > 0 || words.length === 0)
        .sort((a, b) => b.hits - a.hits || a.t.length - b.t.length);
      const works = scored.slice(0, 30).map((x) => ({ title: x.t }));
      return json(200, { works });
    }
    if (url.pathname === '/api/imslp/files') {
      const title = (url.searchParams.get('title') ?? '').slice(0, 300);
      const j = await imslpApi({ action: 'parse', page: title, prop: 'wikitext', redirects: '1' });
      const text: string = j.parse?.wikitext?.['*'] ?? '';
      // descriptions follow their file name within the same file block
      const blocks = text.split(/\{\{#fte:imslpfile/);
      const files: { name: string; description: string; page: string; kind: string }[] = [];
      for (const b of blocks) {
        for (const m of b.matchAll(/\|\s*File Name (\d+)\s*=\s*([^\n|]+)/g)) {
          const name = m[2].trim();
          const d = new RegExp(`\\|\\s*File Description ${m[1]}\\s*=\\s*([^\\n|]+)`).exec(b);
          const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();
          const kind = ext === 'pdf' ? 'pdf' : ext === 'mid' || ext === 'midi' ? 'midi' : ['xml', 'mxl', 'musicxml'].includes(ext) ? 'musicxml' : '';
          if (!kind) continue;
          const desc = (d?.[1] ?? '').replace(/\{\{[^}]*\}\}|\[\[|\]\]|''+/g, '').trim();
          files.push({ name, description: desc.slice(0, 140), page: `https://imslp.org/wiki/File:${encodeURIComponent(name.replace(/ /g, '_'))}`, kind });
        }
      }
      files.sort((a, b) => ['musicxml', 'midi', 'pdf'].indexOf(a.kind) - ['musicxml', 'midi', 'pdf'].indexOf(b.kind));
      return json(200, { files: files.slice(0, 60) });
    }
    json(404, { error: 'not found' });
  } catch (e) {
    json(502, { error: (e as Error).message });
  }
}

// ---------- Audiveris (optional, algorithmic OMR) ----------
function runAudiveris(input: string, outDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(AUDIVERIS, ['-batch', '-export', '-output', outDir, input], { timeout: 6 * 60_000, maxBuffer: 32 * 1024 * 1024 }, (err) => (err ? reject(err) : resolve()));
  });
}

function findMxl(dir: string): string | null {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const r = findMxl(p);
      if (r) return r;
    } else if (/\.mxl$/i.test(e.name)) return p;
  }
  return null;
}

async function handleAudiveris(req: http.IncomingMessage, res: http.ServerResponse) {
  if (!AUDIVERIS) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Audiveris is not installed on this server (set AUDIVERIS_CMD).' }));
    return;
  }
  let body: { images: PageImage[] };
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    res.writeHead(400).end(JSON.stringify({ error: (e as Error).message }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' });
  const send = (o: unknown) => res.write(JSON.stringify(o) + '\n');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'smp-omr-'));
  const pages: { mxl?: string; error?: string }[] = [];
  try {
    for (let i = 0; i < body.images.length && i < 20; i++) {
      send({ type: 'progress', page: i, phase: 'thinking' });
      const img = body.images[i];
      const ext = img.mediaType === 'image/png' ? 'png' : img.mediaType === 'image/webp' ? 'webp' : 'jpg';
      const input = path.join(work, `page${i + 1}.${ext}`);
      const out = path.join(work, `out${i + 1}`);
      fs.mkdirSync(out);
      fs.writeFileSync(input, Buffer.from(img.data, 'base64'));
      try {
        await runAudiveris(input, out);
        const mxl = findMxl(out);
        pages.push(mxl ? { mxl: fs.readFileSync(mxl).toString('base64') } : { error: 'Audiveris found no music on this page.' });
      } catch (e) {
        pages.push({ error: `Audiveris failed: ${(e as Error).message.slice(0, 200)}` });
      }
    }
    send({ type: 'result', pages });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    res.end();
  }
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  let file = path.join(dist, decodeURIComponent(url.pathname));
  if (!file.startsWith(dist)) {
    res.writeHead(403).end();
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(404).end('Not built – run `npm run build` first, or use `npm run dev`.');
    return;
  }
  const ext = path.extname(file);
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  fs.createReadStream(file).pipe(res);
}

http
  .createServer((req, res) => {
    if (req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, serverKey: hasKey, audiveris: !!AUDIVERIS, imslp: true }));
      return;
    }
    if (req.url?.startsWith('/api/imslp/')) {
      void handleImslp(req, res);
      return;
    }
    if (req.url === '/api/omr/audiveris' && req.method === 'POST') {
      handleAudiveris(req, res).catch((e) => {
        console.error(e);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
      return;
    }
    if (req.url === '/api/transcribe' && req.method === 'POST') {
      handleTranscribe(req, res).catch((e) => {
        console.error(e);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
      return;
    }
    serveStatic(req, res);
  })
  .listen(PORT, () => {
    console.log(`Sheet Music Player server on http://localhost:${PORT}  (Claude key ${hasKey ? 'found' : 'NOT set – users must add their own key in Settings'}; Audiveris ${AUDIVERIS ? 'enabled' : 'not configured'})`);
  });
