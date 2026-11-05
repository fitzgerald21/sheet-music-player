// Small server: serves the built app and proxies transcription requests to Claude so the
// API key can stay on the server. Run `npm run dev` (with Vite) or `npm start` after `npm run build`.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { transcribePages, TranscriptionError, Effort, PageImage } from '../src/omr/transcribe';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../dist');
const PORT = Number(process.env.PORT ?? (process.env.NODE_ENV === 'production' ? 8080 : 8787));
const hasKey = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml',
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
      res.end(JSON.stringify({ ok: true, serverKey: hasKey }));
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
    console.log(`Sheet Music Player server on http://localhost:${PORT}  (Claude key ${hasKey ? 'found' : 'NOT set – users must add their own key in Settings'})`);
  });
