import { PageImage } from './transcribe';

/** Largest image edge the model reads at full detail. */
export const MAX_EDGE = 2576;

export interface PreparedImage {
  image: PageImage;
  /** small preview data URL */
  thumb: string;
  width: number;
  height: number;
}

async function loadBitmap(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
}

/** Downscale (keeping EXIF orientation), lightly boost contrast for dim photos, encode as JPEG. */
export async function prepareImage(file: Blob, rotate = 0): Promise<PreparedImage> {
  const bmp = await loadBitmap(file);
  const w0 = 'naturalWidth' in bmp ? bmp.naturalWidth : bmp.width;
  const h0 = 'naturalHeight' in bmp ? bmp.naturalHeight : bmp.height;
  const scale = Math.min(1, MAX_EDGE / Math.max(w0, h0));
  const w = Math.round(w0 * scale);
  const h = Math.round(h0 * scale);
  const swap = rotate % 180 !== 0;
  const canvas = document.createElement('canvas');
  canvas.width = swap ? h : w;
  canvas.height = swap ? w : h;
  const ctx = canvas.getContext('2d')!;
  ctx.filter = 'grayscale(1) contrast(1.15) brightness(1.04)';
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rotate * Math.PI) / 180);
  ctx.drawImage(bmp as CanvasImageSource, -w / 2, -h / 2, w, h);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
  const tcanvas = document.createElement('canvas');
  const ts = 240 / Math.max(canvas.width, canvas.height);
  tcanvas.width = Math.round(canvas.width * ts);
  tcanvas.height = Math.round(canvas.height * ts);
  tcanvas.getContext('2d')!.drawImage(canvas, 0, 0, tcanvas.width, tcanvas.height);
  return {
    image: { data: dataUrl.slice(dataUrl.indexOf(',') + 1), mediaType: 'image/jpeg' },
    thumb: tcanvas.toDataURL('image/jpeg', 0.7),
    width: canvas.width,
    height: canvas.height,
  };
}

/**
 * Six enlarged, overlapping pieces of a page: the left and right half of its top, middle and bottom
 * third. A model that shrinks a whole page loses small marks such as tremolo slashes; the pieces
 * keep them readable. Returns [] for a small image, or where the browser cannot cut it.
 */
export async function detailPieces(image: PageImage): Promise<PageImage[]> {
  try {
    const blob = await (await fetch(`data:${image.mediaType};base64,${image.data}`)).blob();
    const bmp = await loadBitmap(blob);
    const w = 'naturalWidth' in bmp ? bmp.naturalWidth : bmp.width;
    const h = 'naturalHeight' in bmp ? bmp.naturalHeight : bmp.height;
    if (Math.max(w, h) < 1400) return [];
    const pieces: PageImage[] = [];
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 2; col++) {
        const x = col === 0 ? 0 : Math.round(w * 0.45);
        const y = Math.max(0, Math.round(h * (row / 3 - 0.04)));
        const pw = Math.round(w * 0.55);
        const ph = Math.min(h, Math.round(h * ((row + 1) / 3 + 0.04))) - y;
        const canvas = document.createElement('canvas');
        canvas.width = pw;
        canvas.height = ph;
        canvas.getContext('2d')!.drawImage(bmp as CanvasImageSource, x, y, pw, ph, 0, 0, pw, ph);
        const url = canvas.toDataURL('image/jpeg', 0.88);
        pieces.push({ data: url.slice(url.indexOf(',') + 1), mediaType: 'image/jpeg' });
      }
    }
    return pieces;
  } catch {
    return [];
  }
}
