import { describe, expect, it } from 'vitest';
import { buildSteps, sectionSpan, TimingScore } from '../src/model/practice';
import { PlaybackPlan, PlayNote } from '../src/model/playback';

const note = (time: number, midi: number, staff = 0): PlayNote => ({ time, dur: 0.5, midi, velocity: 0.6, part: 0, eventId: `e${time}-${midi}`, staff });
const measure = (measure: number, time: number) => ({ measure, time, end: time + 2, beats: 4, beatUnit: 4, beatDur: 0.5, qpm: 120 });

// measures 0 1 | 0 1 (repeated) | 2
const plan: PlaybackPlan = {
  notes: [note(0, 60), note(0, 64), note(0, 48, 1), note(1, 62), note(2, 64), note(4, 60), note(6, 64), note(8, 67)],
  spans: [],
  measures: [measure(0, 0), measure(1, 2), measure(0, 4), measure(1, 6), measure(2, 8)],
  duration: 10,
};

describe('buildSteps', () => {
  it('groups one hand into chords', () => {
    const steps = buildSteps(plan, [0]);
    expect(steps[0]).toMatchObject({ time: 0, midis: [60, 64] });
    expect(steps.map((s) => s.time)).toEqual([0, 1, 2, 4, 6, 8]);
  });
  it('keeps to a section', () => {
    expect(buildSteps(plan, [0], 2, 4).map((s) => s.time)).toEqual([2]);
  });
});

describe('sectionSpan', () => {
  it('uses the first time a measure comes round', () => {
    expect(sectionSpan(plan, 1, 1)).toEqual({ start: 2, end: 4 });
  });
  it('runs to the very end when the section includes the last measure', () => {
    expect(sectionSpan(plan, 0, 2)).toEqual({ start: 0, end: 10 });
  });
});

describe('TimingScore', () => {
  it('counts keys near their note and marks the rest as extra', () => {
    const score = new TimingScore(buildSteps(plan, [0], 0, 4));
    expect(score.press(60, 0.1, 0.25)).toBe('hit');
    expect(score.press(60, 0.15, 0.25)).toBe('extra'); // already played
    expect(score.press(62, 1.6, 0.25)).toBe('extra'); // too late
    expect(score.press(64, 1.9, 0.25)).toBe('hit'); // the E at 2, not the one missed at 0
    expect(score.result(1)).toEqual({ total: 3, hit: 1, extra: 2, percent: 33 });
    expect(score.result()).toMatchObject({ total: 4, hit: 2 });
  });
});
