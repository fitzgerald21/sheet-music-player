// Compact text notation for one voice of one measure. Used as the transcription format
// (it is far more token-efficient than JSON per note) and for debugging / tests.
//
//   token   := ["g:"] (note | rest)
//   note    := pitch ["~"] ("+" pitch ["~"])* "/" dur suffix*
//   rest    := "r/" dur suffix* | "R"            (R = whole-measure rest)
//   pitch   := letter accidental? octave          C4 = middle C; accidental # ## b bb n
//   dur     := w | h | q | 8 | 16 | 32 | 64, then "." per dot, then optional "t" (triplet)
//   suffix  := "~" tie all | "(" slur start | ")" slur end | "@" word | '"' lyric '"'
//   @words  := stacc acc ten marc ferm | ppp pp p mp mf f ff fff sfz fp

import { parsePitch, pitchToString } from './pitch';
import { Articulation, DurType, Dynamic, DYNAMICS, NoteEvent, Pitch, newId } from './types';

const DUR_ALIASES: Record<string, DurType> = {
  w: 'w', '1': 'w', h: 'h', '2': 'h', q: 'q', '4': 'q', '8': '8', e: '8', '16': '16', s: '16', '32': '32', '64': '64',
};

const ARTIC_WORDS: Record<string, Articulation> = {
  stacc: 'staccato', staccato: 'staccato', st: 'staccato',
  acc: 'accent', accent: 'accent', '>': 'accent',
  ten: 'tenuto', tenuto: 'tenuto',
  marc: 'marcato', marcato: 'marcato',
  ferm: 'fermata', fermata: 'fermata',
};

export function tokenize(voice: string): string[] {
  return voice.match(/(?:"[^"]*"|[^\s"])+/g) ?? [];
}

export interface ParseResult {
  events: NoteEvent[];
  errors: string[];
}

export function parseToken(tokRaw: string): NoteEvent | string {
  let tok = tokRaw.trim();
  const ev: NoteEvent = { id: newId(), pitches: [], dur: 'q', dots: 0 };
  if (tok.startsWith('g:')) {
    ev.grace = true;
    tok = tok.slice(2);
  }
  // pull out lyric
  const lyr = /"([^"]*)"/.exec(tok);
  if (lyr) {
    if (lyr[1].trim()) ev.lyric = lyr[1].trim();
    tok = tok.replace(lyr[0], '');
  }
  if (tok === 'R' || tok.startsWith('R@') || tok === 'R/w') {
    ev.rest = true;
    ev.fullMeasure = true;
    ev.dur = 'w';
    applySuffix(ev, tok.slice(1));
    return ev;
  }
  const slash = tok.indexOf('/');
  if (slash < 0) return `missing "/" in "${tokRaw}"`;
  const head = tok.slice(0, slash);
  let tail = tok.slice(slash + 1);
  const dm = /^(64|32|16|8|w|h|q|1|2|4|e|s)(\.*)(t?)/.exec(tail);
  if (!dm) return `bad duration in "${tokRaw}"`;
  ev.dur = DUR_ALIASES[dm[1]];
  ev.dots = dm[2].length;
  if (dm[3]) ev.triplet = true;
  tail = tail.slice(dm[0].length);

  if (head === 'r' || head === 'R') {
    ev.rest = true;
  } else {
    for (const part of head.split('+')) {
      const tie = part.endsWith('~');
      const p = parsePitch(tie ? part.slice(0, -1) : part);
      if (!p) return `bad pitch "${part}" in "${tokRaw}"`;
      if (tie) p.tie = true;
      ev.pitches.push(p);
    }
    if (!ev.pitches.length) return `no pitch in "${tokRaw}"`;
  }
  const err = applySuffix(ev, tail);
  if (err) return `${err} in "${tokRaw}"`;
  return ev;
}

function applySuffix(ev: NoteEvent, tail: string): string | null {
  let i = 0;
  while (i < tail.length) {
    const c = tail[i];
    if (c === '~') {
      ev.pitches.forEach((p) => (p.tie = true));
      i++;
    } else if (c === '(') {
      ev.slurStart = true;
      i++;
    } else if (c === ')') {
      ev.slurEnd = true;
      i++;
    } else if (c === '@') {
      const m = /^@([A-Za-z>]+)/.exec(tail.slice(i));
      if (!m) return 'bad @ marker';
      const w = m[1];
      if (ARTIC_WORDS[w.toLowerCase()]) {
        ev.artic = [...(ev.artic ?? []), ARTIC_WORDS[w.toLowerCase()]];
      } else if ((DYNAMICS as readonly string[]).includes(w)) {
        ev.dynamic = w as Dynamic;
      } // unknown words are ignored
      i += m[0].length;
    } else if (c === '.' || c === ',' || c === ' ') {
      i++;
    } else {
      return `unexpected "${c}"`;
    }
  }
  return null;
}

export function parseVoice(voice: string): ParseResult {
  const events: NoteEvent[] = [];
  const errors: string[] = [];
  for (const t of tokenize(voice)) {
    const r = parseToken(t);
    if (typeof r === 'string') errors.push(r);
    else events.push(r);
  }
  return { events, errors };
}

function durString(e: NoteEvent): string {
  return `${e.dur}${'.'.repeat(e.dots)}${e.triplet ? 't' : ''}`;
}

export function eventToToken(e: NoteEvent): string {
  let s = e.grace ? 'g:' : '';
  if (e.rest && e.fullMeasure) s += 'R';
  else if (e.rest) s += `r/${durString(e)}`;
  else {
    const allTied = e.pitches.length > 0 && e.pitches.every((p) => p.tie);
    s += e.pitches.map((p: Pitch) => pitchToString(p) + (p.tie && !allTied ? '~' : '')).join('+');
    s += `/${durString(e)}`;
    if (allTied) s += '~';
  }
  if (e.slurStart) s += '(';
  if (e.slurEnd) s += ')';
  for (const a of e.artic ?? []) s += '@' + { staccato: 'stacc', accent: 'acc', tenuto: 'ten', marcato: 'marc', fermata: 'ferm' }[a];
  if (e.dynamic) s += '@' + e.dynamic;
  if (e.lyric) s += `"${e.lyric}"`;
  return s;
}

export function voiceToString(v: NoteEvent[]): string {
  return v.map(eventToToken).join(' ');
}
