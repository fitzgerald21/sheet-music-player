// Makes the app "cross-origin isolated" on hosts that cannot send the two headers for it themselves,
// such as GitHub Pages. Isolation is what lets scanning on the device use several CPU threads at once
// (WebAssembly threads need SharedArrayBuffer), which roughly halves the time a page takes.
//
// Only pages and worker scripts need the headers, so everything else goes straight to the network.
// Every resource the app loads from another site (Pyodide from jsDelivr, AI services) is fetched with
// CORS, which isolation allows.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const NEEDS_HEADERS = new Set(['document', 'iframe', 'worker', 'sharedworker']);

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || !NEEDS_HEADERS.has(request.destination)) return;
  if (new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(request).then((response) => {
      if (response.type === 'opaque' || response.type === 'opaqueredirect' || response.status === 0) return response;
      const headers = new Headers(response.headers);
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }),
  );
});
