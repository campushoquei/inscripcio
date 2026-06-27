/* ============================================================
   Service worker NOMÉS per al panell d'administració (PWA).
   - Fa el panell instal·lable i de càrrega ràpida (closca en cau).
   - Funciona offline per a la CLOSCA (HTML/CSS/JS/icona/fonts).
   - Les DADES del panell (peticions a l'Apps Script) NO es guarden MAI
     en cau: sempre van per xarxa, perquè es vegin dades fresques
     (pagaments, grups, formularis actius...).
   - No toca el formulari públic (index.html): aquelles peticions passen
     per xarxa amb normalitat.
   ============================================================ */
const ADM_CACHE = "adm-shell-v1";
const ADM_ASSETS = ["admin.html", "admin.css", "admin.js", "logo.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(ADM_CACHE).then((c) => c.addAll(ADM_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== ADM_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;                         // POST a l'API → xarxa, mai cau
  const url = new URL(req.url);
  const isFont = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  const p = url.pathname;
  const isAdminAsset = url.origin === location.origin &&
    (p.endsWith("/admin.html") || p.endsWith("/admin.css") || p.endsWith("/admin.js") || p.endsWith("/logo.png"));

  // Fonts de Google: cache-first (pràcticament no canvien).
  if (isFont) {
    e.respondWith(caches.open(ADM_CACHE).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req); c.put(req, res.clone()); return res;
    }));
    return;
  }

  // Tot allò que no sigui del panell (formulari, etc.) → xarxa normal, no l'interceptem.
  if (!isAdminAsset) return;

  // Icona: cache-first. HTML/CSS/JS del panell: network-first (sempre la versió nova
  // si hi ha xarxa; la cau només és el pla B quan estàs offline).
  if (p.endsWith("/logo.png")) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const cp = res.clone(); caches.open(ADM_CACHE).then((c) => c.put(req, cp)); return res;
    })));
    return;
  }
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      const c = await caches.open(ADM_CACHE); c.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await caches.match(req);
      return hit || caches.match("admin.html");
    }
  })());
});
