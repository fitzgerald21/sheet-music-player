import { useEffect, useRef, useState } from 'react';
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import { Icon } from './Icons';
import { toMusicXML } from '../model/musicxml';
import { Score, cloneScore } from '../model/types';
import { keyName } from '../model/pitch';

interface Props {
  score: Score;
  onBack: () => void;
}

type Paper = 'Letter' | 'A4';
const PAPER_PX: Record<Paper, { w: number; h: number; css: string }> = {
  Letter: { w: 816, h: 1056, css: 'letter' },
  A4: { w: 794, h: 1123, css: 'A4' },
};

export function PrintView({ score, onBack }: Props) {
  const [paper, setPaper] = useState<Paper>(() => (navigator.language?.startsWith('en-US') || navigator.language === 'en' ? 'Letter' : 'A4'));
  const [scale, setScale] = useState(0.85);
  const [showTitle, setShowTitle] = useState(true);
  const [chords, setChords] = useState(true);
  const [lyrics, setLyrics] = useState(true);
  const [measureNumbers, setMeasureNumbers] = useState(true);
  const [partNames, setPartNames] = useState(score.parts.length > 1);
  const [parts, setParts] = useState(() => score.parts.map((p) => !p.hidden));
  const [pages, setPages] = useState(0);
  const [busy, setBusy] = useState(true);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current!;
    host.innerHTML = '';
    host.style.width = `${PAPER_PX[paper].w}px`;
    setBusy(true);
    const s = cloneScore(score);
    s.parts.forEach((p, i) => (p.hidden = !parts[i]));
    if (!s.parts.some((p) => !p.hidden)) s.parts[0].hidden = false;
    if (!chords) for (const m of s.measures) delete m.chords;
    if (!lyrics) for (const m of s.measures) for (const st of m.staves) for (const v of st.voices) for (const e of v) delete e.lyric;
    const osmd = new OpenSheetMusicDisplay(host, {
      backend: 'svg',
      autoResize: false,
      pageFormat: `${paper}_P`,
      pageBackgroundColor: '#FFFFFF',
      drawTitle: showTitle,
      drawSubtitle: showTitle,
      drawComposer: showTitle,
      drawLyricist: showTitle,
      drawCredits: showTitle,
      drawPartNames: partNames,
      drawMeasureNumbers: measureNumbers,
      autoBeam: true,
      disableCursor: true,
      newPageFromXML: false,
    });
    osmd.EngravingRules.RenderMultipleRestMeasures = true;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        await osmd.load(toMusicXML(s, { chordText: true }).xml);
        if (cancelled) return;
        osmd.zoom = scale;
        osmd.render();
        const svgs = host.querySelectorAll('svg');
        svgs.forEach((svg) => svg.parentElement?.classList.add('print-page'));
        setPages(svgs.length);
      } catch (e) {
        console.error(e);
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, 30);
    return () => {
      cancelled = true;
      clearTimeout(t);
      osmd.clear();
    };
  }, [score, paper, scale, showTitle, chords, lyrics, measureNumbers, partNames, parts]);

  const hasChords = score.measures.some((m) => m.chords?.length);
  const hasLyrics = score.measures.some((m) => m.staves.some((st) => st.voices.some((v) => v.some((e) => e.lyric))));

  return (
    <div className="print-view">
      <style>{`@page { size: ${PAPER_PX[paper].css} portrait; margin: 0; }`}</style>
      <header className="topbar no-print">
        <button className="icon-btn" onClick={onBack} aria-label="Back"><Icon.back /></button>
        <h1>Print</h1>
        <span className="grow" />
        <span className="hint hide-xs">{busy ? 'Laying out…' : `${pages} page${pages === 1 ? '' : 's'} · ${keyName(score.key).split(' /')[0]}`}</span>
        <button className="btn primary" onClick={() => window.print()} disabled={busy}><Icon.download size={16} /> Print / Save PDF</button>
      </header>
      <div className="print-options no-print">
        <div className="seg compact" role="radiogroup" aria-label="Paper size">
          {(['Letter', 'A4'] as Paper[]).map((p) => (
            <button key={p} className={paper === p ? 'on' : ''} onClick={() => setPaper(p)} role="radio" aria-checked={paper === p}>{p}</button>
          ))}
        </div>
        <label className="inline">
          Staff size
          <input type="range" min={0.5} max={1.3} step={0.05} value={scale} onChange={(e) => setScale(+e.target.value)} />
        </label>
        <label className="check"><input type="checkbox" checked={showTitle} onChange={(e) => setShowTitle(e.target.checked)} /> Title</label>
        {hasChords && <label className="check"><input type="checkbox" checked={chords} onChange={(e) => setChords(e.target.checked)} /> Chord symbols</label>}
        {hasLyrics && <label className="check"><input type="checkbox" checked={lyrics} onChange={(e) => setLyrics(e.target.checked)} /> Lyrics</label>}
        <label className="check"><input type="checkbox" checked={measureNumbers} onChange={(e) => setMeasureNumbers(e.target.checked)} /> Measure numbers</label>
        {score.parts.length > 1 && (
          <>
            <label className="check"><input type="checkbox" checked={partNames} onChange={(e) => setPartNames(e.target.checked)} /> Part names</label>
            <span className="opt-sep" />
            {score.parts.map((p, i) => (
              <label key={p.id} className="check">
                <input type="checkbox" checked={parts[i]} onChange={(e) => setParts(parts.map((x, j) => (j === i ? e.target.checked : x)))} /> {p.name}
              </label>
            ))}
          </>
        )}
      </div>
      <div className="print-scroll">
        <div ref={hostRef} className="print-host" />
      </div>
    </div>
  );
}
