// Cross-origin isolation service worker.
//
// Static hosts such as GitHub Pages cannot send the COOP/COEP headers that
// browsers require before they enable SharedArrayBuffer. This worker adds
// them to every same-origin response, which lets Python block on input()
// and be interrupted with Ctrl+C. Cross-origin requests (CDNs) are loaded
// with CORS and pass through untouched.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  if (new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req).then((res) => {
      if (res.status === 0 || res.type === 'opaqueredirect') return res;
      const headers = new Headers(res.headers);
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
      headers.set('Cross-Origin-Resource-Policy', 'same-origin');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    }),
  );
});
