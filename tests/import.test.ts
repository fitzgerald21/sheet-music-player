// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { demoScore } from '../src/demo';
import { toMusicXML } from '../src/model/musicxml';
import { parseMusicXML } from '../src/importers/musicxml';
import { voiceToString } from '../src/model/tokens';
import { playbackOrder } from '../src/model/playback';
import { convertPages } from '../src/omr/convert';
import { Score } from '../src/model/types';

const tokens = (s: Score) => s.measures.map((m) => m.staves.map((st) => st.voices.map(voiceToString).join(' | ')).join(' || '));

describe('MusicXML import', () => {
  it('round-trips the demo', () => {
    const s = demoScore();
    const back = parseMusicXML(toMusicXML(s).xml);
    expect(back.title).toBe('Minuet in G');
    expect(back.key).toBe(1);
    expect(back.time).toEqual([3, 4]);
    expect(back.tempo).toBe(112);
    expect(tokens(back)).toEqual(tokens(s));
    expect(playbackOrder(back)).toEqual(playbackOrder(s));
  });
  it('round-trips lyrics, chords, ties, pickups, voltas and D.C.', () => {
    const mm = (n: number, staves: string[][], extra = {}) => ({ number: n, staves, chords: [], timeSignature: '', keyFifths: '', tempo: 0, pickup: false, repeatStart: false, repeatEnd: false, ending: '', navigation: '', markers: [], text: '', ...extra });
    const { score } = convertPages([
      {
        title: 'Song', composer: 'Me', lyricist: '', arranger: '', pageNumber: 1, tempo: 96, timeSignature: '4/4', keyFifths: -2, uncertain: [],
        parts: [{ name: 'Voice', clefs: ['treble'] }, { name: 'Piano', clefs: ['treble', 'bass'] }],
        measures: [
          mm(0, [['F4/q"I"'], ['F4+A4/q'], ['F2/q']], { pickup: true }),
          mm(1, [['Bb4/h"wish-" A4/8"ing" G4/8 F4/q~'], ['D4+F4+Bb4/h r/q C4+Eb4/q'], ['Bb2/w']], { chords: [{ beat: 1, symbol: 'Bb' }, { beat: 3, symbol: 'D7/F#' }], repeatStart: true }),
          mm(2, [['F4/8 Eb4/8t D4/8t C4/8t Bb3/h.'], ['R'], ['G2/h C3/h']], { ending: '1', repeatEnd: true }),
          mm(3, [['R'], ['C5/w@ff'], ['F2+C3/w']], { ending: '2', navigation: 'DCalFine', chords: [{ beat: 1, symbol: 'F7sus4' }] }),
        ],
      },
    ]);
    const back = parseMusicXML(toMusicXML(score, { includeHidden: true }).xml);
    expect(back.parts.map((p) => `${p.name}:${p.staves.map((s) => s.clef).join('+')}`)).toEqual(['Voice:treble', 'Piano:treble+bass']);
    expect(back.measures[0].pickup).toBe(true);
    expect(tokens(back)).toEqual(tokens(score));
    expect(back.measures[1].chords).toEqual([{ beat: 1, text: 'Bb' }, { beat: 3, text: 'D7/F#' }]);
    expect(back.measures[3].chords?.[0].text).toBe('F7sus4');
    expect(back.measures[2].ending).toEqual([1]);
    expect(back.measures[3].ending).toEqual([2]);
    expect(back.measures[3].navigation).toBe('DCalFine');
    expect(playbackOrder(back)).toEqual(playbackOrder(score));
  });
});

describe('MIDI import', () => {
  it('re-imports an exported MIDI file', async () => {
    const { toMidi } = await import('../src/model/midi');
    const { buildPlan } = await import('../src/model/playback');
    const { midiToScore } = await import('../src/importers/midi');
    const { midiOf } = await import('../src/model/pitch');
    const s = demoScore();
    const bytes = toMidi(s, buildPlan(s, { humanize: false, followRepeats: false }));
    const back = midiToScore(bytes, 'minuet.mid');
    expect(back.time).toEqual([3, 4]);
    expect(back.tempo).toBe(112);
    expect(back.measures.length).toBe(16);
    expect(back.parts[0].staves.length).toBe(2);
    const onsets = (sc: Score, staff: number) =>
      sc.measures.flatMap((m) => m.staves[staff].voices[0].filter((e) => !e.rest).map((e) => e.pitches.map(midiOf).join('+')));
    // right hand melody pitches survive (staccato notes become shorter notes + rests, which is fine)
    const rh = onsets(back, 0).filter((x, i, a) => true);
    expect(rh.slice(0, 8)).toEqual(onsets(s, 0).slice(0, 8));
  });
});

describe('ABC import', () => {
  it('parses a jig with repeats, triplets, rolls and chords', async () => {
    const { parseAbc } = await import('../src/importers/abc');
    const s = parseAbc('X:1\nT:Test Jig\nM:6/8\nL:1/8\nK:Edor\n|:"Em"E2B B2A|"D"(3FGA d2BA|AFD ~D3:|\n|1 EFG A2c:|2 dcB A3|]');
    expect(s.title).toBe('Test Jig');
    expect(s.key).toBe(2);
    expect(s.time).toEqual([6, 8]);
    expect(voiceToString(s.measures[0].staves[0].voices[0])).toBe('E4/q B4/8 B4/q A4/8');
    expect(s.measures[0].repeatStart).toBe(true);
    expect(s.measures[0].chords).toEqual([{ beat: 1, text: 'Em' }]);
    expect(voiceToString(s.measures[1].staves[0].voices[0])).toBe('F#4/8t G4/8t A4/8t D5/q B4/8 A4/8');
    expect(s.measures[2].repeatEnd).toBe(2);
    expect(s.measures[3].ending).toEqual([1]);
    expect(s.measures[4].ending).toEqual([2]);
  });
  it('handles accidentals, broken rhythm, chords and a pickup', async () => {
    const { parseAbc } = await import('../src/importers/abc');
    const s = parseAbc('M:4/4\nL:1/8\nK:G\nA|B>c ^c=c [DFA]2 z2|]');
    expect(s.measures[0].pickup).toBe(true);
    expect(voiceToString(s.measures[1].staves[0].voices[0])).toBe('B4/8. C5/16 C#5/8 C5/8 D4+F#4+A4/q r/q');
  });
});
