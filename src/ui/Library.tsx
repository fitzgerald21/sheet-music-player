import { useRef } from 'react';
import { Icon } from './Icons';
import { LibraryEntry } from '../storage';

interface Props {
  entries: LibraryEntry[];
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onScan: () => void;
  onDemo: () => void;
  onImport: (file: File) => void;
  onSettings: () => void;
  needsKey: boolean;
}

export function Library({ entries, onOpen, onDelete, onScan, onDemo, onImport, onSettings, needsKey }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div className="library">
      <header className="topbar">
        <div className="brand"><Icon.music size={22} /> <span>Sheet Music Player</span></div>
        <span className="grow" />
        <button className="icon-btn" onClick={onSettings} aria-label="Settings"><Icon.settings /></button>
      </header>
      <main className="library-body">
        <section className="hero-card">
          <h1>Turn a photo of sheet music into a score you can play and edit.</h1>
          <p>Photograph one page or several. Claude reads the notes, then you can play the music back, change the tempo, transpose it and fix anything by hand.</p>
          <div className="hero-actions">
            <button className="btn primary big" onClick={onScan}><Icon.camera /> Scan music</button>
            <button className="btn big" onClick={onDemo}><Icon.play size={18} /> Try a demo</button>
          </div>
          {needsKey && (
            <p className="hint warn-text">
              Scanning needs a Claude API key. <button className="link" onClick={onSettings}>Add it in Settings</button>.
            </p>
          )}
        </section>

        <section>
          <div className="section-head">
            <h2>Your music</h2>
            <span className="grow" />
            <button className="btn sm" onClick={() => fileRef.current?.click()}><Icon.upload size={16} /> Import</button>
            <input ref={fileRef} type="file" accept=".json,.smp.json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onImport(f); e.target.value = ''; }} />
          </div>
          {entries.length === 0 ? (
            <p className="empty">Nothing yet. Scanned pieces are saved here automatically, on this device.</p>
          ) : (
            <ul className="score-list">
              {entries.map((e) => (
                <li key={e.id}>
                  <button className="score-item" onClick={() => onOpen(e.id)}>
                    <span className="score-icon"><Icon.music size={20} /></span>
                    <span className="score-text">
                      <span className="score-title">{e.title}</span>
                      <span className="score-sub">{[e.composer, `${e.measures} measures`, new Date(e.updated).toLocaleDateString()].filter(Boolean).join(' · ')}</span>
                    </span>
                  </button>
                  <button className="icon-btn sm danger" aria-label={`Delete ${e.title}`} onClick={() => { if (confirm(`Delete “${e.title}”?`)) onDelete(e.id); }}><Icon.trash size={18} /></button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
