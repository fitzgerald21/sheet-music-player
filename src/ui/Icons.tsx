import { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };
const base = (size = 20) => ({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const });

export const Icon = {
  play: ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none" /></svg>),
  pause: ({ size, ...p }: P) => (<svg {...base(size)} {...p}><rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" /><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" /></svg>),
  stop: ({ size, ...p }: P) => (<svg {...base(size)} {...p}><rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" /></svg>),
  back: ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M15 5l-7 7 7 7" /></svg>),
  camera: ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>),
  image: ({ size, ...p }: P) => (<svg {...base(size)} {...p}><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="M20 16l-5-5-8 8" /></svg>),
  library: ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M5 4h4v16H5zM10 4h4v16h-4zM15.5 4.8l3.8-1 3.7 15.5-3.8.9z" /></svg>),
  settings: ({ size, ...p }: P) => (<svg {...base(size)} {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>),
  metronome: ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M9 3h6l4 18H5z" /><path d="M12 15l5-8" /><path d="M7.5 15h9" /></svg>),
  loop: ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M17 2l3 3-3 3" /><path d="M4 11V9a4 4 0 0 1 4-4h12" /><path d="M7 22l-3-3 3-3" /><path d="M20 13v2a4 4 0 0 1-4 4H4" /></svg>),
  undo: ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M9 14L4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></svg>),
  redo: ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M15 14l5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></svg>),
  edit: ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>),
  mixer: ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" /></svg>),
  transpose: ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M7 20V4M3 8l4-4 4 4M17 4v16M13 16l4 4 4-4" /></svg>),
  info: ({ size, ...p }: P) => (<svg {...base(size)} {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.01" /></svg>),
  download: ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M12 3v12M7 10l5 5 5-5M4 20h16" /></svg>),
  upload: ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M12 21V9M7 14l5-5 5 5M4 4h16" /></svg>),
  zoomIn: ({ size, ...p }: P) => (<svg {...base(size)} {...p}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3M11 8v6M8 11h6" /></svg>),
  zoomOut: ({ size, ...p }: P) => (<svg {...base(size)} {...p}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3M8 11h6" /></svg>),
  trash: ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>),
  close: ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M6 6l12 12M18 6L6 18" /></svg>),
  plus: ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M12 5v14M5 12h14" /></svg>),
  up: ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M6 15l6-6 6 6" /></svg>),
  down: ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M6 9l6 6 6-6" /></svg>),
  left: ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M15 6l-6 6 6 6" /></svg>),
  right: ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M9 6l6 6-6 6" /></svg>),
  rotate: ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></svg>),
  more: ({ size, ...p }: P) => (<svg {...base(size)} {...p}><circle cx="5" cy="12" r="1.2" fill="currentColor" /><circle cx="12" cy="12" r="1.2" fill="currentColor" /><circle cx="19" cy="12" r="1.2" fill="currentColor" /></svg>),
  music: ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>),
  keyboard: ({ size, ...p }: P) => (<svg {...base(size)} {...p}><rect x="2.5" y="6" width="19" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" /></svg>),
};

/** Small note-value glyphs drawn as SVG so they look the same on every device. */
export function NoteGlyph({ dur, size = 22 }: { dur: string; size?: number }) {
  const filled = dur !== 'w' && dur !== 'h';
  const stem = dur !== 'w';
  const flags = dur === '8' ? 1 : dur === '16' ? 2 : dur === '32' ? 3 : 0;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <ellipse cx="9" cy="18" rx="4.2" ry="3" transform="rotate(-22 9 18)" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.6" />
      {stem && <path d="M12.8 17V3" stroke="currentColor" strokeWidth="1.6" />}
      {Array.from({ length: flags }).map((_, i) => (
        <path key={i} d={`M12.8 ${3 + i * 4} c 4 2 5 4 3 8`} stroke="currentColor" strokeWidth="1.6" fill="none" />
      ))}
    </svg>
  );
}

export function RestGlyph({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path d="M10 3l4 5-3 4 4 5c-3-1-5 0-3 4-4-3-3-6 0-5l-5-5 3-4z" fill="currentColor" />
    </svg>
  );
}
