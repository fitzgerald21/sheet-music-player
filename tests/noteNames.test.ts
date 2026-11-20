import { describe, expect, it } from 'vitest';
import { ledgerLines, noteNames, NoteNameOptions } from '../src/model/noteNames';
import { parseVoice } from '../src/model/tokens';
import { Clef, Score } from '../src/model/types';

const piano = (treble: string, bass: string, clefs: [Clef, Clef] = ['treble', 'bass']): Score =>
  ({
    id: 's',
    title: 'Test',
    tempo: 100,
    time: [4, 4],
    key: 0,
    parts: [{ id: 'p', name: 'Piano', staves: [{ clef: clefs[0] }, { clef: clefs[1] }], instrument: 'piano', volume: 0 }],
    measures: [{ staves: [{ voices: [parseVoice(treble).events] }, { voices: [parseVoice(bass).events] }] }],
    created: 0,
    updated: 0,
  }) as Score;

const opts = (more: Partial<NoteNameOptions> = {}): NoteNameOptions => ({ on: true, ledger: 3, staves: 'all', octave: false, ...more });
const texts = (s: Score, o: NoteNameOptions) => [...noteNames(s, o).values()].flat().map((n) => n.text);

describe('note names off the staff', () => {
  it('counts ledger lines like the page does', () => {
    const E4 = 4 * 7 + 2;
    expect(ledgerLines(4 * 7 + 0, E4)).toBe(1); // middle C
    expect(ledgerLines(4 * 7 + 1, E4)).toBe(0); // D4 hangs under the staff
    expect(ledgerLines(5 * 7 + 4, E4)).toBe(0); // G5 sits on top
    expect(ledgerLines(5 * 7 + 5, E4)).toBe(1); // A5
    expect(ledgerLines(6 * 7 + 2, E4)).toBe(3); // E6
  });

  it('names only notes three or more ledger lines away by default', () => {
    const s = piano('C6/q D6/q E6/q F3/q', 'C4/q E4/q A1/q B1/q');
    expect(texts(s, opts())).toEqual(['E', 'F', 'A']);
    expect(texts(s, opts({ ledger: 2 }))).toEqual(['C', 'D', 'E', 'F', 'E', 'A', 'B']);
    expect(texts(s, opts({ on: false }))).toEqual([]);
  });

  it('can name every note, or only one clef', () => {
    const s = piano('C6/q F#4/q', 'C2/q Bb2/q');
    expect(texts(s, opts({ ledger: 0, octave: true }))).toEqual(['C6', 'F♯4', 'C2', 'B♭2']);
    expect(texts(s, opts({ ledger: 2, staves: 'treble', octave: true }))).toEqual(['C6']);
    expect(texts(s, opts({ ledger: 2, staves: 'bass', octave: true }))).toEqual(['C2']);
  });

  it('counts notes under an 8va line where they are drawn', () => {
    const s = piano('C6/q@8va D6/q E6/q@8end E6/q', 'R');
    // under the line C6–E6 are drawn as C5–E5, inside the staff
    expect(texts(s, opts({ octave: true }))).toEqual(['E6']);
  });

  it('reads a treble-8vb staff an octave lower', () => {
    const s = piano('C5/q C4/q', 'R', ['treble8vb', 'bass']);
    // drawn as C6 (two ledger lines) and C5 (third space)
    expect(texts(s, opts({ ledger: 1, octave: true }))).toEqual(['C5']);
    expect(texts(s, opts({ ledger: 3 }))).toEqual([]);
    expect(texts(s, opts({ ledger: 0 }))).toEqual(['C', 'C']);
  });

  it('ranks chord notes lowest first, whatever order they were written in', () => {
    const s = piano('E6+C4+C6/q', 'R');
    const [names] = noteNames(s, opts({ ledger: 1, octave: true })).values();
    expect(names).toEqual([
      { rank: 0, text: 'C4' },
      { rank: 1, text: 'C6' },
      { rank: 2, text: 'E6' },
    ]);
  });
});
