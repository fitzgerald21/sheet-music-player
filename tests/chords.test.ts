import { describe, expect, it } from 'vitest';
import { chordFromMidis, detectChords, nameChord } from '../src/model/chordDetect';
import { demoScore } from '../src/demo';
import { convertPages } from '../src/omr/convert';

const w = (pcs: number[]) => { const a = new Array(12).fill(0); pcs.forEach((p) => (a[p % 12] += 1)); return a; };

describe('chord naming', () => {
  it('names basic chords', () => {
    expect(nameChord(w([0, 4, 7]), 0)?.text).toBe('C');
    expect(nameChord(w([9, 0, 4]), 9)?.text).toBe('Am');
    expect(nameChord(w([7, 11, 2, 5]), 7)?.text).toBe('G7');
    expect(nameChord(w([2, 5, 9, 0]), 2)?.text).toBe('Dm7');
    expect(nameChord(w([0, 4, 7, 11]), 0)?.text).toBe('Cmaj7');
    expect(nameChord(w([11, 2, 5]), 11)?.text).toBe('Bdim');
    expect(nameChord(w([0, 4, 7]), 4)?.text).toBe('C/E');
    expect(nameChord(w([10, 2, 5]), 10, -2)?.text).toBe('Bb');
    expect(nameChord(w([2, 6, 9, 0]), 6, -2)?.text).toBe('D7/F#');
  });
  it('names held MIDI notes', () => {
    expect(chordFromMidis([43, 55, 58, 62], -2)).toBe('Gm');
    expect(chordFromMidis([60, 64, 67, 70])).toBe('C7');
  });
  it('detects chords in the demo', () => {
    const { score, added } = detectChords(demoScore(), { granularity: 'auto', overwrite: true });
    expect(added).toBeGreaterThan(5);
    expect(score.measures[0].chords?.[0].text).toBe('G');
    expect(score.measures[7].chords?.[0].text).toMatch(/^D/);
  });
  it('detects chords from piano accompaniment', () => {
    const mm = (n: number, rh: string, lh: string) => ({ number: n, staves: [[rh], [lh]], chords: [], timeSignature: '', keyFifths: '', tempo: 0, pickup: false, repeatStart: false, repeatEnd: false, ending: '', navigation: '', markers: [], text: '' });
    const { score } = convertPages([{ title: '', composer: '', lyricist: '', arranger: '', pageNumber: 1, tempo: 100, timeSignature: '4/4', keyFifths: -2, uncertain: [], parts: [{ name: 'Piano', clefs: ['treble', 'bass'] }],
      measures: [mm(1, 'D5/h C5/h', 'Bb2/8 F3/8 D4/8 F3/8 F#2/8 D3/8 C4/8 D3/8'), mm(2, 'Bb4/w', 'G2/8 D3/8 Bb3/8 D3/8 F2/8 D3/8 Ab3/8 D3/8')] }]);
    const { score: out } = detectChords(score, { granularity: 'auto', overwrite: true });
    expect(out.measures[0].chords?.map((c) => c.text)).toEqual(['Bb', 'D7/F#']);
    expect(out.measures[1].chords?.map((c) => c.text)).toEqual(['Gm', 'Bb7/F']);
  });
});
