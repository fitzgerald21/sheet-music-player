// Core score model. This is the single source of truth: rendering (MusicXML -> OSMD),
// playback and editing all work from this structure.

export const STEPS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const;
export type Step = (typeof STEPS)[number];

export interface Pitch {
  step: Step;
  /** -2 .. 2 (flat-flat .. sharp-sharp). This is the *sounding* alteration, key signature already applied. */
  alter: number;
  octave: number;
  /** Tied to the same pitch in the next event of this voice. */
  tie?: boolean;
}

export type DurType = 'w' | 'h' | 'q' | '8' | '16' | '32' | '64';
export const DUR_TYPES: DurType[] = ['w', 'h', 'q', '8', '16', '32', '64'];

export type Articulation = 'staccato' | 'accent' | 'tenuto' | 'marcato' | 'fermata';
export const DYNAMICS = ['ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'sfz', 'fp'] as const;
export type Dynamic = (typeof DYNAMICS)[number];

export interface NoteEvent {
  id: string;
  /** Empty for rests. */
  pitches: Pitch[];
  rest?: boolean;
  /** Whole-measure rest: its length is the measure length regardless of `dur`. */
  fullMeasure?: boolean;
  dur: DurType;
  dots: number;
  triplet?: boolean;
  grace?: boolean;
  slurStart?: boolean;
  slurEnd?: boolean;
  artic?: Articulation[];
  dynamic?: Dynamic;
  lyric?: string;
}

export interface StaffMeasure {
  voices: NoteEvent[][];
}

export interface ChordSymbol {
  /** 1-based beat in units of the time-signature denominator (may be fractional). */
  beat: number;
  text: string;
}

export type Navigation = 'DC' | 'DCalFine' | 'DCalCoda' | 'DS' | 'DSalFine' | 'DSalCoda';

export interface Measure {
  staves: StaffMeasure[];
  chords?: ChordSymbol[];
  /** Time signature change starting at this measure. */
  time?: [number, number];
  /** Key signature change (circle-of-fifths count) starting at this measure. */
  key?: number;
  /** Tempo change (quarter notes per minute) starting at this measure. */
  tempo?: number;
  /** Incomplete (anacrusis) measure. */
  pickup?: boolean;
  repeatStart?: boolean;
  /** Repeat sign at the end. Value = total number of times the section is played (normally 2). */
  repeatEnd?: number;
  /** Volta ending numbers (e.g. [1] or [1, 2]). */
  ending?: number[];
  navigation?: Navigation;
  segno?: boolean;
  coda?: boolean;
  fine?: boolean;
  toCoda?: boolean;
  text?: string;
}

export type Clef = 'treble' | 'bass' | 'alto' | 'tenor' | 'treble8vb';

export interface Staff {
  clef: Clef;
}

export type InstrumentId =
  | 'piano'
  | 'epiano'
  | 'strings'
  | 'voice'
  | 'flute'
  | 'organ'
  | 'musicbox'
  | 'marimba'
  | 'guitar'
  | 'bass';

export interface Part {
  id: string;
  name: string;
  staves: Staff[];
  instrument: InstrumentId;
  /** Volume in dB, 0 = default. */
  volume: number;
  muted?: boolean;
  solo?: boolean;
  /** Hidden parts are not drawn (still played unless muted). */
  hidden?: boolean;
}

export interface Score {
  id: string;
  title: string;
  subtitle?: string;
  composer?: string;
  lyricist?: string;
  arranger?: string;
  /** Initial tempo, quarter notes per minute. */
  tempo: number;
  time: [number, number];
  key: number;
  parts: Part[];
  measures: Measure[];
  created: number;
  updated: number;
  /** Notes about the transcription (uncertain passages etc.). */
  notes?: string[];
  /** How the score was made, for the notes banner. */
  source?: 'claude' | 'compat' | 'audiveris' | 'import';
}

export interface GlobalStaff {
  partIndex: number;
  staffInPart: number;
  clef: Clef;
}

export function globalStaves(score: Score): GlobalStaff[] {
  const out: GlobalStaff[] = [];
  score.parts.forEach((p, pi) => p.staves.forEach((s, si) => out.push({ partIndex: pi, staffInPart: si, clef: s.clef })));
  return out;
}

let idCounter = 0;
export function newId(prefix = 'e'): string {
  idCounter = (idCounter + 1) % 1e9;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function cloneScore(s: Score): Score {
  return structuredClone(s);
}
