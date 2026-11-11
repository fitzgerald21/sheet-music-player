// Calls Claude to transcribe one page image. Works both in Node (server) and in the browser
// (when the user supplies their own API key).
import Anthropic from '@anthropic-ai/sdk';
import { PAGE_SCHEMA, PageTranscription } from './schema';
import { PageContext, SYSTEM_PROMPT, userPrompt } from './prompt';

export const DEFAULT_MODEL = 'claude-opus-5-5';
export type Effort = 'medium' | 'high' | 'xhigh';

export interface TranscribeOptions {
  model?: string;
  effort?: Effort;
  signal?: AbortSignal;
  onProgress?: (p: TranscribeProgress) => void;
}

export interface TranscribeProgress {
  phase: 'sending' | 'thinking' | 'writing' | 'done';
  /** shown instead of the standard wording for the phase */
  label?: string;
  /** number of measures written so far */
  measures: number;
  chars: number;
}

export interface PageImage {
  /** base64 without data: prefix */
  data: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
}

export class TranscriptionError extends Error {
  constructor(
    message: string,
    public readonly kind: 'refusal' | 'truncated' | 'invalid' | 'api' | 'auth' | 'rate_limit' | 'aborted',
  ) {
    super(message);
  }
}

export async function transcribePage(client: Anthropic, image: PageImage, ctx: PageContext, opts: TranscribeOptions = {}): Promise<PageTranscription> {
  const progress = (p: TranscribeProgress) => opts.onProgress?.(p);
  progress({ phase: 'sending', measures: 0, chars: 0 });
  let text = '';
  let measures = 0;
  try {
    const stream = client.beta.messages.stream(
      {
        model: opts.model ?? DEFAULT_MODEL,
        max_tokens: 64000,
        // Server-side fallback: if a safety classifier declines (false positives happen), retry on the recommended model.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        output_config: {
          effort: opts.effort ?? 'high',
          format: { type: 'json_schema', schema: PAGE_SCHEMA as unknown as Record<string, unknown> },
        },
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } },
              { type: 'text', text: userPrompt(ctx) },
            ],
          },
        ],
      },
      { signal: opts.signal },
    );
    stream.on('streamEvent', (ev) => {
      if (ev.type === 'content_block_start' && ev.content_block.type === 'thinking') progress({ phase: 'thinking', measures, chars: text.length });
    });
    stream.on('text', (delta) => {
      text += delta;
      const n = (text.match(/"number"\s*:/g) ?? []).length;
      if (n !== measures || text.length - delta.length === 0) {
        measures = n;
      }
      progress({ phase: 'writing', measures, chars: text.length });
    });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') {
      throw new TranscriptionError('The model declined to transcribe this page. Try retaking the photo.', 'refusal');
    }
    if (msg.stop_reason === 'max_tokens') {
      throw new TranscriptionError('This page was too long to transcribe in one go. Try photographing it in two halves.', 'truncated');
    }
    const finalText = msg.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    let parsed: PageTranscription;
    try {
      parsed = JSON.parse(finalText) as PageTranscription;
    } catch {
      throw new TranscriptionError('The transcription came back malformed. Please try again.', 'invalid');
    }
    progress({ phase: 'done', measures: parsed.measures?.length ?? measures, chars: finalText.length });
    return parsed;
  } catch (err) {
    if (err instanceof TranscriptionError) throw err;
    if (err instanceof Anthropic.APIUserAbortError) throw new TranscriptionError('Cancelled', 'aborted');
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError)
      throw new TranscriptionError('The Claude API key was rejected. Check it in Settings.', 'auth');
    if (err instanceof Anthropic.RateLimitError) throw new TranscriptionError('Rate limited by the Claude API – wait a minute and retry.', 'rate_limit');
    if (err instanceof Anthropic.APIError) throw new TranscriptionError(`Claude API error ${err.status ?? ''}: ${err.message}`, 'api');
    throw new TranscriptionError(err instanceof Error ? err.message : String(err), 'api');
  }
}

export interface PagesProgress {
  page: number;
  progress: TranscribeProgress;
}

export type PageFn = (image: PageImage, ctx: PageContext, onProgress: (p: TranscribeProgress) => void) => Promise<PageTranscription>;

/**
 * Transcribe several pages with any page reader. The first page is done first so later pages can
 * reuse its part layout; the rest run in parallel.
 */
export async function transcribePagesWith(
  pageFn: PageFn,
  images: PageImage[],
  onProgress?: (p: PagesProgress) => void,
): Promise<PageTranscription[]> {
  const first = await pageFn(images[0], { pageIndex: 0, pageCount: images.length }, (p) => onProgress?.({ page: 0, progress: p }));
  const results = [first];
  if (images.length > 1) {
    const lastMeasure = first.measures[first.measures.length - 1];
    const rest = await Promise.all(
      images.slice(1).map((img, k) =>
        pageFn(
          img,
          {
            pageIndex: k + 1,
            pageCount: images.length,
            parts: first.parts,
            keyFifths: first.keyFifths,
            timeSignature: first.timeSignature,
            firstMeasureNumber: k === 0 && lastMeasure ? lastMeasure.number + 1 : undefined,
          },
          (p) => onProgress?.({ page: k + 1, progress: p }),
        ),
      ),
    );
    results.push(...rest);
  }
  return results;
}

/** Transcribe several pages with Claude. */
export async function transcribePages(
  client: Anthropic,
  images: PageImage[],
  opts: Omit<TranscribeOptions, 'onProgress'> & { onProgress?: (p: PagesProgress) => void } = {},
): Promise<PageTranscription[]> {
  return transcribePagesWith((img, ctx, onProgress) => transcribePage(client, img, ctx, { ...opts, onProgress }), images, opts.onProgress);
}
