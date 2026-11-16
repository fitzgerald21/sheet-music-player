import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Icon } from './Icons';
import { loadPages, savePages, base64Page, StoredPage } from '../pages';
import { layoutOfImage, mapMeasures } from '../omr/layout';
import { prepareImage } from '../omr/image';
import { pdfToImages } from '../importers/pdf';

export interface OriginalHandle {
  /** put the cursor on a measure, `frac` of the way through it (null hides it) */
  show(measure: number | null, frac: number): void;
  /** scroll by most of a screen */
  turn(dir: 1 | -1): void;
}

interface Props {
  scoreId: string;
  /** how many measures the score has */
  total: number;
  /** 1 = as wide as the screen */
  scale: number;
  /** the element that scrolls */
  scroller: React.RefObject<HTMLDivElement | null>;
}

/** The photos or PDF pages the score was read from, with a cursor that follows the music across them. */
export const OriginalPages = forwardRef<OriginalHandle, Props>(function OriginalPages({ scoreId, total, scale, scroller }, ref) {
  const [pages, setPages] = useState<StoredPage[] | null>(null);
  const [busy, setBusy] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const pageEls = useRef<(HTMLDivElement | null)[]>([]);
  const cursors = useRef<(HTMLDivElement | null)[]>([]);
  const lastLine = useRef('');

  // load the pages, and work out where the music is on any that have not been looked at yet
  useEffect(() => {
    let gone = false;
    setPages(null);
    void (async () => {
      const stored = await loadPages(scoreId);
      if (stored.some((p) => !p.layout)) {
        if (!gone) setBusy('Finding the lines of music on the pages…');
        for (const p of stored) p.layout ??= await layoutOfImage(new Blob([p.data], { type: p.type })).catch(() => ({ systems: [] }));
        void savePages(scoreId, stored);
      }
      if (gone) return;
      setBusy('');
      setPages(stored);
    })();
    return () => {
      gone = true;
    };
  }, [scoreId]);

  const urls = useMemo(() => (pages ?? []).map((p) => URL.createObjectURL(new Blob([p.data], { type: p.type }))), [pages]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);

  const map = useMemo(() => mapMeasures((pages ?? []).map((p) => p.layout ?? { systems: [] }), total), [pages, total]);

  useImperativeHandle(ref, () => ({
    show(measure, frac) {
      const box = measure !== null ? map.boxes[measure] : undefined;
      const page = box ? pageEls.current[box.page] : null;
      const el = box ? cursors.current[box.page] : null;
      for (const c of cursors.current) if (c && c !== el) c.style.display = 'none';
      if (!el || !box || !page) {
        lastLine.current = '';
        return;
      }
      el.style.display = 'block';
      el.style.left = `${box.x * 100}%`;
      el.style.top = `${box.y * 100}%`;
      el.style.width = `${box.w * 100}%`;
      el.style.height = `${box.h * 100}%`;
      el.style.setProperty('--at', `${Math.min(1, Math.max(0, frac)) * 100}%`);
      // a new line of music: bring it (and the one after) into view
      const line = `${box.page}:${box.y}`;
      const sc = scroller.current;
      if (line === lastLine.current || !sc) return;
      lastLine.current = line;
      const pr = page.getBoundingClientRect();
      const sr = sc.getBoundingClientRect();
      const top = pr.top - sr.top + sc.scrollTop + box.y * pr.height;
      const height = box.h * pr.height;
      if (top < sc.scrollTop + 40 || top + height * 2.1 > sc.scrollTop + sc.clientHeight) sc.scrollTo({ top: Math.max(0, top - sc.clientHeight * 0.18), behavior: 'smooth' });
    },
    turn(dir) {
      const sc = scroller.current;
      sc?.scrollBy({ top: dir * sc.clientHeight * 0.8, behavior: 'smooth' });
    },
  }), [map, scroller]);

  const addFiles = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    try {
      const images: Blob[] = [];
      for (const f of files) {
        if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
          setBusy('Opening the PDF…');
          images.push(...(await pdfToImages(f, (done, n) => setBusy(`Opening the PDF… page ${done} of ${n}`))));
        } else images.push(f);
      }
      const stored: StoredPage[] = [];
      for (const [i, img] of images.entries()) {
        setBusy(`Finding the lines of music… page ${i + 1} of ${images.length}`);
        const page = base64Page((await prepareImage(img)).image.data, 'image/jpeg');
        page.layout = await layoutOfImage(new Blob([page.data], { type: page.type })).catch(() => ({ systems: [] }));
        stored.push(page);
      }
      await savePages(scoreId, stored);
      setPages(stored);
    } catch (e) {
      alert(`Could not open that: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy('');
    }
  }, [scoreId]);

  const picker = <input ref={fileRef} type="file" accept="image/*,application/pdf,.pdf" multiple hidden onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }} />;

  if (busy || pages === null) return <div className="orig-empty"><div className="spinner" /><p>{busy || 'Loading the pages…'}</p></div>;
  if (!pages.length)
    return (
      <div className="orig-empty" onClick={(e) => e.stopPropagation()}>
        <div className="scan-hero"><Icon.image size={38} /></div>
        <h2>Play from the printed page</h2>
        <p>Add the photos or the PDF this piece came from, and a cursor follows the music on the pages themselves while you play. Pieces you scan from now on keep their pages automatically.</p>
        <button className="btn primary big" onClick={() => fileRef.current?.click()}><Icon.upload size={18} /> Add photos or a PDF</button>
        {picker}
      </div>
    );
  return (
    <div className="orig" style={{ width: `${scale * 100}%` }}>
      {!map.exact && (
        <p className="orig-note" onClick={(e) => e.stopPropagation()}>
          {map.found
            ? `The pages show ${map.found} measures and the score has ${total}, so the cursor follows the right line of music but not always the exact measure.`
            : 'No lines of music could be found on these pages, so there is nothing for the cursor to follow. Flat, sharp pages work best.'}
        </p>
      )}
      {urls.map((u, i) => (
        <div key={u} className="orig-page" ref={(el) => { pageEls.current[i] = el; }}>
          <img src={u} alt={`Page ${i + 1}`} draggable={false} />
          <div className="orig-cursor" ref={(el) => { cursors.current[i] = el; }} />
        </div>
      ))}
      <p className="orig-foot" onClick={(e) => e.stopPropagation()}>
        <button className="link" onClick={() => fileRef.current?.click()}>Use different pages</button>
        {picker}
      </p>
    </div>
  );
});
