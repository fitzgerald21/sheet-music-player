import { Icon } from './Icons';

interface Props {
  playing: boolean;
  loading: boolean;
  onPlay: () => void;
  onStop: () => void;
  speed: number;
  setSpeed: (n: number) => void;
  tempo: number;
  metronome: boolean;
  setMetronome: (b: boolean) => void;
  loop: boolean;
  setLoop: (b: boolean) => void;
  countIn: boolean;
  setCountIn: (b: boolean) => void;
  position: string;
  progress: number;
  onSeek: (frac: number) => void;
}

export function Transport(p: Props) {
  return (
    <div className="transport">
      <div className="seek" onClick={(e) => {
        const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
        p.onSeek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
      }}>
        <div className="seek-fill" style={{ width: `${p.progress * 100}%` }} />
      </div>
      <div className="transport-row">
        <button className="play-btn" onClick={p.onPlay} aria-label={p.playing ? 'Pause' : 'Play'} disabled={p.loading}>
          {p.loading ? <div className="spinner light" /> : p.playing ? <Icon.pause size={26} /> : <Icon.play size={26} />}
        </button>
        <button className="icon-btn" onClick={p.onStop} aria-label="Stop"><Icon.stop /></button>
        <div className="pos mono">{p.position}</div>
        <span className="grow" />
        <div className="speed">
          <label htmlFor="speed" className="mini">♩ = {Math.round(p.tempo * p.speed)}</label>
          <input id="speed" type="range" min={0.25} max={2} step={0.05} value={p.speed} onChange={(e) => p.setSpeed(+e.target.value)} aria-label="Speed" />
          <button className="mini-btn mono" onClick={() => p.setSpeed(1)} title="Reset speed">{Math.round(p.speed * 100)}%</button>
        </div>
        <button className={`icon-btn toggle ${p.metronome ? 'on' : ''}`} onClick={() => p.setMetronome(!p.metronome)} aria-label="Metronome" title="Metronome"><Icon.metronome /></button>
        <button className={`icon-btn toggle ${p.countIn ? 'on' : ''} txt`} onClick={() => p.setCountIn(!p.countIn)} aria-label="Count-in" title="Count in one bar">1‑2</button>
        <button className={`icon-btn toggle ${p.loop ? 'on' : ''}`} onClick={() => p.setLoop(!p.loop)} aria-label="Loop" title="Loop (selected measures, or whole piece)"><Icon.loop /></button>
      </div>
    </div>
  );
}
