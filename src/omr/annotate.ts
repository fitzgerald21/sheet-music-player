// After the notes of a page have been read on the device, an AI model can add what that reader
// does not see: the title, the tempo, the chord symbols and the lyrics. The model is shown the
// photo together with the melody already found, so its only job is to read text and say where it goes.
import { CompatConfig, extractJson } from './openaiCompat';
import { PageImage, TranscriptionError } from './transcribe';
import { Hairpin, NoteEvent, Ottava, Score } from '../model/types';
import { pitchToString } from '../model/pitch';

export interface PageExtras {
  title: string;
  subtitle?: string;
  composer: string;
  lyricist: string;
  tempo: number;
  measures: { m: number; chords: { beat: number; symbol: string }[]; lyrics: string[]; text?: string }[];
  /** hairpins and octave lines: from note n1 of measure m1 to note n2 of measure m2, on one staff (1 = top) */
  lines?: { type: string; staff: number; m1: number; n1: number; m2: number; n2: number }[];
  tremolos?: { m: number; staff: number; note: number; slashes: number }[];
}

/** Which things the model is asked to read. */
export interface ExtrasWanted {
  info: boolean;
  chords: boolean;
  lyrics: boolean;
  /** hairpins, octave lines and tremolo slashes */
  marks?: boolean;
}
export const ALL_EXTRAS: ExtrasWanted = { info: true, chords: true, lyrics: true, marks: true };

export interface ExtrasSummary {
  chords: number;
  lyrics: number;
  /** hairpins, octave lines and tremolos written into the score */
  marks?: number;
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

const system = (want: ExtrasWanted, pieces = 0) => `You help digitise printed sheet music. The notes of the page in the photo have already been read by a machine. You add what the machine cannot read: the title and credits, the tempo, the chord symbols above the staff and the lyrics under the top staff${want.marks ? ', and the hairpins, octave lines and tremolo slashes' : ''}.

You are given the top staff of every measure the machine found, in reading order (system by system, left to right). Notes are written pitch/duration: w whole, h half, q quarter, 8 eighth, 16 sixteenth, a "." for each dot, "t" for a triplet, r for a rest, R for a whole-measure rest, "~" for a note tied to the next, "+" between the notes of a chord. Use the melody to find each measure in the photo. The machine sometimes misreads a note, so match measures by their overall shape and their position on the page, not note by note.${want.marks ? MARKS_LISTING : ''}${pieces ? `\n\nAfter the photo of the whole page you get ${pieces} enlarged pieces of the same photo: the left and right half of its top, middle and bottom third, in that order, overlapping a little. Use the whole page to find your way, and the pieces to look closely at small things – slashes on stems, which end of a hairpin is the point, where a dashed line ends.` : ''}

Reply with one JSON object and nothing else:
{"title":"","subtitle":"","composer":"","lyricist":"","tempo":0,"measures":[{"m":1,"text":"","chords":[{"beat":1,"symbol":"Bb"}],"lyrics":["Sing","a","song"]}]${want.marks ? ',"lines":[{"type":"cresc","staff":1,"m1":3,"n1":1,"m2":4,"n2":2}],"tremolos":[{"m":2,"staff":1,"note":4,"slashes":3}]' : ''}}

- title, composer, lyricist: as printed on this page, "" if not printed. Title in normal capitalisation.
- subtitle: the smaller line printed under the title, such as 'from "The Jungle Book" (1967)'; "" if there is none.
- tempo: the metronome mark in quarter notes per minute, 0 if none is printed. If only a word is printed (Moderately, Allegro, Slowly…), give your best estimate in quarter notes per minute.
- measures: one entry for every measure given to you, with the same number "m".
- text: tempo and style words printed above that measure, exactly as printed ("Swing eighths", "rit.", "a tempo"); "" if none. Not dynamics and not chord symbols.
- chords: the chord symbols printed above that measure, in order. "beat" is where the symbol sits, 1-based, in units of the time signature's lower number (1.5 = the second eighth note in 4/4). In 6/8, 9/8 and 12/8 the unit is the eighth note, so the dotted-quarter pulses fall on beats 1, 4, 7 and 10 – a symbol over the second pulse is beat 4, not beat 2. Write flats as "b" and sharps as "#": "Eb", "Bb7/F", "Edim", "F7sus4", "Gm", "F/A". Ignore guitar chord diagrams and fingering numbers. [] if none.
- lyrics: the first verse only. Give exactly one string for every sung note of the measure – the list tells you how many. A note that starts a tie counts once; the note it is tied to is not counted. Use the syllable printed under that note; end it with "-" when the word continues on a later note ("ev-", "ry"); use "" for a note with no syllable of its own (a syllable held over several notes). [] for every measure if the music has no lyrics.
${[!want.info && '- Do not read the title, subtitle, composer, lyricist, tempo or text: leave them "" and 0.', !want.chords && '- Do not read chord symbols: give [] for "chords" in every measure.', !want.lyrics && '- Do not read lyrics: give [] for "lyrics" in every measure.'].filter(Boolean).map((l) => l + '\n').join('')}${want.marks ? MARKS_RULES : ''}- Never invent text that is not printed. If you cannot find a measure in the photo, give it empty chords and lyrics.`;

const MARKS_LISTING = ` Every staff of a measure is listed, top staff first, and every note or chord has a number in front ("3:" is the third note or chord of that staff in that measure; rests have no number; " | " separates two voices on one staff, and the numbers run on through the second voice). The pitches are listed as printed on the staff.`;

const MARKS_RULES = `- lines: every hairpin and every octave line on the page, one entry for each, however many measures or systems it runs over.
  "type": look at each hairpin to see which end is the point. Its two lines meet in a point on the LEFT and are apart on the right: "cresc". They are apart on the LEFT and meet in a point on the right: "dim". Do not guess the type from the dynamics around it. "8va" for a dashed line above a staff that starts with "8va" or "8", "8vb" for one below a staff, "15ma" / "15mb" for two octaves.
  "staff": 1 for the top staff of the system, 2 for the next one down. A hairpin drawn between the two staves of a piano part belongs to staff 1. An octave line belongs to the staff it is drawn over (8va) or under (8vb).
  "m1", "n1": the measure and the note number where it starts; "m2", "n2": the measure and note number where it ends. A hairpin starts at the note at its left tip and ends at the last note before its right end. An octave line starts at the note under the "8" and ends at the last note before the small hook that closes the dashed line. Look along the whole dashed line: it often carries on at the start of the next system, and ends several measures later.
  If an octave line is already running at the top of the page (a dashed line with no "8va" at its start, continuing from the page before), start it at note 1 of the page's first measure. If it runs off the bottom of the page, end it at the last note of the last measure.
- tremolos: every note or chord with tremolo slashes – two or three short thick slanted strokes across its stem (or above or below a whole note): {"m":2,"staff":1,"note":4,"slashes":3}. Check the stem of each long note (half notes, dotted quarters, whole notes): list it only when you can see the strokes crossing that stem. Most half notes have a bare stem and are not tremolos, and a measure that looks like one with a tremolo may have none. Beams joining several eighth or sixteenth notes are not tremolos.
- [] for "lines" and "tremolos" if the page has none.
`;

/** The notes and chords of one staff of a measure that a mark can sit on, in the order they are listed and numbered. */
function numberedNotes(score: Score, measure: number, staff: number): NoteEvent[] {
  return (score.measures[measure]?.staves[staff]?.voices ?? []).flatMap((v) => v.filter((e) => !e.grace && !e.rest && e.pitches.length));
}

function describe(score: Score, want: ExtrasWanted = ALL_EXTRAS): string {
  const slots = lyricSlots(score);
  const lines = score.measures.map((m, i) => {
    const listing = (voices: NoteEvent[][]) => {
      let n = 0;
      return (
        voices
          .map((voice) =>
            voice
              .filter((e) => !e.grace)
              .map((e) => {
                const dur = `${e.dur}${'.'.repeat(e.dots)}${e.triplet ? 't' : ''}`;
                if (e.rest) return e.fullMeasure ? 'R' : `r/${dur}`;
                return `${want.marks ? `${++n}:` : ''}${e.pitches.map(pitchToString).join('+')}/${dur}${e.pitches.some((p) => p.tie) ? '~' : ''}`;
              })
              .join(' '),
          )
          .filter(Boolean)
          .join(' | ') || 'R'
      );
    };
    const time = m.time ? ` (time ${m.time[0]}/${m.time[1]})` : '';
    const sung = `   [${slots[i].length} sung note${slots[i].length === 1 ? '' : 's'}]`;
    if (!want.marks) return `${i + 1}${time}: ${listing((m.staves[0]?.voices ?? []).slice(0, 1))}${sung}`;
    return [`${i + 1}${time}: ${listing(m.staves[0]?.voices ?? [])}${sung}`, ...m.staves.slice(1).map((st, k) => `    staff ${k + 2}: ${listing(st.voices)}`)].join('\n');
  });
  return `Time signature ${score.time[0]}/${score.time[1]}. The machine found ${score.measures.length} measures on this page. ${want.marks ? 'Every staff' : 'Top staff'}, measure by measure:\n${lines.join('\n')}`;
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
    lines: (Array.isArray(r.lines) ? r.lines : []).map((l) => ({ type: text(l?.type).toLowerCase(), staff: Number(l?.staff) || 1, m1: Number(l?.m1) || 0, n1: Number(l?.n1) || 1, m2: Number(l?.m2) || 0, n2: Number(l?.n2) || 0 })),
    tremolos: (Array.isArray(r.tremolos) ? r.tremolos : []).map((t) => ({ m: Number(t?.m) || 0, staff: Number(t?.staff) || 1, note: Number(t?.note) || 0, slashes: Number(t?.slashes) || 3 })),
  };
}

/** Asks the model for the title, tempo, chords and lyrics of one page. */
export async function readExtras(cfg: CompatConfig, image: PageImage, score: Score, signal?: AbortSignal, want: ExtrasWanted = ALL_EXTRAS, pieces: PageImage[] = []): Promise<PageExtras> {
  if (!cfg.baseUrl || !cfg.model) throw new TranscriptionError('Set the AI model in Settings.', 'auth');
  const body = (format: unknown) => ({
    model: cfg.model,
    max_tokens: 16000,
    temperature: 0,
    messages: [
      { role: 'system', content: system(want, pieces.length) },
      {
        role: 'user',
        content: [
          ...[image, ...pieces].map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mediaType};base64,${im.data}` } })),
          { type: 'text', text: describe(score, want) },
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

const LINE_TYPES: Record<string, { hairpin?: Hairpin; ottava?: Ottava }> = {
  cresc: { hairpin: 'cresc' }, crescendo: { hairpin: 'cresc' }, dim: { hairpin: 'dim' }, decresc: { hairpin: 'dim' }, diminuendo: { hairpin: 'dim' }, decrescendo: { hairpin: 'dim' },
  '8va': { ottava: 8 }, '8vb': { ottava: -8 }, '15ma': { ottava: 15 }, '15mb': { ottava: -15 },
};

/**
 * Puts the hairpins, octave lines and tremolos the model found on the notes it named. The pitches
 * under an octave line are left as the machine read them (as printed); applyOctaveLines moves them
 * once all pages are joined. Returns how many marks were written.
 */
function applyMarks(score: Score, extras: PageExtras): number {
  const staves = score.measures[0]?.staves.length ?? 0;
  const last = score.measures.length - 1;
  /** the n-th note of a staff in a measure; when the measure has fewer, the nearest one, searching on in `dir` through empty measures */
  const find = (m: number, staff: number, n: number, dir: 1 | -1): NoteEvent | undefined => {
    for (let i = Math.min(Math.max(m - 1, 0), last); i >= 0 && i <= last; i += dir) {
      const notes = numberedNotes(score, i, staff);
      if (notes.length) return i === m - 1 ? notes[Math.min(Math.max(n, 1), notes.length) - 1] : dir > 0 ? notes[0] : notes[notes.length - 1];
    }
    return undefined;
  };
  let count = 0;
  for (const l of extras.lines ?? []) {
    const kind = LINE_TYPES[l.type];
    const staff = Math.round(l.staff) - 1;
    if (!kind || staff < 0 || staff >= staves || l.m1 < 1 || l.m1 > last + 1) continue;
    const m2 = Math.min(Math.max(l.m2 || l.m1, l.m1), last + 1);
    const from = find(l.m1, staff, l.n1, 1);
    const to = find(m2, staff, l.n2 > 0 ? l.n2 : 1e9, -1);
    if (!from || !to) continue;
    if (kind.hairpin) {
      from.hairpin = kind.hairpin;
      to.hairpinEnd = true;
    } else {
      from.ottava = kind.ottava;
      to.ottavaEnd = true;
    }
    count++;
  }
  for (const t of extras.tremolos ?? []) {
    const staff = Math.round(t.staff) - 1;
    if (staff < 0 || staff >= staves || t.m < 1 || t.m > last + 1 || t.note < 1) continue;
    const e = numberedNotes(score, t.m - 1, staff)[t.note - 1];
    if (!e) continue;
    e.tremolo = Math.min(3, Math.max(1, Math.round(t.slashes))) as 1 | 2 | 3;
    count++;
  }
  return count;
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
  if (want.marks) summary.marks = applyMarks(score, raw);
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
