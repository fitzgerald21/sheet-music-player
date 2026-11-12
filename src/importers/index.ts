// Decide what to do with a file the user opens.
import { Score, newId } from '../model/types';
import { parseMusicXML, musicXmlText } from './musicxml';
import { midiToScore } from './midi';
import { parseAbc } from './abc';

/** 'scan': photos or PDFs that go to the scanner (ScanView turns each PDF page into a page to read). */
export type ImportResult = { kind: 'score'; scores: Score[] } | { kind: 'scan'; files: File[] };

const ext = (name: string) => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();

// Phones grey out any file whose extension they don't recognise (.musicxml, .mxl, .abc), so on
// touch devices the picker is left unfiltered and importFile decides from the file's contents.
const TOUCH_DEVICE =
  typeof navigator !== 'undefined' &&
  (/iPad|iPhone|iPod|Android/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform ?? '')));

export const IMPORT_ACCEPT: string | undefined = TOUCH_DEVICE
  ? undefined
  : '.musicxml,.mxl,.xml,.mid,.midi,.abc,.json,.pdf,image/*,application/pdf,audio/midi';

export async function importFile(file: File): Promise<ImportResult> {
  const e = ext(file.name);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (file.type.startsWith('image/') || ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'].includes(e)) return { kind: 'scan', files: [file] };
  // %PDF at the start: a PDF even when a phone has dropped its name or type
  if (e === 'pdf' || file.type === 'application/pdf' || (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) {
    return { kind: 'scan', files: [e === 'pdf' ? file : new File([bytes], `${file.name || 'score'}.pdf`, { type: 'application/pdf' })] };
  }
  if (e === 'mid' || e === 'midi' || (bytes[0] === 0x4d && bytes[1] === 0x54 && bytes[2] === 0x68 && bytes[3] === 0x64)) {
    return { kind: 'score', scores: [midiToScore(bytes, file.name)] };
  }
  // MusicXML is recognised by content too, because phones sometimes rename or strip the extension
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const isXmlScore = /<score-(partwise|timewise)/.test(new TextDecoder().decode(bytes.slice(0, 4000)));
  if (e === 'mxl' || e === 'musicxml' || isXmlScore || isZip) {
    return { kind: 'score', scores: [parseMusicXML(musicXmlText(bytes))] };
  }
  const text = new TextDecoder().decode(bytes);
  if (e === 'json' || text.trimStart().startsWith('{')) {
    const data = JSON.parse(text) as Score;
    if (!data || !Array.isArray(data.measures) || !Array.isArray(data.parts)) throw new Error('That JSON file is not a Sheet Music Player score.');
    return { kind: 'score', scores: [{ ...data, id: newId('s'), updated: Date.now() }] };
  }
  if (e === 'abc' || /^\s*X:\s*\d+/m.test(text) || /^K:/m.test(text)) {
    // a file may hold several tunes
    const tunes = text.split(/^(?=X:)/m).filter((t) => /K:/.test(t));
    return { kind: 'score', scores: (tunes.length ? tunes : [text]).slice(0, 50).map((t) => parseAbc(t)) };
  }
  throw new Error('Unsupported file. Open MusicXML (.musicxml/.mxl), MIDI, ABC, PDF, an image, or a saved .json score.');
}
