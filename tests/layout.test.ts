import { describe, expect, it } from 'vitest';
import { findSystems, mapMeasures, Gray } from '../src/omr/layout';

/** A drawn page: piano systems of two staves with bar lines, stems, noteheads and some text-like marks. */
function page(opts: { systems: number[][]; tiltDeg?: number; width?: number; height?: number }): Gray {
  const w = opts.width ?? 800;
  const h = opts.height ?? 1000;
  const data = new Uint8Array(w * h).fill(245);
  const t = Math.tan(((opts.tiltDeg ?? 0) * Math.PI) / 180);
  // rotate about the page centre, as a slightly crooked photo would be
  const ink = (x: number, y: number) => {
    const xx = Math.round(x - (y - h / 2) * t);
    const yy = Math.round(y + (x - w / 2) * t);
    if (xx >= 0 && xx < w && yy >= 0 && yy < h) data[yy * w + xx] = 20;
  };
  const rect = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y <= y1; y += 0.5) for (let x = x0; x <= x1; x += 0.5) ink(x, y);
  };
  const space = 10;
  const left = 80;
  const right = 720;
  opts.systems.forEach((bars, si) => {
    const top = 120 + si * 260;
    const staffTops = [top, top + 90];
    for (const st of staffTops) for (let k = 0; k < 5; k++) rect(left, st + k * space, right, st + k * space + 1);
    // the line that joins the two staves, and the bar lines (fractions of the system's width)
    rect(left, top, left + 1, top + 90 + 4 * space);
    for (const b of [...bars, 1]) {
      const x = left + b * (right - left);
      rect(x - 1, top, x, top + 90 + 4 * space);
    }
    // notes: heads with stems, some reaching well outside the staff
    const barXs = bars.map((b) => left + b * (right - left));
    for (let x = left + 40; x < right - 20; x += 37) {
      if (barXs.some((b) => Math.abs(b - (x + 6)) < 16)) continue; // notes keep clear of bar lines
      const y = top + ((x * 7) % 50) - 8;
      rect(x, y, x + 9, y + 7);
      rect(x + 9, y - 34, x + 10, y + 3);
      rect(x + 4, y + 96, x + 12, y + 103);
      rect(x + 4, y + 99, x + 5, y + 134);
    }
    // lyrics between the staves
    for (let x = left + 30; x < right - 40; x += 55) rect(x, top + 60, x + 30, top + 66);
  });
  return { data, width: w, height: h };
}

describe('findSystems', () => {
  it('finds the systems and the measures in them', () => {
    const { systems } = findSystems(page({ systems: [[0.3, 0.55, 0.8], [0.25, 0.5, 0.75], [0.5]] }));
    expect(systems.map((s) => s.bars.length - 1)).toEqual([4, 4, 2]);
    expect(systems[0].bars[0]).toBeCloseTo(80 / 800, 2);
    expect(systems[0].bars[1]).toBeCloseTo((80 + 0.3 * 640) / 800, 2);
    // each system takes in both of its staves
    expect(systems[0].top).toBeLessThan(0.12);
    expect(systems[0].bottom).toBeGreaterThan(0.25);
    expect(systems[0].bottom).toBeLessThan(systems[1].top);
  });

  it.each([0.5, 1.3, -2])('copes with a photo that is %s° crooked', (tiltDeg) => {
    const { systems } = findSystems(page({ systems: [[0.3, 0.55, 0.8], [0.25, 0.5, 0.75], [0.5]], tiltDeg }));
    expect(systems.map((s) => s.bars.length - 1)).toEqual([4, 4, 2]);
  });

  it('finds nothing on a page without music', () => {
    const data = new Uint8Array(400 * 400).fill(240);
    for (let i = 0; i < data.length; i += 7) data[i] = 30;
    expect(findSystems({ data, width: 400, height: 400 }).systems).toEqual([]);
  });
});

describe('mapMeasures', () => {
  const pages = [{ systems: [{ top: 0.1, bottom: 0.2, bars: [0.1, 0.5, 0.9] }] }, { systems: [{ top: 0.3, bottom: 0.4, bars: [0.1, 0.9] }] }];
  it('gives each measure its own box when the counts agree', () => {
    const m = mapMeasures(pages, 3);
    expect(m.exact).toBe(true);
    expect(m.boxes[1]).toMatchObject({ page: 0, x: 0.5, y: 0.1 });
    expect(m.boxes[2]).toMatchObject({ page: 1, x: 0.1 });
    expect(m.boxes[2].w).toBeCloseTo(0.8);
  });
  it('does not count the stretch before an opening repeat sign as a measure', () => {
    const opening = [{ systems: [{ top: 0.1, bottom: 0.2, bars: [0.1, 0.18, 0.4, 0.65, 0.9] }, { top: 0.3, bottom: 0.4, bars: [0.1, 0.5, 0.9] }] }];
    const m = mapMeasures(opening, 5);
    expect(m.exact).toBe(true);
    expect(m.boxes[0]).toMatchObject({ x: 0.1 });
    expect(m.boxes[0].w).toBeCloseTo(0.3);
  });
  it('spreads the measures over what was found when they do not', () => {
    const m = mapMeasures(pages, 6);
    expect(m.exact).toBe(false);
    expect(m.boxes.map((b) => b.page)).toEqual([0, 0, 0, 0, 1, 1]);
  });
});
