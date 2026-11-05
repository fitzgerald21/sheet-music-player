// Chooses between transcribing through our server (key on server) or directly from the browser (user's key).
import Anthropic from '@anthropic-ai/sdk';
import { Effort, PageImage, PagesProgress, transcribePages } from './transcribe';
import { PageTranscription } from './schema';

export interface ClientSettings {
  apiKey: string;
  model: string;
  effort: Effort;
}

let serverKeyCache: boolean | null = null;
export async function serverHasKey(): Promise<boolean> {
  if (serverKeyCache !== null) return serverKeyCache;
  try {
    const r = await fetch('/api/health');
    serverKeyCache = r.ok ? !!(await r.json()).serverKey : false;
  } catch {
    serverKeyCache = false;
  }
  return serverKeyCache;
}

export async function transcribe(
  images: PageImage[],
  settings: ClientSettings,
  onProgress: (p: PagesProgress) => void,
  signal: AbortSignal,
): Promise<PageTranscription[]> {
  if (settings.apiKey.trim()) {
    const client = new Anthropic({ apiKey: settings.apiKey.trim(), dangerouslyAllowBrowser: true });
    return transcribePages(client, images, { model: settings.model, effort: settings.effort, onProgress, signal });
  }
  if (!(await serverHasKey())) throw new Error('NO_KEY');
  const res = await fetch('/api/transcribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ images, model: settings.model, effort: settings.effort }),
    signal,
  });
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
      const msg = JSON.parse(line);
      if (msg.type === 'progress') onProgress({ page: msg.page, progress: msg.progress });
      else if (msg.type === 'result') return msg.pages as PageTranscription[];
      else if (msg.type === 'error') throw new Error(msg.message);
    }
  }
  throw new Error('The connection closed before the transcription finished.');
}
