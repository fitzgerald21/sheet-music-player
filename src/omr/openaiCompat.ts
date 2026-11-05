// Page transcription through any OpenAI-compatible chat API (OpenRouter, DeepInfra, a local server…).
// Uses the same prompt and output format as the Claude path.
import { PAGE_SCHEMA, PageTranscription } from './schema';
import { PageContext, SYSTEM_PROMPT, userPrompt } from './prompt';
import { PageImage, TranscribeProgress, TranscriptionError } from './transcribe';

export interface CompatConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const COMPAT_PRESETS: { id: string; label: string; baseUrl: string; example: string }[] = [
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', example: 'e.g. qwen/qwen2.5-vl-72b-instruct' },
  { id: 'deepinfra', label: 'DeepInfra', baseUrl: 'https://api.deepinfra.com/v1/openai', example: 'e.g. Qwen/Qwen2.5-VL-72B-Instruct' },
  { id: 'custom', label: 'Other (OpenAI-compatible)', baseUrl: '', example: 'model id' },
];

function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error('no JSON');
  }
}

export async function transcribePageCompat(cfg: CompatConfig, image: PageImage, ctx: PageContext, onProgress: (p: TranscribeProgress) => void, signal?: AbortSignal): Promise<PageTranscription> {
  if (!cfg.baseUrl || !cfg.model) throw new TranscriptionError('Set the API address and model in Settings.', 'auth');
  onProgress({ phase: 'sending', measures: 0, chars: 0 });
  const body = (format: unknown) => ({
    model: cfg.model,
    max_tokens: 32000,
    temperature: 0,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT + '\n\nReply with the JSON object only.' },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.data}` } },
          { type: 'text', text: userPrompt(ctx) },
        ],
      },
    ],
    ...(format ? { response_format: format } : {}),
  });
  const call = async (format: unknown) => {
    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}`, 'X-Title': 'Sheet Music Player' },
      body: JSON.stringify(body(format)),
      signal,
    });
    return res;
  };
  onProgress({ phase: 'thinking', measures: 0, chars: 0 });
  let res = await call({ type: 'json_schema', json_schema: { name: 'page', strict: true, schema: PAGE_SCHEMA } });
  if (res.status === 400 || res.status === 422) res = await call({ type: 'json_object' });
  if (res.status === 400 || res.status === 422) res = await call(null);
  if (res.status === 401 || res.status === 403) throw new TranscriptionError('The API key was rejected. Check it in Settings.', 'auth');
  if (res.status === 429) throw new TranscriptionError('Rate limited – wait a minute and retry.', 'rate_limit');
  if (!res.ok) throw new TranscriptionError(`API error ${res.status}: ${(await res.text()).slice(0, 300)}`, 'api');
  const data = await res.json();
  const text: string = data?.choices?.[0]?.message?.content ?? '';
  if (data?.choices?.[0]?.finish_reason === 'length') throw new TranscriptionError('The model ran out of output space on this page.', 'truncated');
  let parsed: PageTranscription;
  try {
    parsed = normalise(extractJson(text));
  } catch {
    throw new TranscriptionError('The model did not return usable notation. Try another model (it must support images).', 'invalid');
  }
  onProgress({ phase: 'done', measures: parsed.measures.length, chars: text.length });
  return parsed;
}

/** Models without schema enforcement may leave fields out – fill defaults so the converter can cope. */
function normalise(raw: unknown): PageTranscription {
  const r = (raw ?? {}) as Partial<PageTranscription>;
  return {
    title: r.title ?? '',
    composer: r.composer ?? '',
    lyricist: r.lyricist ?? '',
    arranger: r.arranger ?? '',
    pageNumber: Number(r.pageNumber) || 0,
    tempo: Number(r.tempo) || 0,
    timeSignature: r.timeSignature ?? '4/4',
    keyFifths: Number(r.keyFifths) || 0,
    parts: Array.isArray(r.parts) && r.parts.length ? r.parts.map((p) => ({ name: p?.name ?? 'Part', clefs: Array.isArray(p?.clefs) ? p.clefs : ['treble'] })) : [{ name: 'Piano', clefs: ['treble', 'bass'] }],
    measures: (Array.isArray(r.measures) ? r.measures : []).map((m, i) => ({
      number: Number(m?.number) || i + 1,
      staves: Array.isArray(m?.staves) ? m.staves.map((st) => (Array.isArray(st) ? st.map(String) : [String(st)])) : [],
      chords: Array.isArray(m?.chords) ? m.chords : [],
      timeSignature: m?.timeSignature ?? '',
      keyFifths: m?.keyFifths ?? '',
      tempo: Number(m?.tempo) || 0,
      pickup: !!m?.pickup,
      repeatStart: !!m?.repeatStart,
      repeatEnd: !!m?.repeatEnd,
      ending: m?.ending ?? '',
      navigation: m?.navigation ?? '',
      markers: Array.isArray(m?.markers) ? m.markers : [],
      text: m?.text ?? '',
    })),
    uncertain: Array.isArray(r.uncertain) ? r.uncertain : [],
  };
}
