// Shape of one transcribed page, as returned by the model (structured output).

export interface PagePart {
  name: string;
  clefs: string[];
}

export interface PageChord {
  beat: number;
  symbol: string;
}

export interface PageMeasure {
  number: number;
  /** staves[globalStaff] = list of voice strings (token notation) */
  staves: string[][];
  chords: PageChord[];
  timeSignature: string;
  keyFifths: string;
  tempo: number;
  pickup: boolean;
  repeatStart: boolean;
  repeatEnd: boolean;
  ending: string;
  navigation: string;
  markers: string[];
  text: string;
}

export interface PageTranscription {
  title: string;
  composer: string;
  lyricist: string;
  arranger: string;
  pageNumber: number;
  tempo: number;
  timeSignature: string;
  keyFifths: number;
  parts: PagePart[];
  measures: PageMeasure[];
  uncertain: string[];
}

const str = { type: 'string' } as const;
const bool = { type: 'boolean' } as const;
const int = { type: 'integer' } as const;

export const PAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'composer', 'lyricist', 'arranger', 'pageNumber', 'tempo', 'timeSignature', 'keyFifths', 'parts', 'measures', 'uncertain'],
  properties: {
    title: str,
    composer: str,
    lyricist: str,
    arranger: str,
    pageNumber: int,
    tempo: int,
    timeSignature: str,
    keyFifths: int,
    parts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'clefs'],
        properties: {
          name: str,
          clefs: { type: 'array', items: { type: 'string', enum: ['treble', 'bass', 'alto', 'tenor', 'treble8vb'] } },
        },
      },
    },
    measures: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['number', 'staves', 'chords', 'timeSignature', 'keyFifths', 'tempo', 'pickup', 'repeatStart', 'repeatEnd', 'ending', 'navigation', 'markers', 'text'],
        properties: {
          number: int,
          staves: { type: 'array', items: { type: 'array', items: str } },
          chords: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['beat', 'symbol'],
              properties: { beat: { type: 'number' }, symbol: str },
            },
          },
          timeSignature: str,
          keyFifths: str,
          tempo: int,
          pickup: bool,
          repeatStart: bool,
          repeatEnd: bool,
          ending: str,
          navigation: { type: 'string', enum: ['', 'DC', 'DCalFine', 'DCalCoda', 'DS', 'DSalFine', 'DSalCoda'] },
          markers: { type: 'array', items: { type: 'string', enum: ['segno', 'coda', 'fine', 'toCoda'] } },
          text: str,
        },
      },
    },
    uncertain: { type: 'array', items: str },
  },
} as const;
