// Editing a score by asking for a change in words. The score is given to an AI model as text,
// together with the request and anything the user pointed at; the model answers with the measures
// it rewrote, and those are checked and put back into the score.
import { CompatConfig, extractJson } from '../omr/openaiCompat';
import { DEFAULT_EXTRAS_MODEL } from '../omr/annotate';
import type { Settings } from '../storage';
import { emptyMeasureLike } from '../model/edit';
import { fitMeasure, fullRest, measureLengths, timeAt } from '../model/fix';
import { keyName } from '../model/pitch';
import { eventToToken, parseVoice, voiceToString } from '../model/tokens';
import { transposeScore } from '../model/transpose';
import { ChordSymbol, Measure, NoteEvent, Score, cloneScore, globalStaves } from '../model/types';
import { pitchToString } from '../model/pitch';

/** Something the user pointed at to say what the request is about. */
export type Mark = { kind: 'measure'; m: number } | { kind: 'note'; eventId: string; pitchIdx: number | null };

export const sameMark = (a: Mark, b: Mark) =>
  a.kind === 'measure' ? b.kind === 'measure' && a.m === b.m : b.kind === 'note' && a.eventId === b.eventId && a.pitchIdx === b.pitchIdx;

export interface AssistantMeasure {
  m: number;
  staves?: string[][];
  chords?: { beat: number; symbol: string }[];
  time?: string;
  key?: number;
  tempo?: number;
}

export interface AssistantAnswer {
  reply: string;
  measures: AssistantMeasure[];
  insert: { after: number; staves?: string[][]; chords?: { beat: number; symbol: string }[] }[];
  delete: number[];
  score: { title?: string; composer?: string; lyricist?: string; tempo?: number };
  transpose: number;
}

export interface ApplyResult {
  score: Score;
  /** indices (in the new score) of measures that were changed or added */
  changed: number[];
  /** things in the answer that could not be used, in plain words */
  problems: string[];
  /** true when nothing in the score was altered */
  unchanged: boolean;
}

export interface Turn {
  ask: string;
  reply: string;
}

export type AssistantMode = 'edit' | 'chords';

/** The AI service used for editing by request, if a key is set up. */
export function assistantConfig(settings: Settings): CompatConfig | null {
  if (!settings.compatKey.trim() || !settings.compatBaseUrl.trim()) return null;
  const model = settings.compatModel.trim() || (/openrouter\.ai/.test(settings.compatBaseUrl) ? DEFAULT_EXTRAS_MODEL : '');
  return model ? { baseUrl: settings.compatBaseUrl, apiKey: settings.compatKey.trim(), model } : null;
}

/** Longest score that is sent whole; above this only the measures around the request are sent. */
const WHOLE_SCORE_LIMIT = 140;

const NOTATION = `Notation for one voice of one measure – tokens separated by spaces:
- a note is pitch/duration: C4 is middle C, accidentals are # ## b bb written right after the letter (F#4, Bb3). The accidental is always written, also when the key signature already implies it: in F major the note B flat is "Bb4", and "B4" means B natural.
- durations: w whole, h half, q quarter, 8 eighth, 16 sixteenth, 32, 64; add "." per dot (q. = dotted quarter) and "t" for a triplet note (8t).
- a chord joins pitches with "+": C4+E4+G4/h
- a rest is r/duration (r/q); R alone is a rest for the whole measure.
- a tie to the same pitch in the next note is "~". After the duration it ties every note of the chord (C4+E4+G4/h~). After a single pitch it ties only that pitch (C4~+E4~+G4/h ties C and E but not G).
- "(" after a note starts a slur, ")" ends one.
- @stacc @acc @ten @marc @ferm add an articulation, @pp @p @mp @mf @f @ff a dynamic: C4/q@stacc@mf
- a lyric syllable goes in quotes right after the note: C4/q"Hal-" (end with "-" when the word continues).
- g: in front makes a grace note: g:D5/8
Every voice must add up to exactly the length of its measure.`;

const systemPrompt = (mode: AssistantMode) => `You are the editing assistant inside a sheet-music app. The user's score is given to you as text. ${
  mode === 'chords'
    ? 'Your job now is to write the chord symbols for it, the way an experienced musician would pencil them above the staff.'
    : 'The user asks for a change in everyday words; you work out exactly what to change and return the changed measures.'
}

${NOTATION}

How the score is listed: one block per measure, "m12" is measure 12 as numbered in the app (the first measure is m1, also when it is a pickup). Each staff line is "S1 treble:", "S2 bass:" and so on, counted from the top of the system; when a staff has more than one voice they are separated by " | ". "chords:" lists the chord symbols as symbol@beat, where beat is 1-based in units of the time signature's lower number (in 4/4 beat 3 is the third quarter, 2.5 the "and" of 2; in 12/8 beat 7 is the seventh eighth note, the start of the third dotted-quarter pulse).

Reply with one JSON object and nothing else:
{"reply":"","measures":[{"m":3,"staves":[["C4+E4+G4/h~ C4+E4+G4/h"],["C3/w"]],"chords":[{"beat":1,"symbol":"C"}]}],"insert":[],"delete":[],"score":{},"transpose":0}

- reply: one or two short sentences for the user saying what you changed, in plain words. If the request is unclear or could mean more than one note, change nothing and ask a short question here instead.
- measures: only the measures you changed. "staves" is the complete new content of that measure – every staff from top to bottom, each a list of voices – so copy the parts you are not changing exactly as given. Leave "staves" out when only the chords or other properties change. "chords" replaces all chord symbols of the measure ([] removes them); leave it out to keep them. Optional "time" ("3/4"), "key" (number of sharps, negative for flats) and "tempo" (quarter notes per minute) start a change at that measure.
- insert: new measures, each {"after": n, "staves": [...]} placed after measure n (0 = before the first). delete: measure numbers to remove. Measure numbers always refer to the score as given to you.
- score: any of "title", "composer", "lyricist", "tempo" to change them; {} otherwise.
- transpose: semitones to move the whole piece (+2 = up a whole step); 0 otherwise. Use this instead of rewriting notes when the user asks for another key.

Rules:
- Change only what was asked. Do not tidy, re-spell or "correct" anything else.
- When the user highlighted something, the request is about that unless their words say otherwise. A highlighted note is identified by its measure, staff, voice and position.
- "The C at the beginning of measure 25 in the treble clef" means the first C in the top staff of m25. If there are several equally likely candidates and nothing is highlighted, ask.
- Write chord symbols with "b" and "#": Bb, F#m7, Eb/F, Edim, F7sus4, Cmaj7, Gm/C.
${
  mode === 'chords'
    ? `- For this task return only "chords" for the measures (no "staves"), for every measure that has notes. Read the harmony from the bass and the notes that fall on the beats; treat passing and neighbour notes as decoration. Prefer the name a player expects in this key (Eb/F rather than F7sus4 when the bass moves under a held chord; F2 or Fadd9 rather than Am7 over an F bass). Put a symbol where the harmony changes, usually one to three per measure; do not repeat a chord that has not changed. Name each chord from the notes that are actually there: do not write a seventh, a diminished or an altered chord unless its defining notes sound, and prefer the plain triad when a note is only passing through.`
    : '- You cannot hear or see the printed page; work only from the text of the score.'
}`;

// ---------------------------------------------------------------- describing the score

function staffNames(score: Score): string[] {
  return globalStaves(score).map((s, i) => `S${i + 1} ${s.clef}`);
}

function measureBlock(score: Score, mi: number, names: string[], withChords = true): string {
  const m = score.measures[mi];
  const head = [`m${mi + 1}`];
  if (m.pickup) head.push('(pickup)');
  if (m.time) head.push(`time ${m.time.join('/')}`);
  if (m.key !== undefined) head.push(`key ${m.key}`);
  if (m.tempo) head.push(`tempo ${m.tempo}`);
  if (m.repeatStart) head.push('repeat-start');
  if (m.repeatEnd) head.push('repeat-end');
  if (m.ending?.length) head.push(`ending ${m.ending.join(',')}`);
  const lines = [head.join(' ')];
  if (withChords && m.chords?.length) lines.push(`  chords: ${m.chords.map((c) => `${c.text}@${+c.beat.toFixed(3)}`).join(' ')}`);
  m.staves.forEach((st, si) => lines.push(`  ${names[si] ?? `S${si + 1}`}: ${st.voices.map(voiceToString).join(' | ')}`));
  return lines.join('\n');
}

/** Measure numbers (1-based) written in the request: "measure 25", "bars 3-5", "m. 12". */
export function mentionedMeasures(text: string, count: number): number[] {
  const out = new Set<number>();
  const re = /\b(?:measures?|bars?|mm?\.?)\s*(\d+)(?:\s*(?:-|–|to|through|and)\s*(\d+))?/gi;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const a = +m[1];
    const b = m[2] ? +m[2] : a;
    for (let k = Math.min(a, b); k <= Math.max(a, b) && k <= count; k++) if (k >= 1) out.add(k);
  }
  return [...out];
}

/** Which measures (0-based) are sent to the model. */
export function measuresToSend(score: Score, text: string, marks: Mark[]): number[] {
  const n = score.measures.length;
  const all = Array.from({ length: n }, (_, i) => i);
  if (n <= WHOLE_SCORE_LIMIT) return all;
  const want = new Set<number>();
  const add = (i: number) => {
    for (let k = i - 2; k <= i + 2; k++) if (k >= 0 && k < n) want.add(k);
  };
  mentionedMeasures(text, n).forEach((k) => add(k - 1));
  for (const mk of marks) {
    if (mk.kind === 'measure') add(mk.m);
    else {
      const at = locate(score, mk.eventId);
      if (at) add(at.m);
    }
  }
  return want.size ? [...want].sort((a, b) => a - b) : all.slice(0, WHOLE_SCORE_LIMIT);
}

function locate(score: Score, id: string): { m: number; s: number; v: number; i: number; e: NoteEvent } | null {
  for (let m = 0; m < score.measures.length; m++) {
    const staves = score.measures[m].staves;
    for (let s = 0; s < staves.length; s++)
      for (let v = 0; v < staves[s].voices.length; v++) {
        const i = staves[s].voices[v].findIndex((e) => e.id === id);
        if (i >= 0) return { m, s, v, i, e: staves[s].voices[v][i] };
      }
  }
  return null;
}

const ordinal = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;

/** A highlighted thing in words, for the model and for the chip shown to the user. */
export function describeMark(score: Score, mark: Mark, names = staffNames(score)): { forModel: string; label: string } | null {
  if (mark.kind === 'measure') {
    if (!score.measures[mark.m]) return null;
    return { forModel: `the whole of measure m${mark.m + 1}`, label: `Measure ${mark.m + 1}` };
  }
  const at = locate(score, mark.eventId);
  if (!at) return null;
  const token = eventToToken({ ...at.e, lyric: undefined });
  const voices = score.measures[at.m].staves[at.s].voices.length;
  const where = `m${at.m + 1}, ${names[at.s] ?? `S${at.s + 1}`}${voices > 1 ? `, voice ${at.v + 1}` : ''}, ${ordinal(at.i + 1)} token "${token}"`;
  // noteheads are counted from the lowest pitch, like the tap target in the score
  const sorted = [...at.e.pitches].sort((a, b) => a.octave * 7 + 'CDEFGAB'.indexOf(a.step) - (b.octave * 7 + 'CDEFGAB'.indexOf(b.step)));
  const one = mark.pitchIdx !== null && at.e.pitches.length > 1 ? sorted[mark.pitchIdx] : null;
  if (at.e.rest) return { forModel: `the rest at ${where}`, label: `Rest, m. ${at.m + 1}` };
  if (one) return { forModel: `the note ${pitchToString(one)} inside the chord at ${where}`, label: `${pretty(pitchToString(one))} in chord, m. ${at.m + 1}` };
  const name = at.e.pitches.map((p) => pretty(pitchToString(p))).join('+');
  return { forModel: `the ${at.e.pitches.length > 1 ? 'chord' : 'note'} at ${where}`, label: `${name}, m. ${at.m + 1}` };
}

const pretty = (s: string) => s.replace(/#/g, '♯').replace(/([A-G])b/g, '$1♭');

export function describeScore(score: Score, measures: number[], withChords = true): string {
  const names = staffNames(score);
  const lines = [
    `Title: ${score.title || '(none)'}${score.composer ? ` · Composer: ${score.composer}` : ''}`,
    `Key signature: ${score.key} (${score.key === 0 ? 'no sharps or flats' : `${Math.abs(score.key)} ${score.key > 0 ? 'sharp' : 'flat'}${Math.abs(score.key) > 1 ? 's' : ''}`}, ${keyName(score.key)}) · Time: ${score.time.join('/')} · Tempo: ${score.tempo}`,
    `Staves: ${names.join(', ')} · ${score.measures.length} measures`,
  ];
  if (measures.length < score.measures.length) lines.push(`Only part of the score is listed (${measures.length} of ${score.measures.length} measures).`);
  lines.push('');
  for (const mi of measures) lines.push(measureBlock(score, mi, names, withChords));
  return lines.join('\n');
}

export function buildRequest(score: Score, text: string, marks: Mark[], mode: AssistantMode): string {
  const names = staffNames(score);
  // when writing chords from scratch the model must not see the ones already there, or it repeats them
  const parts = [describeScore(score, measuresToSend(score, text, marks), mode !== 'chords'), ''];
  const said = marks.map((mk) => describeMark(score, mk, names)?.forModel).filter(Boolean);
  if (said.length) parts.push(`The user highlighted: ${said.join('; ')}.`, '');
  parts.push(`Request: ${text.trim()}`);
  return parts.join('\n');
}

// ---------------------------------------------------------------- asking

export class AssistantError extends Error {}

/* eslint-disable @typescript-eslint/no-explicit-any */
function normalise(raw: unknown): AssistantAnswer {
  const r = (raw ?? {}) as Record<string, any>;
  const voices = (st: unknown): string[][] | undefined =>
    Array.isArray(st) ? st.map((s) => (Array.isArray(s) ? s.map(String) : [String(s ?? '')])) : undefined;
  const chords = (c: unknown) =>
    Array.isArray(c) ? c.map((x: any) => ({ beat: Number(x?.beat) || 1, symbol: String(x?.symbol ?? x?.text ?? '').trim() })).filter((x: { symbol: string }) => x.symbol) : undefined;
  const sc = (r.score ?? {}) as Record<string, any>;
  return {
    reply: String(r.reply ?? '').trim(),
    measures: (Array.isArray(r.measures) ? r.measures : [])
      .map((m: any) => ({
        m: Number(m?.m),
        staves: voices(m?.staves),
        chords: chords(m?.chords),
        time: typeof m?.time === 'string' && /^\d+\/\d+$/.test(m.time) ? m.time : undefined,
        key: Number.isInteger(m?.key) ? Number(m.key) : undefined,
        tempo: Number(m?.tempo) > 0 ? Number(m.tempo) : undefined,
      }))
      .filter((m: AssistantMeasure) => Number.isInteger(m.m)),
    insert: (Array.isArray(r.insert) ? r.insert : []).map((m: any) => ({ after: Number(m?.after), staves: voices(m?.staves), chords: chords(m?.chords) })).filter((m: { after: number }) => Number.isInteger(m.after)),
    delete: (Array.isArray(r.delete) ? r.delete : []).map(Number).filter(Number.isInteger),
    score: {
      title: typeof sc.title === 'string' ? sc.title : undefined,
      composer: typeof sc.composer === 'string' ? sc.composer : undefined,
      lyricist: typeof sc.lyricist === 'string' ? sc.lyricist : undefined,
      tempo: Number(sc.tempo) > 0 ? Number(sc.tempo) : undefined,
    },
    transpose: Number.isInteger(r.transpose) ? Number(r.transpose) : 0,
  };
}

export async function askAssistant(cfg: CompatConfig, score: Score, text: string, marks: Mark[], opts: { mode?: AssistantMode; history?: Turn[]; signal?: AbortSignal } = {}): Promise<AssistantAnswer> {
  const mode = opts.mode ?? 'edit';
  if (!cfg.baseUrl || !cfg.model || !cfg.apiKey) throw new AssistantError('Add an AI key in Settings first.');
  const messages = [
    { role: 'system', content: systemPrompt(mode) },
    ...(opts.history ?? []).slice(-4).flatMap((t) => [
      { role: 'user', content: `Earlier request: ${t.ask}` },
      { role: 'assistant', content: JSON.stringify({ reply: t.reply }) },
    ]),
    { role: 'user', content: buildRequest(score, text, marks, mode) },
  ];
  const call = (format: unknown) =>
    fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}`, 'X-Title': 'Sheet Music Player' },
      body: JSON.stringify({ model: cfg.model, max_tokens: 16000, temperature: 0, messages, ...(format ? { response_format: format } : {}) }),
      signal: opts.signal,
    });
  let res: Response;
  try {
    res = await call({ type: 'json_object' });
    if (res.status === 400 || res.status === 422) res = await call(null);
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    throw new AssistantError('Could not reach the AI service. Check your connection.');
  }
  if (res.status === 401 || res.status === 403) throw new AssistantError('The AI key was rejected. Check it in Settings.');
  if (res.status === 402) throw new AssistantError('The AI service says the account has no credit left.');
  if (res.status === 429) throw new AssistantError('The AI service is busy – wait a minute and try again.');
  if (!res.ok) throw new AssistantError(`AI service error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  if (data?.error?.message) throw new AssistantError(`AI service error: ${String(data.error.message).slice(0, 200)}`);
  if (data?.choices?.[0]?.finish_reason === 'length') throw new AssistantError('The answer was cut off. Ask for a smaller change, or highlight the measures it is about.');
  const content: string = data?.choices?.[0]?.message?.content ?? '';
  try {
    return normalise(extractJson(content));
  } catch {
    // a model that answers in plain words is asking something or explaining
    if (content.trim() && !/[{}]/.test(content)) return normalise({ reply: content.trim().slice(0, 600) });
    throw new AssistantError('The AI model did not return a usable answer. Try again, or pick another model in Settings.');
  }
}

// ---------------------------------------------------------------- applying

function parseStaves(staves: string[][], staffCount: number, old: Measure | null, label: string, problems: string[]): Measure['staves'] | null {
  if (staves.length !== staffCount) {
    problems.push(`${label}: the answer had ${staves.length} staves instead of ${staffCount}, so it was left as it was.`);
    return null;
  }
  const out: Measure['staves'] = [];
  for (let s = 0; s < staves.length; s++) {
    const voices: NoteEvent[][] = [];
    for (let v = 0; v < staves[s].length; v++) {
      const text = staves[s][v].trim();
      if (!text) continue;
      const { events, errors } = parseVoice(text);
      if (errors.length) {
        problems.push(`${label}: could not read the answer (${errors[0]}), so it was left as it was.`);
        return null;
      }
      // notes that were not touched keep their identity, so selection and playback highlights carry over
      const before = old?.staves[s]?.voices[v] ?? [];
      events.forEach((e, i) => {
        if (before[i] && eventToToken(before[i]) === eventToToken(e)) e.id = before[i].id;
      });
      voices.push(events);
    }
    out.push({ voices: voices.length ? voices : [[fullRest()]] });
  }
  return out;
}

const toChords = (list: { beat: number; symbol: string }[], beats: number): ChordSymbol[] | undefined => {
  const seen = new Set<number>();
  const out = list
    .map((c) => ({ beat: Math.min(Math.max(1, Math.round(c.beat * 4) / 4), beats + 0.75), text: c.symbol.replace(/♭/g, 'b').replace(/♯/g, '#') }))
    .filter((c) => (seen.has(c.beat) ? false : (seen.add(c.beat), true)))
    .sort((a, b) => a.beat - b.beat);
  return out.length ? out : undefined;
};

const signature = (m: Measure) => JSON.stringify([m.staves.map((s) => s.voices.map(voiceToString)), m.chords ?? [], m.time ?? null, m.key ?? null, m.tempo ?? null]);

/** Puts a model's answer into the score. Anything that cannot be used is skipped and reported. */
export function applyAnswer(src: Score, answer: AssistantAnswer, mode: AssistantMode = 'edit'): ApplyResult {
  let score = cloneScore(src);
  const problems: string[] = [];
  const staffCount = globalStaves(score).length;
  const touched = new Set<Measure>();
  const before = new Map(score.measures.map((m) => [m, signature(m)]));
  const count = score.measures.length;

  for (const am of answer.measures) {
    const m = score.measures[am.m - 1];
    const label = `Measure ${am.m}`;
    if (!m) {
      problems.push(`${label} does not exist.`);
      continue;
    }
    if (am.staves && mode === 'edit') {
      const staves = parseStaves(am.staves, staffCount, m, label, problems);
      if (!staves) continue;
      m.staves = staves;
    }
    if (mode === 'edit') {
      if (am.time) {
        const [a, b] = am.time.split('/').map(Number);
        if (a > 0 && [1, 2, 4, 8, 16].includes(b)) m.time = [a, b];
      }
      if (am.key !== undefined && am.key >= -7 && am.key <= 7) m.key = am.key;
      if (am.tempo) m.tempo = Math.min(300, Math.max(20, Math.round(am.tempo)));
    }
    touched.add(m);
  }
  // chords need the time signature in force, which the loop above may have changed
  const times = timeAt(score);
  for (const am of answer.measures) {
    const m = score.measures[am.m - 1];
    if (m && am.chords && touched.has(m)) m.chords = toChords(am.chords, times[am.m - 1][0]);
  }

  const added: Measure[] = [];
  if (mode === 'edit') {
    const originals = [...score.measures];
    for (const ins of [...answer.insert].sort((a, b) => b.after - a.after)) {
      if (ins.after < 0 || ins.after > count) {
        problems.push(`A new measure after measure ${ins.after} could not be placed.`);
        continue;
      }
      const fresh = emptyMeasureLike(score, undefined);
      if (ins.staves) {
        const staves = parseStaves(ins.staves, staffCount, null, `The new measure after ${ins.after}`, problems);
        if (!staves) continue;
        fresh.staves = staves;
      }
      if (ins.chords) fresh.chords = toChords(ins.chords, 16);
      const anchor = ins.after === 0 ? 0 : score.measures.indexOf(originals[ins.after - 1]) + 1;
      score.measures.splice(anchor, 0, fresh);
      added.push(fresh);
    }
    const doomed = new Set(answer.delete.map((n) => originals[n - 1]).filter(Boolean));
    if (doomed.size && doomed.size < score.measures.length) {
      // a key or time change that started in a removed measure moves to the next one that stays
      score.measures.forEach((m, i) => {
        if (!doomed.has(m)) return;
        const next = score.measures.slice(i + 1).find((x) => !doomed.has(x));
        if (!next) return;
        if (m.time && !next.time) next.time = m.time;
        if (m.key !== undefined && next.key === undefined) next.key = m.key;
        if (m.tempo && !next.tempo) next.tempo = m.tempo;
      });
      score.measures = score.measures.filter((m) => !doomed.has(m));
    } else if (doomed.size) problems.push('Deleting every measure is not possible.');

    const s = answer.score;
    if (s.title !== undefined && s.title.trim()) score.title = s.title.trim();
    if (s.composer !== undefined) score.composer = s.composer.trim() || undefined;
    if (s.lyricist !== undefined) score.lyricist = s.lyricist.trim() || undefined;
    if (s.tempo) score.tempo = Math.min(300, Math.max(20, Math.round(s.tempo)));
  }

  // every changed measure must still add up
  const lens = measureLengths(score);
  score.measures.forEach((m, i) => {
    if (!touched.has(m) && !added.includes(m)) return;
    const was = m.staves.map((s) => s.voices.map(voiceToString).join('|')).join('/');
    fitMeasure(m, lens[i], staffCount);
    const now = m.staves.map((s) => s.voices.map(voiceToString).join('|')).join('/');
    if (was !== now && m.staves.some((s) => s.voices.some((v) => v.some((e) => !e.fullMeasure))))
      problems.push(`Measure ${i + 1} did not add up to a full measure, so it was padded or trimmed – check it.`);
  });

  const changedMeasures = score.measures.filter((m) => added.includes(m) || (touched.has(m) && before.get(m) !== signature(m)));
  let transposed = false;
  if (mode === 'edit' && answer.transpose && Math.abs(answer.transpose) <= 24) {
    const keep = changedMeasures.map((m) => score.measures.indexOf(m));
    score = transposeScore(score, answer.transpose);
    transposed = true;
    changedMeasures.length = 0;
    keep.forEach((i) => changedMeasures.push(score.measures[i]));
  }
  const changed = changedMeasures.map((m) => score.measures.indexOf(m)).sort((a, b) => a - b);
  const meta = score.title !== src.title || score.composer !== src.composer || score.lyricist !== src.lyricist || score.tempo !== src.tempo;
  const unchanged = !changed.length && !transposed && !meta && score.measures.length === src.measures.length;
  return { score: unchanged ? src : score, changed, problems, unchanged };
}
