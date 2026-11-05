import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icons';
import { parseAbc, SESSION_METER } from '../importers/abc';
import { Score } from '../model/types';
import { IMPORT_ACCEPT } from '../importers';
import { serverInfo } from '../omr/client';

interface Props {
  onBack: () => void;
  onOpen: (s: Score) => void;
  onImportFile: (f: File) => void;
}

interface SessionTune {
  id: number;
  name: string;
  type: string;
  url: string;
}
interface ImslpWork {
  title: string;
}
interface ImslpFile {
  name: string;
  description: string;
  url: string;
  page: string;
  kind: 'pdf' | 'midi' | 'musicxml' | 'other';
}

type Tab = 'session' | 'imslp' | 'more';

const api = (p: string) => `${import.meta.env.BASE_URL}api/${p}`;

export function FindMusic({ onBack, onOpen, onImportFile }: Props) {
  const [tab, setTab] = useState<Tab>('session');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tunes, setTunes] = useState<SessionTune[]>([]);
  const [works, setWorks] = useState<ImslpWork[]>([]);
  const [files, setFiles] = useState<{ work: string; list: ImslpFile[] } | null>(null);
  const [imslpProxy, setImslpProxy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void serverInfo().then((i) => setImslpProxy(i.imslp));
  }, []);

  async function search(e?: React.FormEvent) {
    e?.preventDefault();
    if (!q.trim()) return;
    setBusy(true);
    setErr(null);
    setFiles(null);
    try {
      if (tab === 'session') {
        const r = await fetch(`https://thesession.org/tunes/search?q=${encodeURIComponent(q)}&format=json&perpage=30`);
        const j = await r.json();
        setTunes(j.tunes ?? []);
        if (!j.tunes?.length) setErr('No tunes found.');
      } else if (tab === 'imslp') {
        const r = await fetch(api(`imslp/search?q=${encodeURIComponent(q)}`));
        if (!r.ok) throw new Error('Search failed');
        const j = await r.json();
        setWorks(j.works ?? []);
        if (!j.works?.length) setErr('No works found. Try the composer’s surname and the title.');
      }
    } catch {
      setErr('Could not reach the search service.');
    } finally {
      setBusy(false);
    }
  }

  async function openTune(t: SessionTune) {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`https://thesession.org/tunes/${t.id}?format=json`);
      const j = await r.json();
      const setting = j.settings?.[0];
      if (!setting) throw new Error();
      const s = parseAbc(setting.abc, { title: j.name, meter: SESSION_METER[j.type] ?? '4/4', key: setting.key });
      s.subtitle = `${j.type[0].toUpperCase()}${j.type.slice(1)} · thesession.org`;
      s.composer = 'Traditional';
      s.notes = [`From The Session (${j.url}), setting by ${setting.member?.name ?? 'a member'}.`];
      onOpen(s);
    } catch {
      setErr('Could not load that tune.');
    } finally {
      setBusy(false);
    }
  }

  async function openWork(w: ImslpWork) {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(api(`imslp/files?title=${encodeURIComponent(w.title)}`));
      const j = await r.json();
      setFiles({ work: w.title, list: j.files ?? [] });
    } catch {
      setErr('Could not load the files for that work.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="find-view">
      <header className="topbar">
        <button className="icon-btn" onClick={files ? () => setFiles(null) : onBack} aria-label="Back"><Icon.back /></button>
        <h1>Find music</h1>
        <span className="grow" />
      </header>
      <div className="find-body">
        <div className="seg" role="tablist">
          <button className={tab === 'session' ? 'on' : ''} onClick={() => { setTab('session'); setErr(null); setFiles(null); }} role="tab" aria-selected={tab === 'session'}>Folk tunes</button>
          <button className={tab === 'imslp' ? 'on' : ''} onClick={() => { setTab('imslp'); setErr(null); }} role="tab" aria-selected={tab === 'imslp'}>Classical (IMSLP)</button>
          <button className={tab === 'more' ? 'on' : ''} onClick={() => { setTab('more'); setErr(null); }} role="tab" aria-selected={tab === 'more'}>More sources</button>
        </div>

        {tab !== 'more' && !(tab === 'imslp' && !imslpProxy) && (
          <form className="search-row" onSubmit={search}>
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tab === 'session' ? 'Tune name, e.g. Kesh, Butterfly' : 'Composer and title, e.g. Satie Gymnopédie'} aria-label="Search" />
            <button className="btn primary" disabled={busy || !q.trim()}>{busy ? <div className="spinner light" /> : 'Search'}</button>
          </form>
        )}
        {err && <p className="hint">{err}</p>}

        {tab === 'session' && (
          <>
            <p className="hint">Thousands of traditional Irish, Scottish and other folk tunes from <a href="https://thesession.org" target="_blank" rel="noreferrer">thesession.org</a>, with chords where people added them. Tap one to open it.</p>
            <ul className="result-list">
              {tunes.map((t) => (
                <li key={t.id}>
                  <button className="score-item" onClick={() => openTune(t)} disabled={busy}>
                    <span className="score-icon"><Icon.music size={18} /></span>
                    <span className="score-text"><span className="score-title">{t.name}</span><span className="score-sub">{t.type}</span></span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {tab === 'imslp' && (
          <>
            <p className="hint">
              <a href="https://imslp.org" target="_blank" rel="noreferrer">IMSLP</a> has hundreds of thousands of public-domain scores, mostly as PDF scans (some MIDI and MusicXML).
              Find a piece, download a file on IMSLP, then import it here – PDFs go to the scanner.
            </p>
            {!imslpProxy && (
              <p className="hint">
                Searching IMSLP from inside the app needs the app’s own server. You can still{' '}
                <a href={`https://imslp.org/index.php?search=${encodeURIComponent(q)}`} target="_blank" rel="noreferrer">search on imslp.org</a>.
              </p>
            )}
            {!files && (
              <ul className="result-list">
                {works.map((w) => (
                  <li key={w.title}>
                    <button className="score-item" onClick={() => openWork(w)} disabled={busy}>
                      <span className="score-icon"><Icon.library size={18} /></span>
                      <span className="score-text"><span className="score-title">{w.title}</span></span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {files && (
              <>
                <h2 className="sub-h">{files.work}</h2>
                {!files.list.length && <p className="hint">No downloadable files listed.</p>}
                <ul className="result-list">
                  {files.list.map((f) => (
                    <li key={f.name} className="file-row">
                      <span className={`badge ${f.kind}`}>{f.kind === 'musicxml' ? 'XML' : f.kind.toUpperCase()}</span>
                      <span className="score-text">
                        <span className="score-title">{f.description || f.name}</span>
                        <span className="score-sub">{f.name}</span>
                      </span>
                      <a className="btn sm" href={f.page} target="_blank" rel="noreferrer">Open on IMSLP</a>
                    </li>
                  ))}
                </ul>
                <button className="btn primary wide" onClick={() => fileRef.current?.click()}><Icon.upload size={16} /> Import the downloaded file</button>
              </>
            )}
          </>
        )}

        {tab === 'more' && (
          <>
            <p className="hint">These all work with <strong>Import</strong> in your library:</p>
            <ul className="links">
              <li><a href="https://musescore.com/sheetmusic" target="_blank" rel="noreferrer">MuseScore.com</a> – huge community library; download as <em>MusicXML</em> (free account needed). Exact notes, no scanning.</li>
              <li><a href="https://imslp.org" target="_blank" rel="noreferrer">IMSLP</a> – public-domain classical scores (PDF → scanner, some MIDI/MusicXML).</li>
              <li><a href="https://musescore.com/openscore/sets" target="_blank" rel="noreferrer">OpenScore</a> – volunteer-typeset public-domain scores (lieder, quartets), free MusicXML.</li>
              <li><a href="https://www.mutopiaproject.org" target="_blank" rel="noreferrer">Mutopia Project</a> – free classical sheet music as PDF and MIDI.</li>
              <li><a href="https://thesession.org" target="_blank" rel="noreferrer">The Session</a> and <a href="https://abcnotation.com" target="_blank" rel="noreferrer">abcnotation.com</a> – folk tunes in ABC.</li>
              <li><a href="https://bitmidi.com" target="_blank" rel="noreferrer">BitMidi</a> – MIDI files of all kinds (imported and turned into notation).</li>
            </ul>
            <button className="btn primary wide" onClick={() => fileRef.current?.click()}><Icon.upload size={16} /> Import a file</button>
          </>
        )}
        <input ref={fileRef} type="file" accept={IMPORT_ACCEPT} hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onImportFile(f); e.target.value = ''; }} />
      </div>
    </div>
  );
}
