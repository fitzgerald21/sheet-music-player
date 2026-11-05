import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icons';
import { prepareImage, PreparedImage } from '../omr/image';
import { scanPages } from '../omr/client';
import { TranscribeProgress } from '../omr/transcribe';
import { Score } from '../model/types';
import { Settings } from '../storage';

interface PageItem {
  key: string;
  file: File;
  rotate: number;
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
  const [started, setStarted] = useState(0);
  const [now, setNow] = useState(Date.now());
  const abortRef = useRef<AbortController | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const pickRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (initialFiles?.length) {
      const dt = new DataTransfer();
      initialFiles.forEach((f) => dt.items.add(f));
      void addFiles(dt.files);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [busy]);

  async function addFiles(files: FileList | null) {
    if (!files?.length) return;
    const items: PageItem[] = [...files].filter((f) => f.type.startsWith('image/') || /\.(heic|jpe?g|png|webp)$/i.test(f.name)).map((file) => ({ key: Math.random().toString(36).slice(2), file, rotate: 0 }));
    setPages((p) => [...p, ...items]);
    for (const it of items) {
      try {
        const prepared = await prepareImage(it.file, 0);
        setPages((p) => p.map((x) => (x.key === it.key ? { ...x, prepared } : x)));
      } catch {
        setPages((p) => p.map((x) => (x.key === it.key ? { ...x, error: 'Could not open this image' } : x)));
      }
    }
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
      const scores = await Promise.all(
        groups.map(async (group) => {
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
        }),
      );
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

  const elapsed = Math.max(0, Math.round((now - started) / 1000));
  const readyCount = pages.filter((p) => p.prepared).length;

  return (
    <div className="scan-view">
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
            <p>Take one photo per page, in good light and as flat and square-on as you can. Add several pages to scan them as one piece.</p>
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
                    {busy && (
                      <div className="page-progress">
                        <div className={`spinner ${pr?.phase === 'done' ? 'done' : ''}`} />
                        <span>
                          {pr ? PHASE_LABEL[pr.phase] : combine && i > 0 ? 'Waiting for page 1…' : 'Starting…'}
                          {pr && pr.measures > 0 && pr.phase !== 'done' ? ` ${pr.measures} measures` : ''}
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
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }} />
            <input ref={pickRef} type="file" accept="image/*" multiple hidden onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }} />
          </div>
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
            {settings.engine === 'audiveris' ? 'Audiveris is reading your music' : settings.engine === 'compat' ? 'The model is reading your music' : 'Claude is reading your music'} – a dense page usually takes 1–4 minutes. ({Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')})
          </p>
        )}
      </div>

      <footer className="scan-footer">
        {busy ? (
          <button className="btn big" onClick={() => abortRef.current?.abort()}>Cancel</button>
        ) : (
          <button className="btn primary big wide" disabled={!readyCount} onClick={run}>
            <Icon.music /> {readyCount > 1 ? (combine ? `Scan ${readyCount} pages` : `Scan ${readyCount} pieces`) : 'Scan music'}
          </button>
        )}
      </footer>
    </div>
  );
}
