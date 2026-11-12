// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { importFile } from '../src/importers';
import { isPdf } from '../src/importers/pdf';
import { mapLimit } from '../src/omr/transcribe';

const pdfBytes = new TextEncoder().encode('%PDF-1.7\n%stub\n');

describe('PDF import', () => {
  it('sends a PDF to the scanner as a PDF, to be split into pages there', async () => {
    const f = new File([pdfBytes], 'Sonata.pdf', { type: 'application/pdf' });
    const r = await importFile(f);
    expect(r.kind).toBe('scan');
    if (r.kind === 'scan') {
      expect(r.files).toHaveLength(1);
      expect(isPdf(r.files[0])).toBe(true);
      expect(r.files[0].name).toBe('Sonata.pdf');
    }
  });
  it('recognises a PDF whose name and type were lost', async () => {
    const r = await importFile(new File([pdfBytes], 'download', { type: '' }));
    expect(r.kind).toBe('scan');
    if (r.kind === 'scan') expect(isPdf(r.files[0])).toBe(true);
  });
  it('still sends photos to the scanner', async () => {
    const r = await importFile(new File([new Uint8Array([0xff, 0xd8, 0xff])], 'page.jpg', { type: 'image/jpeg' }));
    expect(r.kind).toBe('scan');
  });
});

describe('mapLimit', () => {
  it('keeps order and never runs more than the limit at once', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3, 0, 6], 3, async (x, i) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, x * 3));
      running--;
      return `${i}:${x}`;
    });
    expect(out).toEqual(['0:5', '1:1', '2:4', '3:2', '4:3', '5:0', '6:6']);
    expect(peak).toBe(3);
  });
});
