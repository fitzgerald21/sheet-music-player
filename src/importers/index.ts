// Decide what to do with a file the user opens.
import { Score, newId } from '../model/types';
import { parseMusicXML, musicXmlText } from './musicxml';
import { midiToScore } from './midi';
import { parseAbc } from './abc';

export type ImportResult = { kind: 'score'; scores: Score[] } | { kind: 'images'; files: File[] };

const ext = (name: string) => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();

export const IMPORT_ACCEPT = '.musicxml,.mxl,.xml,.mid,.midi,.abc,.json,.pdf,image/*,application/pdf,audio/midi';

export async function importFile(file: File): Promise<ImportResult> {
  const e = ext(file.name);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (file.type.startsWith('image/') || ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'].includes(e)) return { kind: 'images', files: [file] };
  if (e === 'pdf' || file.type === 'application/pdf') {
    const { pdfToImages } = await import('./pdf');
    return { kind: 'images', files: await pdfToImages(file) };
  }
  if (e === 'mid' || e === 'midi' || (bytes[0] === 0x4d && bytes[1] === 0x54 && bytes[2] === 0x68 && bytes[3] === 0x64)) {
    return { kind: 'score', scores: [midiToScore(bytes, file.name)] };
  }
  if (e === 'mxl' || e === 'musicxml' || (e === 'xml' && /score-(partwise|timewise)/.test(new TextDecoder().decode(bytes.slice(0, 4000))))) {
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
