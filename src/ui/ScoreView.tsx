import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import { toMusicXML } from '../model/musicxml';
import { Score } from '../model/types';

export interface Selection {
  eventId: string | null;
  pitchIdx: number | null;
  /** measure range (inclusive) */
  m0: number;
  m1: number;
}

export interface ScoreViewHandle {
  /** highlight these event ids as playing and show a cursor on `measure` */
  setPlaying(ids: Set<string>, measure: number | null, follow: boolean): void;
  measureAtPoint(x: number, y: number): number | null;
  /** mark notes the player should play now (wait mode) */
  setTargets(ids: Set<string>): void;
  /** measure boxes in px relative to the score host */
  measureBoxes(): { x: number; y: number; w: number; h: number }[];
}

interface Props {
  score: Score;
  zoom: number;
  selection: Selection | null;
  onSelect: (sel: Selection | null, additive: boolean) => void;
  onRendered?: () => void;
  editMode: boolean;
  /** paper colour for the performance view */
  paper?: 'white' | 'cream' | 'dark';
  /** turn off tap-to-select (performance view handles taps itself) */
  passive?: boolean;
}

interface MeasureBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

const UNIT = 10;

export const ScoreView = forwardRef<ScoreViewHandle, Props>(function ScoreView({ score, zoom, selection, onSelect, onRendered, editMode, paper, passive }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null);
  const elemsRef = useRef(new Map<string, SVGGElement[]>());
  const measureBoxes = useRef<MeasureBox[]>([]);
  const playingRef = useRef(new Set<string>());
  const targetsRef = useRef(new Set<string>());
  const cursorRef = useRef<HTMLDivElement>(null);
  const selBoxRef = useRef<HTMLDivElement>(null);
  const lastFollow = useRef<number>(-1);
  const [error, setError] = useState<string | null>(null);
  const [renderTick, setRenderTick] = useState(0);
  const renderSeq = useRef(0);

  // create OSMD once
  useEffect(() => {
    const host = hostRef.current!;
    const osmd = new OpenSheetMusicDisplay(host, {
      autoResize: false,
      backend: 'svg',
      drawTitle: true,
      drawSubtitle: true,
      drawComposer: true,
      drawLyricist: true,
      drawPartNames: true,
      drawMeasureNumbers: true,
      autoBeam: true,
      disableCursor: true,
      pageFormat: 'Endless',
      newSystemFromXML: false,
      drawingParameters: 'default',
      followCursor: false,
    });
    osmd.EngravingRules.RenderMultipleRestMeasures = false;
    osmd.EngravingRules.PageTopMargin = 4;
    osmd.EngravingRules.PageLeftMargin = 3;
    osmd.EngravingRules.PageRightMargin = 3;
    osmdRef.current = osmd;
    return () => {
      osmd.clear();
      osmdRef.current = null;
    };
  }, []);

  // re-render on score / zoom change
  useEffect(() => {
    const osmd = osmdRef.current;
    if (!osmd) return;
    const seq = ++renderSeq.current;
    const { xml, eventKeys } = toMusicXML(score, { chordText: true });
    let cancelled = false;
    const run = async () => {
      try {
        await osmd.load(xml);
        if (cancelled || seq !== renderSeq.current) return;
        osmd.zoom = zoom;
        fitTitle(osmd, score.title, hostRef.current?.clientWidth ?? 800, zoom);
        osmd.render();
        setError(null);
        indexGraphics(osmd, eventKeys);
        setRenderTick((t) => t + 1);
        onRendered?.();
      } catch (e) {
        console.error(e);
        setError(e instanceof Error ? e.message : String(e));
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [score, zoom]);

  // re-layout on width change
  useEffect(() => {
    let w = hostRef.current?.clientWidth ?? 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      const nw = hostRef.current?.clientWidth ?? 0;
      if (Math.abs(nw - w) < 8) return;
      w = nw;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const osmd = osmdRef.current;
        if (!osmd || !osmd.IsReadyToRender()) return;
        fitTitle(osmd, titleRef.current, nw, osmd.zoom);
        osmd.render();
        indexGraphics(osmd, lastKeys.current);
        setRenderTick((t) => t + 1);
      }, 200);
    });
    if (hostRef.current) ro.observe(hostRef.current);
    return () => ro.disconnect();
  }, []);

  const lastKeys = useRef<Map<string, string>>(new Map());
  const titleRef = useRef(score.title);
  titleRef.current = score.title;

  function indexGraphics(osmd: OpenSheetMusicDisplay, eventKeys: Map<string, string>) {
    lastKeys.current = eventKeys;
    const elems = new Map<string, SVGGElement[]>();
    const boxes: MeasureBox[] = [];
    const scale = UNIT * osmd.zoom;
    const list = osmd.GraphicSheet?.MeasureList ?? [];
    list.forEach((staves, mi) => {
      let minY = Infinity;
      let maxY = -Infinity;
      let x = 0;
      let w = 0;
      staves.forEach((gm, si) => {
        if (!gm) return;
        const ps = gm.PositionAndShape;
        const ax = ps.AbsolutePosition.x;
        const ay = ps.AbsolutePosition.y;
        x = ax * scale;
        w = ps.Size.width * scale;
        minY = Math.min(minY, ay * scale);
        maxY = Math.max(maxY, (ay + 4) * scale);
        const graceCount = new Map<number, number>();
        for (const se of gm.staffEntries) {
          for (const gve of se.graphicalVoiceEntries) {
            const ve = gve.parentVoiceEntry;
            const voiceId = ve.ParentVoice.VoiceId;
            const tick = Math.round(ve.Timestamp.RealValue * 384);
            let key = `${mi}|${si}|${voiceId}|${tick}`;
            if (ve.IsGrace) {
              const g = graceCount.get(voiceId) ?? 0;
              graceCount.set(voiceId, g + 1);
              key += `|g${g}`;
            }
            const id = eventKeys.get(key);
            if (!id) continue;
            for (const gn of gve.notes) {
              const g = (gn as unknown as { getSVGGElement?: () => SVGGElement }).getSVGGElement?.();
              if (!g) continue;
              g.dataset.eid = id;
              g.classList.add('smp-note');
              const arr = elems.get(id) ?? [];
              if (!arr.includes(g)) arr.push(g);
              elems.set(id, arr);
            }
          }
        }
      });
      boxes[mi] = { x, y: minY - 1.5 * scale, w, h: maxY - minY + 3 * scale };
    });
    elemsRef.current = elems;
    measureBoxes.current = boxes;
    // re-apply playing state
    for (const id of playingRef.current) elems.get(id)?.forEach((g) => g.classList.add('playing'));
    for (const id of targetsRef.current) elems.get(id)?.forEach((g) => g.classList.add('target'));
  }

  // selection highlight
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.querySelectorAll('.smp-note.selected').forEach((g) => g.classList.remove('selected'));
    host.querySelectorAll('.smp-notehead-selected').forEach((g) => g.classList.remove('smp-notehead-selected'));
    const box = selBoxRef.current!;
    if (!selection) {
      box.style.display = 'none';
      return;
    }
    if (selection.eventId) {
      const gs = elemsRef.current.get(selection.eventId) ?? [];
      gs.forEach((g) => g.classList.add('selected'));
      if (selection.pitchIdx !== null && gs[0]) {
        const heads = noteheads(gs[0]);
        heads[selection.pitchIdx]?.classList.add('smp-notehead-selected');
      }
    }
    // measure range box
    const a = measureBoxes.current[selection.m0];
    const b = measureBoxes.current[selection.m1];
    if (a && b && (!selection.eventId || selection.m0 !== selection.m1)) {
      box.style.display = 'block';
      if (Math.abs(a.y - b.y) < 2) {
        box.style.left = `${a.x}px`;
        box.style.top = `${a.y}px`;
        box.style.width = `${b.x + b.w - a.x}px`;
        box.style.height = `${a.h}px`;
      } else {
        box.style.left = `${a.x}px`;
        box.style.top = `${a.y}px`;
        box.style.width = `${a.w}px`;
        box.style.height = `${b.y + b.h - a.y}px`;
      }
    } else box.style.display = 'none';
  }, [selection, renderTick]);

  useImperativeHandle(ref, () => ({
    setPlaying(ids, measure, follow) {
      const prev = playingRef.current;
      for (const id of prev) if (!ids.has(id)) elemsRef.current.get(id)?.forEach((g) => g.classList.remove('playing'));
      for (const id of ids) if (!prev.has(id)) elemsRef.current.get(id)?.forEach((g) => g.classList.add('playing'));
      playingRef.current = new Set(ids);
      const cur = cursorRef.current!;
      const box = measure !== null ? measureBoxes.current[measure] : undefined;
      if (!box) {
        cur.style.display = 'none';
        lastFollow.current = -1;
        return;
      }
      cur.style.display = 'block';
      cur.style.left = `${box.x}px`;
      cur.style.top = `${box.y}px`;
      cur.style.width = `${box.w}px`;
      cur.style.height = `${box.h}px`;
      if (follow && measure !== lastFollow.current) {
        lastFollow.current = measure!;
        const scroller = hostRef.current?.closest('.score-scroll') as HTMLElement | null;
        if (scroller) {
          const top = box.y - scroller.scrollTop;
          if (top < 40 || top + box.h > scroller.clientHeight - 40) {
            scroller.scrollTo({ top: Math.max(0, box.y - scroller.clientHeight * 0.25), behavior: 'smooth' });
          }
        }
      }
    },
    measureAtPoint(x, y) {
      return hitMeasure(x, y);
    },
    setTargets(ids) {
      const prev = targetsRef.current;
      for (const id of prev) if (!ids.has(id)) elemsRef.current.get(id)?.forEach((g) => g.classList.remove('target'));
      for (const id of ids) elemsRef.current.get(id)?.forEach((g) => g.classList.add('target'));
      targetsRef.current = new Set(ids);
    },
    measureBoxes() {
      return measureBoxes.current;
    },
  }));

  function hitMeasure(x: number, y: number): number | null {
    const boxes = measureBoxes.current;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return i;
    }
    return null;
  }

  function onClick(ev: React.MouseEvent) {
    if (passive) return;
    const host = hostRef.current!;
    const rect = host.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const additive = ev.shiftKey;
    // nearest note element
    let target = (ev.target as Element).closest?.('.smp-note') as SVGGElement | null;
    if (!target && editMode) target = nearestNote(ev.clientX, ev.clientY, 14);
    const m = hitMeasure(x, y);
    if (target?.dataset.eid) {
      const id = target.dataset.eid;
      const heads = noteheads(target);
      let pIdx: number | null = null;
      if (heads.length > 1) {
        let best = Infinity;
        heads.forEach((h, i) => {
          const r = h.getBoundingClientRect();
          const d = Math.abs(r.top + r.height / 2 - ev.clientY);
          if (d < best) {
            best = d;
            pIdx = i;
          }
        });
      } else if (heads.length === 1) pIdx = 0;
      const mm = m ?? selection?.m0 ?? 0;
      onSelect({ eventId: id, pitchIdx: pIdx, m0: mm, m1: mm }, additive);
      return;
    }
    if (m !== null) onSelect({ eventId: null, pitchIdx: null, m0: m, m1: m }, additive);
    else onSelect(null, false);
  }

  function nearestNote(cx: number, cy: number, maxDist: number): SVGGElement | null {
    let best: SVGGElement | null = null;
    let bestD = maxDist;
    for (const gs of elemsRef.current.values())
      for (const g of gs) {
        const r = g.getBoundingClientRect();
        const dx = Math.max(r.left - cx, 0, cx - r.right);
        const dy = Math.max(r.top - cy, 0, cy - r.bottom);
        const d = Math.hypot(dx, dy);
        if (d < bestD) {
          bestD = d;
          best = g;
        }
      }
    return best;
  }

  return (
    <div className={`score-paper ${editMode ? 'editing' : ''} ${paper ? `paper-${paper}` : ''}`}>
      {error && <div className="render-error">Could not draw this score: {error}</div>}
      <div className="score-host-wrap" onClick={onClick}>
        <div ref={hostRef} className="score-host" />
        <div ref={cursorRef} className="play-cursor" />
        <div ref={selBoxRef} className="sel-box" />
      </div>
    </div>
  );
});

let defaultTitleHeight = 0;
/** Shrink the title font so long titles fit on narrow (phone) screens. */
function fitTitle(osmd: OpenSheetMusicDisplay, title: string, widthPx: number, zoom: number) {
  const rules = osmd.EngravingRules;
  if (!defaultTitleHeight) defaultTitleHeight = rules.SheetTitleHeight;
  const availUnits = (widthPx / (UNIT * zoom)) * 0.92;
  const est = Math.max(1, title.length) * 0.5; // average glyph width ≈ 0.5 × font height
  rules.SheetTitleHeight = Math.max(1.6, Math.min(defaultTitleHeight, availUnits / est));
}

/** Noteheads in a VexFlow note group, ordered lowest pitch first. */
function noteheads(g: SVGGElement): Element[] {
  const heads = [...g.querySelectorAll('.vf-notehead')];
  return heads.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
}
