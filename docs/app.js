/* =====================================================================
   Börsen-Übersicht – Programmlogik der Webseite
   ---------------------------------------------------------------------
   Ablauf:
   1. data/markets.json laden (wird 2x täglich von GitHub Actions erneuert)
   2. Alle Bereiche der Seite mit diesen Daten füllen
   3. Service Worker anmelden -> letzte Daten auch offline verfügbar
   ===================================================================== */
"use strict";

const DATEN_URL = "data/markets.json";
const ZEITZONE = "Europe/Zurich";
let daten = null;            // zuletzt geladene Daten
let zeitraum = 5;            // Mini-Chart: 5 Tage oder 23 (= ca. 1 Monat)
let geladenUm = 0;           // wann zuletzt geladen (für automatisches Neuladen)

// Gewählten Zeitraum merken (falls der Browser das erlaubt)
try { zeitraum = Number(localStorage.getItem("zeitraum")) || 5; } catch (e) { /* egal */ }

/* ---------------------------------------------------------------------
   Hilfsfunktionen: Zahlen und Zeiten im Schweizer Format
   --------------------------------------------------------------------- */

/** 12345.678 -> "12'345.68" */
function zahl(wert, stellen = 2) {
  if (wert === null || wert === undefined || isNaN(wert)) return "–";
  const [ganz, nachkomma] = Math.abs(wert).toFixed(stellen).split(".");
  const gruppiert = ganz.replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  return (wert < 0 ? "−" : "") + gruppiert + (nachkomma ? "." + nachkomma : "");
}

/** 1.234 -> "+1.23 %" */
function prozent(p) {
  if (p === null || p === undefined || isNaN(p)) return "–";
  return (p >= 0 ? "+" : "−") + Math.abs(p).toFixed(2) + "\u00a0%";
}

/** Vorzeichen-Klasse für die Farbe */
function farbe(p) {
  if (p === null || p === undefined || Math.abs(p) < 0.005) return "";
  return p > 0 ? "plus" : "minus";
}

/** Sinnvolle Anzahl Nachkommastellen je nach Art des Kurses */
function stellen(e) {
  if (e.kategorie === "devisen") return 4;
  if (e.symbol === "^TNX") return 3;
  if (e.kurs !== null && Math.abs(e.kurs) >= 1000 && e.kategorie === "krypto") return 0;
  if (e.kurs !== null && Math.abs(e.kurs) < 1) return 4;
  return 2;
}

const fmtDatumLang = new Intl.DateTimeFormat("de-CH", { timeZone: ZEITZONE, weekday: "long", day: "numeric", month: "long", year: "numeric" });
const fmtDatumZeit = new Intl.DateTimeFormat("de-CH", { timeZone: ZEITZONE, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const fmtZeit = new Intl.DateTimeFormat("de-CH", { timeZone: ZEITZONE, hour: "2-digit", minute: "2-digit" });
const fmtTagKurz = new Intl.DateTimeFormat("de-CH", { timeZone: ZEITZONE, weekday: "short", day: "numeric", month: "numeric" });
const fmtWochentag = new Intl.DateTimeFormat("de-CH", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" });

/** Datum als "JJJJ-MM-TT" in einer bestimmten Zeitzone */
function isoTag(d, tz = ZEITZONE) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** "2026-11-24" -> "24.11." */
function kurzDatum(iso) {
  if (!iso) return "";
  const [, m, t] = iso.split("-");
  return `${Number(t)}.${Number(m)}.`;
}

/** Text sicher in HTML einsetzen (verhindert, dass News-Titel Code einschleusen) */
function esc(t) {
  return String(t ?? "").replace(/[&<>"']/g, (z) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[z]));
}

/** Nur http(s)-Links zulassen */
function sichererLink(url) {
  return /^https?:\/\//i.test(url || "") ? url : "#";
}

const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------------
   Börsenstatus (offen / geschlossen) – wird live im Browser berechnet
   --------------------------------------------------------------------- */
function boersenStatus(b, jetzt = new Date()) {
  const teile = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: b.zeitzone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(jetzt).map((p) => [p.type, p.value])
  );
  const hm = `${teile.hour}:${teile.minute}`;
  const tag = isoTag(jetzt, b.zeitzone);
  if (teile.weekday === "Sat" || teile.weekday === "Sun") return { offen: false, text: "Wochenende" };
  if ((b.feiertage || []).includes(tag)) return { offen: false, text: "Feiertag" };
  if (hm >= b.oeffnung && hm < b.schluss) return { offen: true, text: `offen bis ${b.schluss}` };
  if (hm < b.oeffnung) return { offen: false, text: `öffnet ${b.oeffnung}` };
  return { offen: false, text: "geschlossen" };
}

function zeigeBoersenStatus() {
  if (!daten) return;
  $("boersen-status").innerHTML = (daten.boersen || []).map((b) => {
    const s = boersenStatus(b);
    return `<span class="chip ${s.offen ? "offen" : ""}" title="Ortszeit der Börse"><span class="punkt"></span><b>${esc(b.name)}</b> ${esc(s.text)}</span>`;
  }).join("");
  $("datum").textContent = fmtDatumLang.format(new Date());
}

/* ---------------------------------------------------------------------
   Mini-Chart (Sparkline) als SVG
   --------------------------------------------------------------------- */
function sparkline(werte) {
  const w = (werte || []).filter((v) => v !== null && !isNaN(v)).slice(-zeitraum);
  if (w.length < 2) return '<svg viewBox="0 0 100 30"></svg>';
  const min = Math.min(...w), max = Math.max(...w), spanne = max - min || 1;
  const punkte = w.map((v, i) => [(i / (w.length - 1)) * 100, 28 - ((v - min) / spanne) * 26]);
  const linie = punkte.map((p) => p.map((z) => z.toFixed(2)).join(",")).join(" ");
  const klasse = w[w.length - 1] >= w[0] ? "plus" : "minus";
  return `<svg viewBox="0 0 100 30" preserveAspectRatio="none" class="${klasse}" aria-hidden="true">
    <polygon points="0,30 ${linie} 100,30" fill="currentColor" opacity="0.12"/>
    <polyline points="${linie}" fill="none" stroke="currentColor" stroke-width="1.8" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
  </svg>`;
}

/* ---------------------------------------------------------------------
   Bausteine
   --------------------------------------------------------------------- */
function veraltetBadge(e) {
  if (!e.veraltet) return "";
  const t = e.kurs === null ? "keine Daten" : `Stand ${kurzDatum(e.datum)}`;
  return `<span class="badge" title="${esc(e.hinweis || "Quelle nicht erreichbar")}">⚠ ${t}</span>`;
}

function kachel(e) {
  const f = farbe(e.diff_pct);
  return `<article class="kachel">
    <div class="name"><span>${esc(e.name)}</span><span class="region">${esc(e.region || "")}</span></div>
    <div class="kurs">${zahl(e.kurs, stellen(e))}</div>
    <div class="veraenderung ${f}">${e.kurs === null ? "&nbsp;" : `${e.diff >= 0 ? "+" : "−"}${zahl(Math.abs(e.diff), 2)} (${prozent(e.diff_pct)})`}</div>
    ${veraltetBadge(e) ? `<div>${veraltetBadge(e)}</div>` : ""}
    ${sparkline(e.verlauf)}
  </article>`;
}

function zeile(e, mitEinheit = true) {
  const einheit = mitEinheit && e.einheit ? `<span class="einheit">${esc(e.einheit)}</span>` : "";
  const zusatz = e.zeitraum ? `<span class="einheit">Veränderung ${esc(e.zeitraum)}</span>` : "";
  return `<div class="zeile">
    <div class="n">${esc(e.name)}${veraltetBadge(e)}${einheit}${zusatz}</div>
    <div class="k">${zahl(e.kurs, stellen(e))}</div>
    <div><span class="pill ${farbe(e.diff_pct)}">${prozent(e.diff_pct)}</span></div>
  </div>`;
}

function liste(eintraege) {
  if (!eintraege || !eintraege.length) return '<p class="leise">Keine Daten.</p>';
  return `<div class="zeilen">${eintraege.map((e) => zeile(e)).join("")}</div>`;
}

/** Top-Gewinner und -Verlierer (nur Titel mit frischen Daten) */
function mover(aktien, anzahl = 3) {
  const gueltig = (aktien || []).filter((a) => a.kurs !== null && !a.veraltet).sort((a, b) => b.diff_pct - a.diff_pct);
  if (!gueltig.length) return '<p class="leise">Keine aktuellen Daten.</p>';
  const gewinner = gueltig.slice(0, anzahl);
  const verlierer = gueltig.slice(-anzahl).reverse();
  const mini = (l) => l.map((a) => `<div class="zeile" style="grid-template-columns:minmax(0,1fr) auto"><div class="n">${esc(a.name)}</div><div><span class="pill ${farbe(a.diff_pct)}">${prozent(a.diff_pct)}</span></div></div>`).join("");
  return `<div class="mover">
    <div><h3>▲ Gewinner</h3><div class="zeilen">${mini(gewinner)}</div></div>
    <div><h3>▼ Verlierer</h3><div class="zeilen">${mini(verlierer)}</div></div>
  </div>`;
}

function newsZeit(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const heute = isoTag(new Date());
  const gestern = isoTag(new Date(Date.now() - 864e5));
  const tag = isoTag(d);
  if (tag === heute) return fmtZeit.format(d);
  if (tag === gestern) return "gestern " + fmtZeit.format(d);
  return fmtTagKurz.format(d) + " " + fmtZeit.format(d);
}

function zeigeNews(news) {
  if (!news || !news.length) {
    $("news").innerHTML = '<li class="leise">Keine Schlagzeilen verfügbar.</li>';
    return;
  }
  $("news").innerHTML = news.map((n) => `<li>
    <a href="${esc(sichererLink(n.link))}" target="_blank" rel="noopener noreferrer">${esc(n.titel)}</a>
    <div class="meta">${esc(n.quelle)} · ${newsZeit(n.zeit)}${(n.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}${n.veraltet ? ' <span class="badge">älter</span>' : ""}</div>
  </li>`).join("");
}

function zeigeKalender(termine) {
  if (!termine || !termine.length) {
    $("kalender").innerHTML = '<p class="leise">Keine wichtigen Termine gefunden.</p>';
    return;
  }
  const heute = isoTag(new Date());
  const morgen = isoTag(new Date(Date.now() + 864e5));
  const gestern = isoTag(new Date(Date.now() - 864e5));
  const kuerzel = { Schweiz: "CH", USA: "US", Eurozone: "EU" };
  let html = "", letzterTag = "";
  for (const t of termine) {
    if (t.datum < gestern) continue;
    if (t.datum !== letzterTag) {
      const [j, m, d] = t.datum.split("-").map(Number);
      const name = fmtWochentag.format(new Date(Date.UTC(j, m - 1, d)));
      const vorsatz = t.datum === heute ? "Heute · " : t.datum === morgen ? "Morgen · " : t.datum === gestern ? "Gestern · " : "";
      html += `<div class="tag-titel">${vorsatz}${esc(name)}</div>`;
      letzterTag = t.datum;
    }
    const details = [t.prognose ? `Prognose ${esc(t.prognose)}` : "", t.vorher ? `zuvor ${esc(t.vorher)}` : ""].filter(Boolean).join(" · ");
    html += `<div class="termin">
      <div class="zeit">${esc(t.zeit || "")}</div>
      <div><span class="wichtig-${esc(t.wichtigkeit)}">${t.land ? `<b>${esc(kuerzel[t.land] || t.land)}</b> ` : ""}${esc(t.titel)}</span>
      ${details ? `<div class="detail">${details}</div>` : ""}</div>
    </div>`;
  }
  $("kalender").innerHTML = html || '<p class="leise">Keine anstehenden Termine.</p>';
}

function zeigeQuellen(q) {
  if (!q) return;
  const feeds = (q.feeds || []).map((f) => `<tr><td>${f.ok ? "✅" : "❌"}</td><td>${esc(f.name)}</td><td class="leise">${f.ok ? `${f.anzahl} Meldungen` : esc(f.fehler || "Fehler")}</td></tr>`).join("");
  const kurse = Object.entries(q.kurse || {}).map(([k, v]) => `${esc(k)}: ${v}`).join(" · ");
  $("quellen").innerHTML = `
    <p><b>Kurse frisch geladen:</b> ${esc(q.kurse_frisch || "–")}<br><span class="leise">${kurse}</span></p>
    <p><b>Wirtschaftskalender:</b> ${esc(q.kalender || "–")}<br><b>Quartalszahlen:</b> ${esc(q.quartalszahlen || "–")}</p>
    <p><b>News-Feeds beim letzten Update:</b></p>
    <table class="quellen-tab">${feeds}</table>`;
}

/* ---------------------------------------------------------------------
   Gesamte Seite aufbauen
   --------------------------------------------------------------------- */
function zeigeAlles(offline) {
  const d = daten;
  zeigeBoersenStatus();

  const erstellt = new Date(d.erstellt);
  $("aktualisiert").textContent = `Daten vom ${fmtDatumZeit.format(erstellt)} Uhr · ${d.lauf || "Update"}`;

  // Hinweise oben (Beispieldaten, alte Daten, offline)
  const hinweise = [];
  if (d.beispieldaten) hinweise.push("Dies sind BEISPIELDATEN. Echte Kurse erscheinen nach dem ersten automatischen Update.");
  const alterStd = (Date.now() - erstellt.getTime()) / 36e5;
  if (alterStd > 16) hinweise.push(`Die Daten sind ${Math.round(alterStd)} Stunden alt – das letzte automatische Update hat evtl. nicht geklappt.`);
  if (offline) hinweise.push("Offline: Es werden die zuletzt gespeicherten Daten angezeigt.");
  $("hinweise").innerHTML = hinweise.map((h) => `<div class="banner">${esc(h)}</div>`).join("");

  // Tagesüberblick
  $("ueberblick").innerHTML = (d.zusammenfassung || []).map((s) => `<p>${esc(s)}</p>`).join("");

  // Auffälligkeiten
  const auff = d.auffaelligkeiten || [];
  $("sek-auffaellig").classList.toggle("versteckt", !auff.length);
  $("auffaellig").innerHTML = auff.map((a) => `<li class="pill ${farbe(a.diff_pct)}" style="text-align:left">${a.diff_pct >= 0 ? "▲" : "▼"} ${esc(a.text)}</li>`).join("");

  // Indizes
  $("indizes").innerHTML = (d.indizes || []).map(kachel).join("");
  document.querySelectorAll(".umschalter button").forEach((b) => b.classList.toggle("aktiv", Number(b.dataset.zeitraum) === zeitraum));

  // Gewinner/Verlierer
  $("mover-ch").innerHTML = mover(d.aktien_ch);
  $("mover-us").innerHTML = mover(d.aktien_us);

  // Kompakte Listen
  $("krypto").innerHTML = liste(d.krypto);
  $("rohstoffe").innerHTML = liste(d.rohstoffe);
  $("devisen").innerHTML = liste(d.devisen);
  $("weitere").innerHTML = liste(d.weitere);

  // Alle Aktien (sortiert nach Tagesveränderung)
  const sortiert = (l) => [...(l || [])].sort((a, b) => (b.diff_pct ?? -999) - (a.diff_pct ?? -999));
  $("alle-ch").innerHTML = liste(sortiert(d.aktien_ch));
  $("alle-us").innerHTML = liste(sortiert(d.aktien_us));

  zeigeNews(d.news);
  zeigeKalender(d.kalender);
  zeigeQuellen(d.quellen);
}

/* ---------------------------------------------------------------------
   Daten laden
   --------------------------------------------------------------------- */
async function laden() {
  const knopf = $("neu-laden");
  knopf.classList.add("dreht");
  try {
    // "?t=..." umgeht den Browser-Zwischenspeicher -> immer die neueste Datei
    const antwort = await fetch(`${DATEN_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!antwort.ok) throw new Error(`HTTP ${antwort.status}`);
    daten = await antwort.json();
    geladenUm = Date.now();
    // Der Service Worker markiert Antworten aus dem Offline-Speicher
    zeigeAlles(antwort.headers.get("X-Aus-Speicher") === "1");
  } catch (fehler) {
    console.error(fehler);
    if (daten) {
      zeigeAlles(true);
    } else {
      $("hinweise").innerHTML = `<div class="banner">Die Daten konnten nicht geladen werden (${esc(fehler.message)}). Bitte Internetverbindung prüfen und neu laden.</div>`;
    }
  } finally {
    setTimeout(() => knopf.classList.remove("dreht"), 300);
  }
}

/* ---------------------------------------------------------------------
   Pull-to-refresh (nach unten ziehen, wenn ganz oben)
   --------------------------------------------------------------------- */
function pullToRefresh() {
  const ptr = $("ptr"), text = $("ptr-text");
  const SCHWELLE = 80;
  let startY = null, distanz = 0;
  window.addEventListener("touchstart", (e) => {
    startY = window.scrollY <= 0 ? e.touches[0].clientY : null;
    distanz = 0;
  }, { passive: true });
  window.addEventListener("touchmove", (e) => {
    if (startY === null) return;
    distanz = (e.touches[0].clientY - startY) / 2;   // gedämpft
    if (distanz <= 0) return;
    ptr.classList.add("ziehen");
    ptr.style.transform = `translateY(${Math.min(distanz, 70) - 60}px)`;
    const bereit = distanz > SCHWELLE;
    ptr.classList.toggle("bereit", bereit);
    text.textContent = bereit ? "Loslassen zum Aktualisieren" : "Zum Aktualisieren ziehen";
  }, { passive: true });
  window.addEventListener("touchend", async () => {
    if (startY === null) return;
    ptr.classList.remove("ziehen");
    if (distanz > SCHWELLE) {
      text.textContent = "Wird geladen …";
      ptr.style.transform = "translateY(0)";
      await laden();
    }
    ptr.style.transform = "";
    ptr.classList.remove("bereit");
    startY = null;
  });
}

/* ---------------------------------------------------------------------
   Start
   --------------------------------------------------------------------- */
$("neu-laden").addEventListener("click", laden);

document.querySelectorAll(".umschalter button").forEach((b) => b.addEventListener("click", () => {
  zeitraum = Number(b.dataset.zeitraum);
  try { localStorage.setItem("zeitraum", String(zeitraum)); } catch (e) { /* egal */ }
  if (daten) zeigeAlles(false);
}));

// Wenn die App aus dem Hintergrund zurückkommt und die Daten älter als 10 Min. sind: neu laden
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && Date.now() - geladenUm > 10 * 60 * 1000) laden();
});

// Börsenstatus jede Minute aktualisieren
setInterval(zeigeBoersenStatus, 60 * 1000);

pullToRefresh();
laden();

// Service Worker anmelden (für Offline-Betrieb)
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("Service Worker:", e));
  });
}
