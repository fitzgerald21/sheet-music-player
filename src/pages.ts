// The photos or PDF pages a score was read from, kept in IndexedDB (they are far too big for
// localStorage) so that "Original pages" in play-along can follow the music on them.
import type { PageLayout } from './omr/layout';

export interface StoredPage {
  /** the image file's bytes (an ArrayBuffer, because Safari is unreliable at storing Blobs) */
  data: ArrayBuffer;
  type: string;
  /** where the systems and bar lines are, once it has been worked out */
  layout?: PageLayout;
}

const DB = 'smp';
const STORE = 'pages';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function savePages(scoreId: string, pages: StoredPage[]): Promise<boolean> {
  try {
    await run('readwrite', (s) => s.put(pages, scoreId));
    return true;
  } catch {
    return false;
  }
}

export async function loadPages(scoreId: string): Promise<StoredPage[]> {
  try {
    return (await run<StoredPage[] | undefined>('readonly', (s) => s.get(scoreId))) ?? [];
  } catch {
    return [];
  }
}

export async function deletePages(scoreId: string) {
  try {
    await run('readwrite', (s) => s.delete(scoreId));
  } catch {
    /* nothing to delete */
  }
}

export function base64Page(data: string, type: string): StoredPage {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  return { data: bytes.buffer, type };
}
