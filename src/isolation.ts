// Turns on cross-origin isolation through public/coi-sw.js, so that scanning on the device can use
// several CPU threads. Hosts that send the headers themselves (the dev server with COI=1) need none of
// this. The first visit is served before the worker exists, so the page reloads once when it takes over.
const RELOADED = 'coi-reloaded';

export function isolate(): void {
  if (!import.meta.env.PROD || self.crossOriginIsolated || !window.isSecureContext || !('serviceWorker' in navigator)) return;
  const sw = navigator.serviceWorker;
  const hadController = !!sw.controller;
  sw.register(`${import.meta.env.BASE_URL}coi-sw.js`).catch(() => undefined);
  // Already served through the worker but still not isolated: this browser does not support it.
  if (hadController) return;
  sw.addEventListener('controllerchange', () => {
    try {
      if (sessionStorage.getItem(RELOADED)) return;
      sessionStorage.setItem(RELOADED, '1');
    } catch {
      return; // without storage there is no guard against reloading again and again
    }
    location.reload();
  });
}
