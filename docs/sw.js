/* =====================================================================
   Service Worker – sorgt dafür, dass die App auch OFFLINE funktioniert.
   - App-Dateien (HTML, CSS, JS, Icons) werden gespeichert.
   - Die Daten (markets.json) werden immer zuerst frisch aus dem Internet
     geholt; klappt das nicht, wird die zuletzt gespeicherte Version gezeigt.
   WICHTIG: Wenn du HTML/CSS/JS änderst, erhöhe die VERSION unten um 1,
   damit iPhone/iPad die neue Version laden.
   ===================================================================== */
const VERSION = "v6";
const APP_SPEICHER = `boerse-app-${VERSION}`;
const DATEN_SPEICHER = "boerse-daten";
const APP_DATEIEN = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "charts.js",
  "kennzahlen.js",
  "analyse.js",
  "insider.js",
  "kalender.js",
  "manifest.json",
  "icons/icon-180.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/favicon.png",
];

// Installation: App-Dateien speichern
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(APP_SPEICHER).then((c) => c.addAll(APP_DATEIEN)).then(() => self.skipWaiting()));
});

// Aktivierung: alte Versionen aufräumen
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((namen) => Promise.all(namen.filter((n) => n !== APP_SPEICHER && n !== DATEN_SPEICHER).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  // 1) Daten: zuerst Netzwerk, sonst Speicher
  if (url.pathname.includes("/data/") && url.pathname.endsWith(".json")) {
    event.respondWith((async () => {
      const speicher = await caches.open(DATEN_SPEICHER);
      try {
        const antwort = await fetch(event.request, { cache: "no-store" });
        if (antwort.ok) await speicher.put(url.pathname, antwort.clone());
        return antwort;
      } catch (e) {
        const alt = await speicher.match(url.pathname);
        if (!alt) throw e;
        // Markierung, damit die Seite "Offline" anzeigen kann
        return new Response(await alt.blob(), { headers: { "Content-Type": "application/json", "X-Aus-Speicher": "1" } });
      }
    })());
    return;
  }

  // 2) App-Dateien: sofort aus dem Speicher, im Hintergrund aktualisieren
  event.respondWith((async () => {
    const speicher = await caches.open(APP_SPEICHER);
    const gespeichert = await speicher.match(event.request, { ignoreSearch: true });
    const netz = fetch(event.request).then((antwort) => {
      if (antwort.ok) speicher.put(event.request, antwort.clone());
      return antwort;
    }).catch(() => gespeichert);
    return gespeichert || netz;
  })());
});
