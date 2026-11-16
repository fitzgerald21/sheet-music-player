// Finds where the music is on a page image: the systems (rows of staves) and the bar lines in them.
// It does not read notes. "Original pages" in play-along uses it to move a cursor over the photo or
// PDF page in step with the score that was read from it.
//
// How: darken → find the page's tilt → rows with a long unbroken stretch of ink are staff lines
// → five evenly spaced lines make a staff → staves joined by a vertical line make a system → a thin
// vertical line that crosses every staff from its top line to its bottom line is a bar line.

export interface Gray {
  /** one byte per pixel, 0 = black */
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

/** All values are fractions of the page's width (left, right, bars) or height (top, bottom). */
export interface SystemLayout {
  top: number;
  bottom: number;
  /** the edges of the measures, left to right: one more than there are measures */
  bars: number[];
}

export interface PageLayout {
  systems: SystemLayout[];
}

interface Staff {
  /** rows of the top and bottom line, in straightened coordinates */
  top: number;
  bottom: number;
  space: number;
  left: number;
  right: number;
}

/** Dark where a pixel is clearly darker than its surroundings, so shadows on a photo don't count. */
function darken(img: Gray): Uint8Array {
  const { data, width: w, height: h } = img;
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += data[y * w + x];
      integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + row;
    }
  }
  const r = Math.max(8, Math.round(w / 40));
  const dark = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const sum = integral[y1 * (w + 1) + x1] - integral[y0 * (w + 1) + x1] - integral[y1 * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
      const mean = sum / ((x1 - x0) * (y1 - y0));
      if (data[y * w + x] < mean * 0.88 - 3) dark[y * w + x] = 1;
    }
  }
  return dark;
}

export function findSystems(img: Gray): PageLayout {
  const { width: w, height: h } = img;
  const dark = darken(img);
  const cx = w / 2;

  // ---- tilt: the slope at which rows of dark pixels pile up most sharply ----
  const pts: number[] = [];
  const stride = Math.max(1, Math.round((w * h) / 400000));
  // every row, some of the columns: skipping rows would make untilted look sharpest whatever the page
  for (let y = 0; y < h; y++) for (let x = y % stride; x < w; x += stride) if (dark[y * w + x]) pts.push(x, y);
  const pad = Math.ceil(w * 0.05);
  const hist = new Float64Array(h + 2 * pad);
  let slope = 0;
  let sharpest = -1;
  for (let deg = -2.5; deg <= 2.5001; deg += 0.125) {
    const t = Math.tan((deg * Math.PI) / 180);
    hist.fill(0);
    for (let i = 0; i < pts.length; i += 2) hist[Math.round(pts[i + 1] + (pts[i] - cx) * t) + pad]++;
    let s = 0;
    for (let i = 0; i < hist.length; i++) s += hist[i] * hist[i];
    if (s > sharpest) {
      sharpest = s;
      slope = t;
    }
  }
  // straightened row `r` at column x is image row r - (x - cx) * slope; a vertical line leans the other way
  const at = (x: number, r: number): number => {
    const y = Math.round(r - (x - cx) * slope);
    return x >= 0 && x < w && y >= 0 && y < h ? dark[y * w + x] : 0;
  };

  // ---- staff lines: rows with a long unbroken stretch of ink (a short last system still counts) ----
  const need = w * 0.12;
  const isLine = new Uint8Array(h + 2 * pad);
  let any = false;
  for (let r = -pad; r < h + pad; r++) {
    let run = 0;
    let gap = 0;
    for (let x = 0; x < w && run < need; x++) {
      // a thin line on a photo wanders between two rows of pixels
      if (at(x, r) || at(x, r + 1)) {
        run += gap + 1;
        gap = 0;
      } else if (run && ++gap > 4) {
        run = 0;
        gap = 0;
      }
    }
    if (run >= need) {
      isLine[r + pad] = 1;
      any = true;
    }
  }
  if (!any) return { systems: [] };
  const lines: number[] = [];
  for (let i = 0; i < isLine.length; i++) {
    if (!isLine[i]) continue;
    let j = i;
    while (isLine[j + 1]) j++;
    lines.push((i + j) / 2 - pad);
    i = j;
  }

  // ---- staves: five lines, evenly spaced ----
  const staves: Staff[] = [];
  for (let i = 0; i + 4 < lines.length; ) {
    const gaps = [1, 2, 3, 4].map((k) => lines[i + k] - lines[i + k - 1]);
    const space = (lines[i + 4] - lines[i]) / 4;
    if (space >= 3 && gaps.every((g) => Math.abs(g - space) <= Math.max(1.5, space * 0.25))) {
      staves.push({ top: lines[i], bottom: lines[i + 4], space, left: 0, right: w - 1 });
      i += 5;
    } else i++;
  }
  // how far each staff reaches: where at least three of its lines are inked
  for (const s of staves) {
    const on = new Uint8Array(w);
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let k = 0; k < 5; k++) {
        const r = s.top + k * s.space;
        if (at(x, r) || at(x, r - 1) || at(x, r + 1)) n++;
      }
      on[x] = n >= 3 ? 1 : 0;
    }
    const win = Math.max(8, Math.round(s.space * 4));
    let run = 0;
    for (let x = 0; x < win && x < w; x++) run += on[x];
    let left = -1;
    let right = -1;
    for (let x = 0; x + win <= w; x++) {
      if (run >= win * 0.8) {
        if (left < 0) left = x;
        right = x + win - 1;
      }
      if (x + win < w) run += on[x + win] - on[x];
    }
    if (left >= 0) {
      // the window is mostly inked, not wholly: trim to the first and last inked column
      while (left < right && !on[left]) left++;
      while (right > left && !on[right]) right--;
      s.left = left;
      s.right = right;
    }
  }

  /** How much of column x is inked between two straightened rows; `mid` is where the lean pivots. */
  const cover = (x: number, r0: number, r1: number, mid: number, exact = false): number => {
    let n = 0;
    let of = 0;
    for (let r = Math.round(r0); r <= Math.round(r1); r++) {
      const xx = Math.round(x + (r - mid) * slope);
      if (at(xx, r) || (!exact && (at(xx - 1, r) || at(xx + 1, r)))) n++;
      of++;
    }
    return of ? n / of : 0;
  };

  // ---- systems: staves joined by a line running down the gap between them ----
  const groups: Staff[][] = [];
  staves.forEach((s, i) => {
    const prev = staves[i - 1];
    let joined = false;
    if (prev && s.top - prev.bottom < prev.space * 14) {
      const mid = (prev.bottom + s.top) / 2;
      for (let x = Math.max(prev.left, s.left) - 2; x <= Math.min(prev.right, s.right) + 2 && !joined; x++) joined = cover(x, prev.bottom, s.top, mid) >= 0.9;
    }
    if (joined) groups[groups.length - 1].push(s);
    else groups.push([s]);
  });

  // ---- bar lines ----
  const systems: SystemLayout[] = groups.map((group) => {
    const first = group[0];
    const last = group[group.length - 1];
    const space = first.space;
    const left = Math.min(...group.map((s) => s.left));
    const right = Math.max(...group.map((s) => s.right));
    const mid = (first.top + last.bottom) / 2;
    const found: number[] = [];
    let runStart = -1;
    for (let x = left; x <= right + 1; x++) {
      const bar =
        x <= right &&
        group.every((s) => cover(x, s.top, s.bottom, mid) >= 0.92) &&
        // a straight line, not curves that happen to stack up (the digits of a time signature)
        group.every((s) => [-1, 0, 1].some((d) => cover(x + d, s.top, s.bottom, mid, true) >= 0.85)) &&
        // a stem carries on past the staff; a bar line stops at its outer lines
        cover(x, first.top - space * 1.6, first.top - space * 0.4, mid) < 0.8 &&
        cover(x, last.bottom + space * 0.4, last.bottom + space * 1.6, mid) < 0.8;
      if (bar && runStart < 0) runStart = x;
      if (!bar && runStart >= 0) {
        found.push((runStart + x - 1) / 2);
        runStart = -1;
      }
    }
    // edges of the measures: the system's own ends, and each bar line between them (a double bar counts once)
    const edges = [left];
    for (const x of found) if (x - edges[edges.length - 1] > space * 2.5 && right - x > space * 2.5) edges.push(x);
    edges.push(right);
    const xm = (left + right) / 2;
    const tilt = (xm - cx) * slope;
    return {
      top: Math.max(0, first.top - space * 2 - tilt) / h,
      bottom: Math.min(h, last.bottom + space * 2 - tilt) / h,
      bars: edges.map((x) => x / w),
    };
  });
  return { systems };
}

/** A measure's place on a page; x, y, w and h are fractions of the page. */
export interface MeasureBox {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where each of the score's `total` measures is on the pages. When the pages have as many measures
 * as the score, each gets its own box; otherwise (a bar line missed, or one too many) the measures
 * are spread evenly over what was found, which keeps the cursor on the right line of music.
 */
export function mapMeasures(pages: PageLayout[], total: number): { boxes: MeasureBox[]; found: number; exact: boolean } {
  const rows = pages.flatMap((p, page) => p.systems.map((s) => ({ page, top: s.top, bottom: s.bottom, bars: [...s.bars] })));
  const count = () => rows.reduce((a, r) => a + r.bars.length - 1, 0);
  // Too many: a repeat sign straight after the clef is a bar line that starts no new measure. Such a
  // first "measure" is narrower than the others, so join the narrowest ones to their neighbours.
  if (count() > total) {
    const narrow = rows
      .filter((r) => r.bars.length > 2)
      .map((r) => {
        const widths = r.bars.slice(1).map((b, i) => b - r.bars[i]);
        const rest = widths.slice(1).sort((a, b) => a - b);
        return { r, ratio: widths[0] / rest[rest.length >> 1] };
      })
      .filter((c) => c.ratio < 0.85)
      .sort((a, b) => a.ratio - b.ratio);
    for (const c of narrow.slice(0, count() - total)) c.r.bars.splice(1, 1);
  }
  const found: MeasureBox[] = [];
  for (const r of rows) for (let i = 0; i + 1 < r.bars.length; i++) found.push({ page: r.page, x: r.bars[i], y: r.top, w: r.bars[i + 1] - r.bars[i], h: r.bottom - r.top });
  if (!found.length) return { boxes: [], found: 0, exact: false };
  if (found.length === total) return { boxes: found, found: total, exact: true };
  const boxes = Array.from({ length: total }, (_, j) => found[Math.min(found.length - 1, Math.floor(((j + 0.5) * found.length) / total))]);
  return { boxes, found: found.length, exact: false };
}

/** Decode an image file and find its systems. Pages are analysed at a modest size: it is the lines that matter. */
export async function layoutOfImage(blob: Blob, maxWidth = 1400): Promise<PageLayout> {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, maxWidth / bmp.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const data = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0; i < data.length; i++) data[i] = (rgba[i * 4] * 3 + rgba[i * 4 + 1] * 6 + rgba[i * 4 + 2]) / 10;
  return findSystems({ data, width: canvas.width, height: canvas.height });
}
