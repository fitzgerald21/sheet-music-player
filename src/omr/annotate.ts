// After the notes of a page have been read on the device, an AI model can add what that reader
// does not see: the title, the tempo, the chord symbols and the lyrics. The model is shown the
// photo together with the melody already found, so its only job is to read text and say where it goes.
import { CompatConfig, extractJson } from './openaiCompat';
import { PageImage, TranscriptionError } from './transcribe';
import { NoteEvent, Score } from '../model/types';
import { pitchToString } from '../model/pitch';

export interface PageExtras {
  title: string;
  subtitle?: string;
  composer: string;
  lyricist: string;
  tempo: number;
  measures: { m: number; chords: { beat: number; symbol: string }[]; lyrics: string[]; text?: string }[];
}

/** Which things the model is asked to read. */
export interface ExtrasWanted {
  info: boolean;
  chords: boolean;
  lyrics: boolean;
}
export const ALL_EXTRAS: ExtrasWanted = { info: true, chords: true, lyrics: true };

export interface ExtrasSummary {
  chords: number;
  lyrics: number;
  /** measures where the model gave a different number of syllables than there are sung notes */
  uneven: number[];
}

/** Model used on OpenRouter when none is chosen in Settings. */
export const DEFAULT_EXTRAS_MODEL = 'anthropic/claude-opus-5.5';

/** The notes of the top staff that can carry a syllable, for every measure. */
export function lyricSlots(score: Score): NoteEvent[][] {
  let held = false; // the previous note is tied into this one
  return score.measures.map((m) => {
    const slots: NoteEvent[] = [];
    for (const e of m.staves[0]?.voices[0] ?? []) {
      if (e.grace) continue;
      if (e.rest) {
        held = false;
        continue;
      }
      if (!held) slots.push(e);
      held = e.pitches.some((p) => p.tie);
    }
    return slots;
  });
}

const system = (want: ExtrasWanted) => `You help digitise printed sheet music. The notes of the page in the photo have already been read by a machine. You add what the machine cannot read: the title and credits, the tempo, the chord symbols above the staff and the lyrics under the top staff.

You are given the top staff of every measure the machine found, in reading order (system by system, left to right). Notes are written pitch/duration: w whole, h half, q quarter, 8 eighth, 16 sixteenth, a "." for each dot, "t" for a triplet, r for a rest, R for a whole-measure rest, "~" for a note tied to the next, "+" between the notes of a chord. Use the melody to find each measure in the photo. The machine sometimes misreads a note, so match measures by their overall shape and their position on the page, not note by note.

Reply with one JSON object and nothing else:
{"title":"","subtitle":"","composer":"","lyricist":"","tempo":0,"measures":[{"m":1,"text":"","chords":[{"beat":1,"symbol":"Bb"}],"lyrics":["Sing","a","song"]}]}

- title, composer, lyricist: as printed on this page, "" if not printed. Title in normal capitalisation.
- subtitle: the smaller line printed under the title, such as 'from "The Jungle Book" (1967)'; "" if there is none.
- tempo: the metronome mark in quarter notes per minute, 0 if none is printed. If only a word is printed (Moderately, Allegro, Slowly…), give your best estimate in quarter notes per minute.
- measures: one entry for every measure given to you, with the same number "m".
- text: tempo and style words printed above that measure, exactly as printed ("Swing eighths", "rit.", "a tempo"); "" if none. Not dynamics and not chord symbols.
- chords: the chord symbols printed above that measure, in order. "beat" is where the symbol sits, 1-based, in units of the time signature's lower number (1.5 = the second eighth note in 4/4). In 6/8, 9/8 and 12/8 the unit is the eighth note, so the dotted-quarter pulses fall on beats 1, 4, 7 and 10 – a symbol over the second pulse is beat 4, not beat 2. Write flats as "b" and sharps as "#": "Eb", "Bb7/F", "Edim", "F7sus4", "Gm", "F/A". Ignore guitar chord diagrams and fingering numbers. [] if none.
- lyrics: the first verse only. Give exactly one string for every sung note of the measure – the list tells you how many. A note that starts a tie counts once; the note it is tied to is not counted. Use the syllable printed under that note; end it with "-" when the word continues on a later note ("ev-", "ry"); use "" for a note with no syllable of its own (a syllable held over several notes). [] for every measure if the music has no lyrics.
${[!want.info && '- Do not read the title, subtitle, composer, lyricist, tempo or text: leave them "" and 0.', !want.chords && '- Do not read chord symbols: give [] for "chords" in every measure.', !want.lyrics && '- Do not read lyrics: give [] for "lyrics" in every measure.'].filter(Boolean).map((l) => l + '\n').join('')}- Never invent text that is not printed. If you cannot find a measure in the photo, give it empty chords and lyrics.`;

function describe(score: Score): string {
  const slots = lyricSlots(score);
  const lines = score.measures.map((m, i) => {
    const voice = m.staves[0]?.voices[0] ?? [];
    const notes = voice
      .filter((e) => !e.grace)
      .map((e) => {
        const dur = `${e.dur}${'.'.repeat(e.dots)}${e.triplet ? 't' : ''}`;
        if (e.rest) return e.fullMeasure ? 'R' : `r/${dur}`;
        return `${e.pitches.map(pitchToString).join('+')}/${dur}${e.pitches.some((p) => p.tie) ? '~' : ''}`;
      })
      .join(' ');
    const time = m.time ? ` (time ${m.time[0]}/${m.time[1]})` : '';
    return `${i + 1}${time}: ${notes || 'R'}   [${slots[i].length} sung note${slots[i].length === 1 ? '' : 's'}]`;
  });
  return `Time signature ${score.time[0]}/${score.time[1]}. The machine found ${score.measures.length} measures on this page. Top staff, measure by measure:\n${lines.join('\n')}`;
}

function normalise(raw: unknown): PageExtras {
  const r = (raw ?? {}) as Partial<PageExtras>;
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  return {
    title: text(r.title),
    subtitle: text(r.subtitle),
    composer: text(r.composer),
    lyricist: text(r.lyricist),
    tempo: Number(r.tempo) || 0,
    measures: (Array.isArray(r.measures) ? r.measures : []).map((m, i) => ({
      m: Number(m?.m) || i + 1,
      chords: (Array.isArray(m?.chords) ? m.chords : [])
        .map((c) => ({ beat: Number(c?.beat) || 1, symbol: text(c?.symbol ?? (c as { text?: string })?.text) }))
        .filter((c) => c.symbol),
      lyrics: (Array.isArray(m?.lyrics) ? m.lyrics : []).map(text),
      text: text(m?.text),
    })),
  };
}

/** Asks the model for the title, tempo, chords and lyrics of one page. */
export async function readExtras(cfg: CompatConfig, image: PageImage, score: Score, signal?: AbortSignal, want: ExtrasWanted = ALL_EXTRAS): Promise<PageExtras> {
  if (!cfg.baseUrl || !cfg.model) throw new TranscriptionError('Set the AI model in Settings.', 'auth');
  const body = (format: unknown) => ({
    model: cfg.model,
    max_tokens: 16000,
    temperature: 0,
    messages: [
      { role: 'system', content: system(want) },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.data}` } },
          { type: 'text', text: describe(score) },
        ],
      },
    ],
    ...(format ? { response_format: format } : {}),
  });
  const call = (format: unknown) =>
    fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}`, 'X-Title': 'Sheet Music Player' },
      body: JSON.stringify(body(format)),
      signal,
    });
  let res = await call({ type: 'json_object' });
  if (res.status === 400 || res.status === 422) res = await call(null);
  if (res.status === 401 || res.status === 403) throw new TranscriptionError('The API key was rejected. Check it in Settings.', 'auth');
  if (res.status === 402) throw new TranscriptionError('The AI service says the account has no credit left.', 'api');
  if (res.status === 429) throw new TranscriptionError('The AI service is rate limiting – wait a minute and retry.', 'rate_limit');
  if (!res.ok) throw new TranscriptionError(`AI service error ${res.status}: ${(await res.text()).slice(0, 200)}`, 'api');
  const data = await res.json();
  if (data?.error?.message) throw new TranscriptionError(`AI service error: ${String(data.error.message).slice(0, 200)}`, 'api');
  const content: string = data?.choices?.[0]?.message?.content ?? '';
  try {
    return normalise(extractJson(content));
  } catch {
    throw new TranscriptionError('The AI model did not return a usable answer. Try another model (it must accept images).', 'invalid');
  }
}

/** Writes the model's answer into the score of that page. */
export function applyExtras(score: Score, raw: PageExtras, want: ExtrasWanted = ALL_EXTRAS): ExtrasSummary {
  // what was switched off is dropped even if the model answered it anyway
  const extras: PageExtras = {
    ...raw,
    ...(want.info ? {} : { title: '', subtitle: '', composer: '', lyricist: '', tempo: 0 }),
    measures: raw.measures.map((m) => ({ m: m.m, chords: want.chords ? m.chords : [], lyrics: want.lyrics ? m.lyrics : [], text: want.info ? m.text ?? '' : '' })),
  };
  const summary: ExtrasSummary = { chords: 0, lyrics: 0, uneven: [] };
  if (extras.title) score.title = extras.title;
  if (extras.subtitle) score.subtitle = extras.subtitle;
  if (extras.composer) score.composer = extras.composer;
  if (extras.lyricist) score.lyricist = extras.lyricist;
  if (extras.tempo >= 30 && extras.tempo <= 260) score.tempo = Math.round(extras.tempo);
  const slots = lyricSlots(score);
  let time = score.time;
  const times = score.measures.map((m) => (time = m.time ?? time));
  // In 6/8, 9/8 and 12/8 models often count the dotted-quarter pulses (1 2 3 4) instead of eighth
  // notes (1 4 7 10). If no symbol on the page lies beyond the number of pulses, that is what happened.
  const compound = (t: [number, number]) => t[1] === 8 && t[0] >= 6 && t[0] % 3 === 0;
  const listed = extras.measures.filter((em) => score.measures[em.m - 1] && compound(times[em.m - 1]));
  const inPulses =
    listed.some((em) => em.chords.length > 1) && listed.every((em) => em.chords.every((c) => c.beat < times[em.m - 1][0] / 3 + 1));
  for (const em of extras.measures) {
    const i = em.m - 1;
    const measure = score.measures[i];
    if (!measure) continue;
    if (em.text && em.text.length <= 60) measure.text = em.text;
    const beats = times[i][0];
    const spread = inPulses && compound(times[i]);
    const chords = em.chords
      .map((c) => (spread ? { ...c, beat: (c.beat - 1) * 3 + 1 } : c))
      .map((c) => ({ beat: Math.min(Math.max(1, Math.round(c.beat * 4) / 4), Math.max(1, beats + 0.75)), text: c.symbol.replace(/♭/g, 'b').replace(/♯/g, '#') }))
      .sort((a, b) => a.beat - b.beat);
    if (chords.length) {
      measure.chords = chords;
      summary.chords += chords.length;
    }
    const words = em.lyrics;
    if (words.some(Boolean)) {
      if (words.length !== slots[i].length) summary.uneven.push(i);
      slots[i].forEach((e, k) => {
        if (words[k]) {
          e.lyric = words[k];
          summary.lyrics++;
        }
      });
    }
  }
  return summary;
}
