// Render PDF pages to images (for scanning). pdf.js is loaded only when needed.
export async function pdfToImages(file: Blob, onPage?: (done: number, total: number) => void, maxPages = 30): Promise<File[]> {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const n = Math.min(doc.numPages, maxPages);
  const out: File[] = [];
  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i);
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
    const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/png'));
    out.push(new File([blob], `page-${i}.png`, { type: 'image/png' }));
    onPage?.(i, n);
  }
  return out;
}
