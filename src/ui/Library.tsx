import { useMemo, useRef, useState } from 'react';
import { Icon } from './Icons';
import { LibraryEntry } from '../storage';
import { IMPORT_ACCEPT } from '../importers';
import { PracticeSummary } from '../practiceLog';

interface Props {
  entries: LibraryEntry[];
  practice: PracticeSummary;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onScan: () => void;
  onDemo: () => void;
  onImport: (file: File) => void;
  onSettings: () => void;
  onFind: () => void;
  needsKey: boolean;
}

type Sort = 'recent' | 'title' | 'practised';

/** A colour for a piece's cover that stays the same every time: a hue from its title. */
function hueOf(text: string): number {
  let h = 7;
  for (const c of text) h = (h * 31 + c.codePointAt(0)!) % 360;
  return h;
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? 'Still up?' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export function Library({ entries, practice, onOpen, onDelete, onScan, onDemo, onImport, onSettings, onFind, needsKey }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('recent');
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = entries.filter((e) => !q || e.title.toLowerCase().includes(q) || (e.composer ?? '').toLowerCase().includes(q));
    if (sort === 'title') list.sort((a, b) => a.title.localeCompare(b.title));
    if (sort === 'practised') list.sort((a, b) => (practice.pieces.get(b.id)?.last ?? 0) - (practice.pieces.get(a.id)?.last ?? 0));
    return list;
  }, [entries, query, sort, practice]);

  return (
    <div className="library">
      <header className="topbar">
        <div className="brand"><span className="brand-mark"><Icon.music size={18} /></span> <span>Sheet Music Player</span></div>
        <span className="grow" />
        <button className="icon-btn" onClick={onSettings} aria-label="Settings"><Icon.settings /></button>
      </header>
      <main className="library-body">
        <section className="hero-card">
          <p className="hero-kicker">{greeting()}</p>
          <h1>Turn a photo of sheet music into a score you can play and edit.</h1>
          <p>Photograph one page or several, or open a PDF, MusicXML, MIDI or ABC file. Then play it back, practise along on your piano, transpose it, add chords, print it, and fix anything by hand.</p>
          <div className="hero-actions">
            <button className="btn primary big" onClick={onScan}><Icon.camera /> Scan music</button>
            <button className="btn big" onClick={onFind}><Icon.library size={18} /> Find music</button>
            <button className="btn big" onClick={onDemo}><Icon.play size={18} /> Try a demo</button>
          </div>
          {needsKey && (
            <p className="hint warn-text">
              Scanning needs an API key (or Audiveris on your server). <button className="link" onClick={onSettings}>Set it up in Settings</button>.
            </p>
          )}
        </section>

        {practice.pieces.size > 0 && (
          <section className="stats" aria-label="Your practice">
            <div className="stat"><span className="stat-num">{practice.streak}</span><span className="stat-label">{practice.streak === 1 ? 'day in a row' : 'days in a row'}</span></div>
            <div className="stat"><span className="stat-num">{practice.minutesThisWeek}</span><span className="stat-label">{practice.minutesThisWeek === 1 ? 'minute this week' : 'minutes this week'}</span></div>
            <div className="stat"><span className="stat-num">{practice.pieces.size}</span><span className="stat-label">{practice.pieces.size === 1 ? 'piece practised' : 'pieces practised'}</span></div>
          </section>
        )}

        <section>
          <div className="section-head">
            <h2>Your music</h2>
            <span className="grow" />
            {entries.length > 1 && (
              <select className="sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort by">
                <option value="recent">Newest first</option>
                <option value="title">By title</option>
                <option value="practised">Last practised</option>
              </select>
            )}
            <button className="btn sm" onClick={() => fileRef.current?.click()}><Icon.upload size={16} /> Import</button>
            <input ref={fileRef} type="file" accept={IMPORT_ACCEPT} hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onImport(f); e.target.value = ''; }} />
          </div>
          {entries.length > 5 && <input className="search" type="search" placeholder="Search your music" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search your music" />}
          {entries.length === 0 ? (
            <p className="empty">Nothing yet. Scanned and imported pieces are saved here automatically, on this device. Import opens MusicXML (.musicxml/.mxl), MIDI, ABC, PDF and images.</p>
          ) : shown.length === 0 ? (
            <p className="empty">Nothing matches “{query}”.</p>
          ) : (
            <ul className="score-grid">
              {shown.map((e) => {
                const p = practice.pieces.get(e.id);
                return (
                  <li key={e.id} className="score-card">
                    <button className="score-open" onClick={() => onOpen(e.id)}>
                      <span className="cover" style={{ '--h': hueOf(e.title) } as React.CSSProperties}>
                        <span className="cover-letter">{e.title.trim()[0]?.toUpperCase() ?? '♪'}</span>
                        {p?.best !== undefined && <span className="cover-badge">Best {p.best}%</span>}
                      </span>
                      <span className="score-title">{e.title}</span>
                      <span className="score-sub">{[e.composer, `${e.measures} measures`].filter(Boolean).join(' · ')}</span>
                      <span className="score-sub">{p ? `Practised ${p.sessions} ${p.sessions === 1 ? 'time' : 'times'}` : `Added ${new Date(e.updated).toLocaleDateString()}`}</span>
                    </button>
                    <button className="icon-btn sm danger card-delete" aria-label={`Delete ${e.title}`} onClick={() => { if (confirm(`Delete “${e.title}”?`)) onDelete(e.id); }}><Icon.trash size={16} /></button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
