import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icons';
import { prepareImage, PreparedImage } from '../omr/image';
import { extrasConfig, scanPages } from '../omr/client';
import { TranscribeProgress } from '../omr/transcribe';
import { Score } from '../model/types';
import { Settings } from '../storage';
import { isPdf } from '../importers/pdf';

interface PageItem {
  key: string;
  file: File;
  rotate: number;
  /** where a page rendered from a PDF came from, e.g. "Sonata.pdf, p. 3" */
  source?: string;
  prepared?: PreparedImage;
  error?: string;
}

interface Props {
  settings: Settings;
  onSettings: (s: Settings) => void;
  onDone: (scores: Score[]) => void;
  onCancel: () => void;
  onNeedKey: () => void;
  initialFiles?: File[];
}

const isImage = (f: File) => f.type.startsWith('image/') || /\.(heic|heif|jpe?g|png|webp)$/i.test(f.name);
const newKey = () => Math.random().toString(36).slice(2);

const PHASE_LABEL: Record<TranscribeProgress['phase'], string> = {
  sending: 'Uploading…',
  thinking: 'Reading the page…',
  writing: 'Writing notes…',
  done: 'Done',
};

export function ScanView({ settings, onSettings, onDone, onCancel, onNeedKey, initialFiles }: Props) {
  const [pages, setPages] = useState<PageItem[]>([]);
  const [combine, setCombine] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Record<string, TranscribeProgress>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** a PDF whose pages are being drawn */
  const [opening, setOpening] = useState<{ name: string; done: number; count: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const openAbort = useRef(new AbortController());
  useEffect(() => () => openAbort.current.abort(), []);
  const [localMB, setLocalMB] = useState(0);
  useEffect(() => {
    void import('../omr/local').then((m) => m.localDownloadMB()).then(setLocalMB);
  }, []);
  // reading on the device stops if the phone locks, so keep the screen awake while busy
  useEffect(() => {
    if (!busy) return;
    type Lock = { release: () => Promise<void> };
    const wl = (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<Lock> } }).wakeLock;
    let lock: Lock | null = null;
    let gone = false;
    const take = () => void wl?.request('screen').then((l) => (gone ? void l.release() : (lock = l))).catch(() => undefined);
    const onVisible = () => document.visibilityState === 'visible' && take();
    take();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      gone = true;
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release().catch(() => undefined);
    };
  }, [busy]);
  const [started, setStarted] = useState(0);
  const [now, setNow] = useState(Date.now());
  const abortRef = useRef<AbortController | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const pickRef = useRef<HTMLInputElement>(null);
  const pdfRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (initialFiles?.length) void addFiles(initialFiles);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [busy]);

  async function prepare(it: PageItem) {
    try {
      const prepared = await prepareImage(it.file, 0);
      setPages((p) => p.map((x) => (x.key === it.key ? { ...x, prepared } : x)));
    } catch {
      setPages((p) => p.map((x) => (x.key === it.key ? { ...x, error: 'Could not open this image' } : x)));
    }
  }

  /** Each page of the PDF becomes a page to scan, added as soon as it is drawn. */
  async function addPdf(file: File) {
    const name = file.name || 'PDF';
    setOpening({ name, done: 0, count: 0 });
    const prepping: Promise<void>[] = [];
    try {
      const { renderPdfPages } = await import('../importers/pdf');
      const info = await renderPdfPages(
        file,
        (page, i, info) => {
          const it: PageItem = { key: newKey(), file: page, rotate: 0, source: info.total > 1 ? `${name}, p. ${i + 1}` : name };
          setPages((p) => [...p, it]);
          setOpening({ name, done: i + 1, count: info.count });
          prepping.push(prepare(it));
        },
        { signal: openAbort.current.signal, onInfo: (info) => setOpening({ name, done: 0, count: info.count }) },
      );
      await Promise.all(prepping);
      if (!info.total) setError(`“${name}” has no pages.`);
      else if (info.total > info.count)
        setNotice(`“${name}” has ${info.total} pages; the first ${info.count} were added. To scan the rest, remove these pages when they are done and open the PDF again, or split it into smaller PDFs.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== 'Cancelled') setError(`${name}: ${msg}`);
    } finally {
      setOpening(null);
    }
  }

  /** Photos and PDFs, kept in the order given. */
  async function addFiles(list: FileList | File[] | null) {
    const files = [...(list ?? [])];
    if (!files.length) return;
    setError(null);
    setNotice(null);
    const skipped = files.filter((f) => !isPdf(f) && !isImage(f));
    if (skipped.length) setError(`Only photos and PDFs can be scanned (skipped ${skipped.map((f) => f.name).join(', ')}). Open MusicXML, MIDI and ABC files with Import in the library.`);
    const images: PageItem[] = [];
    for (const f of files) {
      if (isPdf(f)) await addPdf(f);
      else if (isImage(f)) {
        const it: PageItem = { key: newKey(), file: f, rotate: 0 };
        images.push(it);
        setPages((p) => [...p, it]);
      }
    }
    for (const it of images) await prepare(it);
  }

  async function rotate(key: string) {
    const it = pages.find((p) => p.key === key);
    if (!it) return;
    const r = (it.rotate + 90) % 360;
    const prepared = await prepareImage(it.file, r);
    setPages((p) => p.map((x) => (x.key === key ? { ...x, rotate: r, prepared } : x)));
  }

  function move(i: number, d: number) {
    setPages((p) => {
      const j = i + d;
      if (j < 0 || j >= p.length) return p;
      const c = [...p];
      [c[i], c[j]] = [c[j], c[i]];
      return c;
    });
  }

  async function run() {
    const ready = pages.filter((p) => p.prepared);
    if (!ready.length) return;
    setBusy(true);
    setError(null);
    setStarted(Date.now());
    setProgress({});
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const groups: PageItem[][] = combine ? [ready] : ready.map((p) => [p]);
      const scanGroup = async (group: PageItem[]) => {
          const { score, warnings, repaired } = await scanPages(
            group.map((g) => g.prepared!.image),
            settings,
            (p) => setProgress((cur) => ({ ...cur, [group[p.page]?.key ?? '']: p.progress })),
            ac.signal,
          );
          score.source = settings.engine;
          if (repaired.length) score.notes = [...(score.notes ?? []), `Rhythm was auto-corrected in measure${repaired.length > 1 ? 's' : ''} ${repaired.map((i) => i + 1).slice(0, 12).join(', ')}${repaired.length > 12 ? '…' : ''} – worth a check.`];
          if (warnings.length) score.notes = [...(score.notes ?? []), ...warnings.slice(0, 5)];
          return score;
      };
      let scores: Score[] = [];
      if (settings.engine === 'local') {
        // reading on the device is heavy: one piece at a time
        for (const group of groups) scores.push(await scanGroup(group));
      } else scores = await Promise.all(groups.map(scanGroup));
      onDone(scores);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === 'NO_KEY') {
        setError(
          settings.engine === 'compat'
            ? 'Add your OpenRouter / DeepInfra API key and model in Settings.'
            : 'To scan music, add your Claude API key in Settings (or run the server with ANTHROPIC_API_KEY).',
        );
        onNeedKey();
      } else if (msg !== 'Cancelled') setError(msg);
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  const extras = extrasConfig(settings);
  const elapsed = Math.max(0, Math.round((now - started) / 1000));
  const readyCount = pages.filter((p) => p.prepared).length;

  return (
    <div
      className={`scan-view${dragging ? ' dragging' : ''}`}
      onDragOver={(e) => {
        if (busy || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        if (busy) return;
        e.preventDefault();
        setDragging(false);
        void addFiles(e.dataTransfer.files);
      }}
    >
      <header className="topbar">
        <button className="icon-btn" onClick={() => (busy ? abortRef.current?.abort() : onCancel())} aria-label="Back">
          <Icon.back />
        </button>
        <h1>Scan sheet music</h1>
        <span className="grow" />
      </header>

      <div className="scan-body">
        {!pages.length && (
          <div className="scan-empty">
            <div className="scan-hero" aria-hidden>
              <Icon.camera size={42} />
            </div>
            <h2>Photograph your music</h2>
            <p>Take one photo per page, in good light and as flat and square-on as you can, or open a PDF of the score (every page is added). Add several pages to scan them as one piece.</p>
          </div>
        )}

        {pages.length > 0 && (
          <ol className="page-list">
            {pages.map((p, i) => {
              const pr = progress[p.key];
              return (
                <li key={p.key} className="page-item">
                  <div className="page-thumb">
                    {p.prepared ? <img src={p.prepared.thumb} alt={`Page ${i + 1}`} /> : <div className="thumb-loading">{p.error ?? 'Loading…'}</div>}
                    <span className="page-num">{i + 1}</span>
                  </div>
                  <div className="page-meta">
                    <div className="page-name">{combine ? `Page ${i + 1}` : `Piece ${i + 1}`}</div>
                    {p.source && !busy && <div className="page-source">{p.source}</div>}
                    {busy && (
                      <div className="page-progress">
                        <div className={`spinner ${pr?.phase === 'done' ? 'done' : ''}`} />
                        <span>
                          {pr ? pr.label ?? PHASE_LABEL[pr.phase] : settings.engine !== 'local' && combine && i > 0 ? (progress[pages[0].key]?.phase === 'done' ? 'Waiting…' : 'Waiting for page 1…') : 'Starting…'}
                          {pr && !pr.label && pr.measures > 0 && pr.phase !== 'done' ? ` ${pr.measures} measures` : ''}
                          {pr?.phase === 'done' ? ` · ${pr.measures} measures` : ''}
                        </span>
                      </div>
                    )}
                  </div>
                  {!busy && (
                    <div className="page-actions">
                      <button className="icon-btn sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up"><Icon.up size={18} /></button>
                      <button className="icon-btn sm" onClick={() => move(i, 1)} disabled={i === pages.length - 1} aria-label="Move down"><Icon.down size={18} /></button>
                      <button className="icon-btn sm" onClick={() => rotate(p.key)} aria-label="Rotate"><Icon.rotate size={18} /></button>
                      <button className="icon-btn sm danger" onClick={() => setPages((x) => x.filter((y) => y.key !== p.key))} aria-label="Remove"><Icon.trash size={18} /></button>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}

        {!busy && (
          <div className="scan-add">
            <button className="btn primary big" onClick={() => cameraRef.current?.click()}>
              <Icon.camera /> {pages.length ? 'Take another photo' : 'Take photo'}
            </button>
            <button className="btn big" onClick={() => pickRef.current?.click()}>
              <Icon.image /> Choose from photos
            </button>
            <button className="btn big" onClick={() => pdfRef.current?.click()} disabled={!!opening}>
              <Icon.file /> Open a PDF
            </button>
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }} />
            <input ref={pickRef} type="file" accept="image/*" multiple hidden onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }} />
            <input ref={pdfRef} type="file" accept="application/pdf,.pdf" multiple hidden onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }} />
          </div>
        )}
        {opening && (
          <div className="page-progress opening">
            <div className="spinner" />
            <span>Opening {opening.name}{opening.count ? ` – page ${Math.min(opening.done + 1, opening.count)} of ${opening.count}` : ''}…</span>
          </div>
        )}
        {notice && <div className="alert">{notice}</div>}
        {pages.length > 3 && !busy && !opening && (
          <p className="hint"><button className="link" onClick={() => setPages([])}>Remove all {pages.length} pages</button></p>
        )}

        {pages.length > 1 && !busy && (
          <div className="seg" role="radiogroup" aria-label="How to treat the photos">
            <button className={combine ? 'on' : ''} onClick={() => setCombine(true)} role="radio" aria-checked={combine}>
              One piece ({pages.length} pages)
            </button>
            <button className={!combine ? 'on' : ''} onClick={() => setCombine(false)} role="radio" aria-checked={!combine}>
              {pages.length} separate pieces
            </button>
          </div>
        )}
        {pages.length > 1 && combine && !busy && <p className="hint">Put the pages in order. If they have printed page numbers they'll be sorted automatically.</p>}

        {pages.length > 0 && !busy && (
          <div className="field-row">
            <label htmlFor="reader">Read with</label>
            <select id="reader" value={settings.engine} onChange={(e) => onSettings({ ...settings, engine: e.target.value as Settings['engine'] })}>
              <option value="local">This device – free, private</option>
              <option value="claude">Claude</option>
              <option value="compat">Other AI model</option>
              <option value="audiveris">Audiveris (server)</option>
            </select>
          </div>
        )}
        {pages.length > 0 && !busy && settings.engine === 'local' && (
          <p className="hint">Reads the notes and rhythms on your device; nothing is uploaded. About 1–3 minutes a page{localMB ? `; the first time it downloads about ${localMB} MB, so use Wi‑Fi` : ''}. Flat, sharp, evenly lit photos read best.{' '}
            {extras
              ? `Then the photo is sent to ${extras.model} for the ${[settings.extrasInfo && 'title and tempo', settings.extrasChords && 'chord symbols', settings.extrasLyrics && 'lyrics'].filter(Boolean).join(', ')}.`
              : settings.localExtras
                ? <>To also get the title, chord symbols and lyrics, <button className="link" onClick={onNeedKey}>add an OpenRouter key in Settings</button>.</>
                : ''}
          </p>
        )}
        {pages.length > 0 && !busy && settings.engine === 'claude' && (
          <div className="field-row">
            <label htmlFor="acc">Accuracy</label>
            <select id="acc" value={settings.effort} onChange={(e) => onSettings({ ...settings, effort: e.target.value as Settings['effort'] })}>
              <option value="medium">Quick</option>
              <option value="high">Careful (recommended)</option>
              <option value="xhigh">Very careful (slowest)</option>
            </select>
          </div>
        )}

        {error && <div className="alert error">{error}</div>}

        {busy && (
          <p className="hint center">
            {settings.engine === 'local'
              ? 'Reading on this device – keep this screen open. A page usually takes 1–3 minutes.'
              : `${settings.engine === 'audiveris' ? 'Audiveris is reading your music' : settings.engine === 'compat' ? 'The model is reading your music' : 'Claude is reading your music'} – a dense page usually takes 1–4 minutes.`}{' '}
            ({Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')})
          </p>
        )}
      </div>

      <footer className="scan-footer">
        {busy ? (
          <button className="btn big" onClick={() => abortRef.current?.abort()}>Cancel</button>
        ) : (
          <button className="btn primary big wide" disabled={!readyCount || !!opening} onClick={run}>
            <Icon.music /> {readyCount > 1 ? (combine ? `Scan ${readyCount} pages` : `Scan ${readyCount} pieces`) : 'Scan music'}
          </button>
        )}
      </footer>
    </div>
  );
}
