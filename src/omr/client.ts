// Runs a scan with the engine chosen in Settings:
//  - Claude: through our server (key on server) or straight from the browser (user's key)
//  - OpenAI-compatible APIs (OpenRouter, DeepInfra, …): from the browser with the user's key
//  - Audiveris (open-source, algorithmic OMR): on our server, if it is installed there
import Anthropic from '@anthropic-ai/sdk';
import { PageImage, PagesProgress, transcribePages, transcribePagesWith } from './transcribe';
import { PageTranscription } from './schema';
import { transcribePageCompat } from './openaiCompat';
import { ConvertResult, convertPages } from './convert';
import { Settings } from '../storage';
import { mergeScores } from '../model/merge';

const api = (path: string) => `${import.meta.env.BASE_URL}api/${path}`;

export interface ServerInfo {
  serverKey: boolean;
  audiveris: boolean;
  imslp: boolean;
}

let infoCache: Promise<ServerInfo> | null = null;
export function serverInfo(): Promise<ServerInfo> {
  infoCache ??= fetch(api('health'))
    .then(async (r) => {
      if (!r.ok) throw new Error();
      const j = await r.json();
      return { serverKey: !!j.serverKey, audiveris: !!j.audiveris, imslp: !!j.imslp };
    })
    .catch(() => ({ serverKey: false, audiveris: false, imslp: false }));
  return infoCache;
}

export async function serverHasKey(): Promise<boolean> {
  return (await serverInfo()).serverKey;
}

/** Read NDJSON progress/result messages from a streaming response. */
async function readNdjson<T>(res: Response, onMsg: (m: { type: string; [k: string]: unknown }) => T | undefined): Promise<T> {
  if (!res.ok || !res.body) {
    let msg = `Server error ${res.status}`;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const r = onMsg(JSON.parse(line));
      if (r !== undefined) return r;
    }
  }
  throw new Error('The connection closed before the scan finished.');
}

export async function transcribe(images: PageImage[], settings: Settings, onProgress: (p: PagesProgress) => void, signal: AbortSignal): Promise<PageTranscription[]> {
  if (settings.apiKey.trim()) {
    const client = new Anthropic({ apiKey: settings.apiKey.trim(), dangerouslyAllowBrowser: true });
    return transcribePages(client, images, { model: settings.model, effort: settings.effort, onProgress, signal });
  }
  if (!(await serverHasKey())) throw new Error('NO_KEY');
  const res = await fetch(api('transcribe'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ images, model: settings.model, effort: settings.effort }),
    signal,
  });
  return readNdjson(res, (msg) => {
    if (msg.type === 'progress') onProgress({ page: msg.page as number, progress: msg.progress as PagesProgress['progress'] });
    else if (msg.type === 'result') return msg.pages as PageTranscription[];
    else if (msg.type === 'error') throw new Error(msg.message as string);
    return undefined;
  });
}

/** Scan pages with the configured engine and return a score. */
export async function scanPages(images: PageImage[], settings: Settings, onProgress: (p: PagesProgress) => void, signal: AbortSignal): Promise<ConvertResult> {
  if (settings.engine === 'compat') {
    if (!settings.compatKey.trim()) throw new Error('NO_KEY');
    const cfg = { baseUrl: settings.compatBaseUrl, apiKey: settings.compatKey.trim(), model: settings.compatModel.trim() };
    const pages = await transcribePagesWith((img, ctx, p) => transcribePageCompat(cfg, img, ctx, p, signal), images, onProgress);
    return convertPages(pages);
  }
  if (settings.engine === 'local') {
    const { scanLocal, localScanAvailable } = await import('./local');
    if (!(await localScanAvailable())) throw new Error('On-device scanning is not included in this copy of the app. Run “npm run fetch-homr” and rebuild, or pick another reader in Settings.');
    const buffers = images.map((img) => Uint8Array.from(atob(img.data), (c) => c.charCodeAt(0)).buffer);
    const say = (page: number, label: string, phase: 'thinking' | 'writing' | 'done' = 'thinking', measures = 0) => onProgress({ page, progress: { phase, label, measures, chars: 0 } });
    const started = new Set<number>();
    const result = await scanLocal(
      buffers,
      (p) => {
        const pct = p.fraction != null ? ` ${Math.round(p.fraction * 100)}%` : '';
        if (p.page < 0) {
          // shared work (the one-time download) is shown on every page that has not started yet
          images.forEach((_, i) => !started.has(i) && say(i, `Getting the music reader ready…${p.detail ? ` ${p.detail}` : ''}`));
          return;
        }
        started.add(p.page);
        if (p.phase === 'segment') say(p.page, `Finding the notes…${pct}`);
        else if (p.phase === 'detect') say(p.page, 'Finding the staff lines…');
        else if (p.phase === 'read') say(p.page, p.detail ?? 'Reading the music…', 'writing');
        else if (p.phase === 'write') say(p.page, 'Writing the score…', 'writing');
      },
      signal,
    );
    const { parseMusicXML } = await import('../importers/musicxml');
    const scores: ReturnType<typeof parseMusicXML>[] = [];
    const warnings: string[] = [];
    result.pages.forEach((p, i) => {
      if (!p.xml) {
        warnings.push(`Page ${i + 1} could not be read: ${p.error ?? 'unknown problem'}`);
        return;
      }
      const s = parseMusicXML(p.xml);
      scores.push(s);
      say(i, 'Done', 'done', s.measures.length);
    });
    if (!scores.length) throw new Error(warnings.join(' ') || 'No music was found on these pages.');
    const score = mergeScores(scores);
    if (!score.title || score.title === 'Untitled') score.title = 'Scanned music';
    score.notes = [...(score.notes ?? []), 'Read on this device with homr. Notes and rhythms only: add the title, tempo, chord symbols and lyrics yourself.'];
    return { score, warnings, repaired: [] };
  }
  if (settings.engine === 'audiveris') {
    if (!(await serverInfo()).audiveris) throw new Error('Audiveris is not installed on the server. See the README (“Free algorithmic scanning”).');
    images.forEach((_, i) => onProgress({ page: i, progress: { phase: 'sending', measures: 0, chars: 0 } }));
    const res = await fetch(api('omr/audiveris'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ images }), signal });
    const pages = await readNdjson(res, (msg) => {
      if (msg.type === 'progress') onProgress({ page: msg.page as number, progress: { phase: msg.phase as 'thinking', measures: 0, chars: 0 } });
      else if (msg.type === 'result') return msg.pages as { mxl?: string; error?: string }[];
      else if (msg.type === 'error') throw new Error(msg.message as string);
      return undefined;
    });
    const { parseMusicXML, musicXmlText } = await import('../importers/musicxml');
    const scores = [];
    const warnings: string[] = [];
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      if (!p.mxl) {
        warnings.push(`Page ${i + 1}: ${p.error ?? 'Audiveris could not read this page.'}`);
        continue;
      }
      const bytes = Uint8Array.from(atob(p.mxl), (c) => c.charCodeAt(0));
      scores.push(parseMusicXML(musicXmlText(bytes)));
      onProgress({ page: i, progress: { phase: 'done', measures: scores[scores.length - 1].measures.length, chars: 0 } });
    }
    if (!scores.length) throw new Error(warnings.join(' ') || 'Audiveris could not read these pages.');
    const score = mergeScores(scores);
    score.notes = [...(score.notes ?? []), 'Read with Audiveris (algorithmic OMR).', ...warnings];
    return { score, warnings, repaired: [] };
  }
  return convertPages(await transcribe(images, settings, onProgress, signal));
}
