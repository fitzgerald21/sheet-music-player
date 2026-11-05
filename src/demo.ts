// Built-in demo piece (public domain): Minuet in G, BWV Anh. 114 (attr. Christian Petzold),
// in a simple arrangement written for this app.
import { convertPages } from './omr/convert';
import { PageMeasure, PageTranscription } from './omr/schema';
import { Score } from './model/types';

const RH = [
  'D5/q@mf G4/8( A4/8 B4/8 C5/8)', 'D5/q G4/q@stacc G4/q@stacc', 'E5/q C5/8( D5/8 E5/8 F#5/8)', 'G5/q G4/q@stacc G4/q@stacc',
  'C5/q D5/8( C5/8 B4/8 A4/8)', 'B4/q C5/8( B4/8 A4/8 G4/8)', 'F#4/q G4/8( A4/8 B4/8 G4/8)', 'A4/h.',
  'D5/q G4/8( A4/8 B4/8 C5/8)', 'D5/q G4/q@stacc G4/q@stacc', 'E5/q C5/8( D5/8 E5/8 F#5/8)', 'G5/q G4/q@stacc G4/q@stacc',
  'C5/q D5/8( C5/8 B4/8 A4/8)', 'B4/q C5/8( B4/8 A4/8 G4/8)', 'A4/q B4/8( A4/8 G4/8 F#4/8)', 'G4/h.',
];
const LH = [
  'G3+B3+D4/h A3/q', 'B3/h.', 'C4/h.', 'B3/h.', 'A3/h.', 'G3/h.', 'D4/q B3/q G3/q', 'D4/q D3/8 C4/8 B3/8 A3/8',
  'B3/h A3/q', 'G3/q B3/q G3/q', 'C4/h.', 'B3/q C4/8 B3/8 A3/8 G3/8', 'A3/h F#3/q', 'G3/h B3/q', 'C4/q D4/q D3/q', 'G3/h G2/q',
];

function measure(i: number): PageMeasure {
  return {
    number: i + 1,
    staves: [[RH[i]], [LH[i]]],
    chords: [],
    timeSignature: '',
    keyFifths: '',
    tempo: 0,
    pickup: false,
    repeatStart: i === 0,
    repeatEnd: i === 7,
    ending: '',
    navigation: '',
    markers: [],
    text: '',
  };
}

export function demoScore(): Score {
  const page: PageTranscription = {
    title: 'Minuet in G',
    composer: 'Christian Petzold (BWV Anh. 114)',
    lyricist: '',
    arranger: '',
    pageNumber: 1,
    tempo: 112,
    timeSignature: '3/4',
    keyFifths: 1,
    parts: [{ name: 'Piano', clefs: ['treble', 'bass'] }],
    measures: RH.map((_, i) => measure(i)),
    uncertain: [],
  };
  const { score } = convertPages([page]);
  score.subtitle = 'Demo piece';
  return score;
}
