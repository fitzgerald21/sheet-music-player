// Render PDF pages to images (for scanning). pdf.js is loaded only when needed.

/** Most pages taken from one PDF; scanning costs time (and API usage) per page. */
export const PDF_MAX_PAGES = 60;

export const isPdf = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

export interface PdfPagesInfo {
  /** pages in the file */
  total: number;
  /** pages that will be rendered (total capped at maxPages) */
  count: number;
}

/**
 * Render each page of a PDF to a PNG, one at a time, calling onPage with it as soon as it is ready
 * (so a long score shows up page by page). Returns the page counts.
 */
export async function renderPdfPages(
  file: Blob,
  onPage: (page: File, index: number, info: PdfPagesInfo) => void,
  opts: { maxPages?: number; signal?: AbortSignal; onInfo?: (info: PdfPagesInfo) => void } = {},
): Promise<PdfPagesInfo> {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch (e) {
    void task.destroy();
    const name = (e as { name?: string })?.name;
    if (name === 'PasswordException') throw new Error('This PDF is password-protected. Remove the password (or print it to a new PDF) and try again.');
    throw new Error('Could not open this PDF. It may be damaged or not really a PDF.');
  }
  try {
    const info: PdfPagesInfo = { total: doc.numPages, count: Math.min(doc.numPages, opts.maxPages ?? PDF_MAX_PAGES) };
    opts.onInfo?.(info);
    for (let i = 1; i <= info.count; i++) {
      if (opts.signal?.aborted) throw new Error('Cancelled');
      const page = await doc.getPage(i);
      // the page's own rotation is included in its viewport, so a sideways-saved page comes out upright
      const vp1 = page.getViewport({ scale: 1 });
      const scale = 2576 / Math.max(vp1.width, vp1.height);
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp, canvas } as Parameters<typeof page.render>[0]).promise;
      const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error(`Could not draw page ${i} of the PDF.`))), 'image/png'));
      page.cleanup();
      // free the canvas memory now rather than at the next garbage collection (matters on phones)
      canvas.width = canvas.height = 0;
      const base = (file instanceof File ? file.name : 'score.pdf').replace(/\.pdf$/i, '');
      onPage(new File([blob], `${base}-page-${i}.png`, { type: 'image/png' }), i - 1, info);
    }
    return info;
  } finally {
    void task.destroy();
  }
}

