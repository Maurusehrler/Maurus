/* =====================================================================
   Börsen-Übersicht – Programmlogik der Webseite
   ---------------------------------------------------------------------
   Ablauf:
   1. data/markets.json laden (wird 2x täglich von GitHub Actions erneuert)
   2. Den gewählten Tab mit diesen Daten füllen
   3. Service Worker anmelden -> letzte Daten auch offline verfügbar

   Einstellungen, die sich die App merkt: Tab, Zeitraum, Region.
   ===================================================================== */
"use strict";

const DATEN_URL = "data/markets.json";
const ZEITZONE = "Europe/Zurich";

// Zeiträume für den Umschalter (Kürzel -> Text in Überschriften)
const ZEITRAEUME = { "1T": "1 Tag", "1W": "1 Woche", "1M": "1 Monat", "3M": "3 Monate", "YTD": "seit 1.1.", "1J": "1 Jahr", "3J": "3 Jahre", "5J": "5 Jahre" };
const LANGE_ZEITRAEUME = ["3J", "5J"];     // Mini-Charts aus Wochenwerten
const TABS = ["uebersicht", "aktien", "maerkte", "insider", "kalender", "news"];
// Unterbereiche pro Tab (erster Eintrag = Standard)
const UNTERBEREICHE = {
  aktien: ["sektoren", "heatmap", "screener", "vergleich"],
  maerkte: ["kurse", "makro", "saison", "rechner"],
  insider: ["politiker", "firmen"],
};

// Zustand der App
const zustand = {
  daten: null,          // zuletzt geladene Daten
  tab: "uebersicht",
  zeitraum: "1T",
  region: "alle",       // Sektoren: alle / ch / us / andere
  newsSortierung: "wichtig",   // wichtig / neu
  newsFilter: "alle",          // alle / CH / INT
  offline: false,
  geladenUm: 0,
};

// Gespeicherte Einstellungen lesen (falls der Browser das erlaubt)
function merken(schluessel, wert) { try { localStorage.setItem(schluessel, wert); } catch (e) { /* egal */ } }
function erinnern(schluessel, erlaubt, standard) {
  try { const w = localStorage.getItem(schluessel); return erlaubt.includes(w) ? w : standard; } catch (e) { return standard; }
}
zustand.tab = erinnern("tab", TABS, "uebersicht");
zustand.zeitraum = erinnern("zeitraum2", Object.keys(ZEITRAEUME), "1T");
zustand.region = erinnern("region", ["alle", "ch", "us", "andere"], "alle");
zustand.unter = {};
for (const [tab, liste] of Object.entries(UNTERBEREICHE)) zustand.unter[tab] = erinnern("unter_" + tab, liste, liste[0]);
zustand.newsSortierung = erinnern("newsSortierung", ["wichtig", "neu"], "wichtig");
zustand.newsFilter = erinnern("newsFilter", ["alle", "CH", "INT"], "alle");

// Länderkürzel -> Name
const LAENDER = { CH: "Schweiz", US: "USA", DE: "Deutschland", JP: "Japan", UK: "Grossbritannien", FR: "Frankreich", NL: "Niederlande", IT: "Italien", HK: "Hongkong", CA: "Kanada" };

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

/** 1.234 -> "+1.23 %" (geschütztes Leerzeichen, damit nichts umbricht) */
function prozent(p) {
  if (p === null || p === undefined || isNaN(p)) return "–";
  const stellen = Math.abs(p) >= 100 ? 0 : Math.abs(p) >= 10 ? 1 : 2;
  return (p >= 0 ? "+" : "−") + Math.abs(p).toFixed(stellen) + " %";
}

/** Farbklasse für Plus/Minus */
function farbe(p) {
  if (p === null || p === undefined || isNaN(p) || Math.abs(p) < 0.005) return "";
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

const fmtDatum = new Intl.DateTimeFormat("de-CH", { timeZone: ZEITZONE, weekday: "short", day: "numeric", month: "long" });
const fmtDatumZeit = new Intl.DateTimeFormat("de-CH", { timeZone: ZEITZONE, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
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
function sichererLink(url) { return /^https?:\/\//i.test(url || "") ? url : "#"; }
const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------------
   Werte für den gewählten Zeitraum
   --------------------------------------------------------------------- */

/** Veränderung in % für den gewählten Zeitraum (oder null) */
function perf(e) {
  if (!e || e.kurs === null || e.kurs === undefined) return null;
  if (zustand.zeitraum === "1T") return e.diff_pct ?? null;
  const p = e.perf && e.perf[zustand.zeitraum];
  return p === undefined ? null : p;
}

/** Kursreihe für den gewählten Zeitraum (Tageswerte bis 1 Jahr, Wochenwerte für 3 und 5 Jahre) */
function reiheImZeitraum(e, zeitraum = zustand.zeitraum) {
  if (LANGE_ZEITRAEUME.includes(zeitraum)) {
    const w = e.verlauf_w || [], n = e.tage_w && e.tage_w[zeitraum];
    return n ? w.slice(-n) : w;
  }
  const v = e.verlauf || [];
  if (zeitraum === "1T") return v.slice(-5);          // bei 1 Tag: Mini-Chart der letzten Woche
  const n = e.tage && e.tage[zeitraum];
  return n ? v.slice(-n) : v;
}

/** Veränderung in Punkten (Kurs heute minus Kurs am Anfang des Zeitraums) */
function diffPunkte(e) {
  if (zustand.zeitraum === "1T") return e.diff;
  const r = reiheImZeitraum(e);
  if (perf(e) === null || r.length < 2) return null;
  return e.kurs - r[0];
}

/** Aktien mit gültigem Wert, sortiert (bester zuerst) */
function sortiertNachPerf(liste) {
  return (liste || []).filter((a) => perf(a) !== null && !a.fehler).sort((a, b) => perf(b) - perf(a));
}

/** Alle Aktien (neues Format "aktien"; ältere Dateien hatten aktien_ch/aktien_us) */
function alleAktien() {
  const d = zustand.daten || {};
  if (d.aktien) return d.aktien;
  return [...(d.aktien_ch || []).map((a) => ({ ...a, land: "CH" })), ...(d.aktien_us || []).map((a) => ({ ...a, land: "US" }))];
}

/** Jedes Symbol nur einmal (eine Aktie kann in mehreren Sektoren stehen) */
function eindeutig(liste) {
  const gesehen = new Set();
  return liste.filter((a) => (gesehen.has(a.symbol) ? false : gesehen.add(a.symbol)));
}

/** Passt die Aktie zum gewählten Regionen-Filter? */
function passtZuRegion(a) {
  if (zustand.region === "ch") return a.land === "CH";
  if (zustand.region === "us") return a.land === "US";
  if (zustand.region === "andere") return a.land !== "CH" && a.land !== "US";
  return true;
}

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

function zeigeKopf() {
  const d = zustand.daten;
  $("datum").textContent = fmtDatum.format(new Date());
  if (!d) return;
  const erstellt = new Date(d.erstellt);
  // Heute: nur Uhrzeit, sonst Datum + Uhrzeit
  $("aktualisiert").textContent = isoTag(erstellt) === isoTag(new Date())
    ? `Stand ${fmtZeit.format(erstellt)}` : `Stand ${fmtDatumZeit.format(erstellt)}`;
  $("boersen-status").innerHTML = (d.boersen || []).map((b) => {
    const s = boersenStatus(b);
    return `<span class="chip ${s.offen ? "offen" : ""}" title="Ortszeit der Börse"><span class="punkt"></span><b>${esc(b.name)}</b> ${esc(s.text)}</span>`;
  }).join("");
}

/* ---------------------------------------------------------------------
   Bausteine
   --------------------------------------------------------------------- */

/** Mini-Chart (Sparkline) als SVG für den gewählten Zeitraum */
function sparkline(e, zeitraum = zustand.zeitraum) {
  const w = reiheImZeitraum(e, zeitraum).filter((v) => v !== null && !isNaN(v));
  if (w.length < 2) return '<svg viewBox="0 0 100 30"></svg>';
  const min = Math.min(...w), max = Math.max(...w), spanne = max - min || 1;
  const punkte = w.map((v, i) => [(i / (w.length - 1)) * 100, 28 - ((v - min) / spanne) * 26]);
  const linie = punkte.map((p) => p.map((z) => z.toFixed(2)).join(",")).join(" ");
  const klasse = w[w.length - 1] >= w[0] ? "plus" : "minus";
  return `<svg viewBox="0 0 100 30" preserveAspectRatio="none" class="${klasse}" aria-hidden="true">
    <polygon points="0,30 ${linie} 100,30" fill="currentColor" opacity="0.12"/>
    <polyline points="${linie}" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
  </svg>`;
}

function veraltetBadge(e) {
  if (!e.veraltet) return "";
  const t = e.kurs === null || e.kurs === undefined ? "keine Daten" : `Stand ${kurzDatum(e.datum)}`;
  return `<span class="badge" title="${esc(e.hinweis || "Quelle nicht erreichbar")}">⚠ ${t}</span>`;
}

function kachel(e) {
  const p = perf(e), d = diffPunkte(e);
  const aenderung = p === null ? "&nbsp;" : `${d === null ? "" : `${d >= 0 ? "+" : "−"}${zahl(Math.abs(d), 2)} `}(${prozent(p)})`;
  return `<article class="kachel">
    <div class="name"><span>${esc(e.name)}</span><span class="region">${esc(e.region || "")}</span></div>
    <div class="kurs">${zahl(e.kurs, stellen(e))}</div>
    <div class="veraenderung ${farbe(p)}">${aenderung}</div>
    ${veraltetBadge(e) ? `<div>${veraltetBadge(e)}</div>` : ""}
    ${sparkline(e)}
  </article>`;
}

/** Eine Listenzeile: Name | Kurs | Veränderung */
function zeile(e, { unter = "", mitKurs = true, rang = "" } = {}) {
  const p = perf(e);
  const unterText = unter || e.einheit || "";
  // Aktien lassen sich antippen -> Detailansicht mit Kennzahlen
  const klick = e.kategorie === "aktie" ? ` klickbar" data-symbol="${esc(e.symbol)}` : "";
  return `<div class="zeile ${mitKurs ? "" : "ohne-kurs"}${klick}">
    <div class="n">${rang ? `<span class="rang">${rang}</span>` : ""}${esc(e.name)}${veraltetBadge(e)}${unterText ? `<span class="unter">${esc(unterText)}</span>` : ""}</div>
    ${mitKurs ? `<div class="k">${zahl(e.kurs, stellen(e))}</div>` : ""}
    <div><span class="pill ${farbe(p)}">${prozent(p)}</span></div>
  </div>`;
}

function liste(eintraege, optionen = {}) {
  if (!eintraege || !eintraege.length) return '<p class="leise">Keine Daten.</p>';
  return `<div class="zeilen">${eintraege.map((e) => zeile(e, optionen)).join("")}</div>`;
}

/** Top & Flop (je 3) */
function topFlop(aktien, anzahl = 3) {
  const s = sortiertNachPerf(aktien);
  if (!s.length) return '<p class="leise">Keine Daten für diesen Zeitraum.</p>';
  const top = s.slice(0, anzahl), flop = s.slice(-anzahl).reverse();
  return `<div class="mover">
    <div><h3>▲ Top</h3>${liste(top, { mitKurs: false })}</div>
    <div><h3>▼ Flop</h3>${liste(flop, { mitKurs: false })}</div>
  </div>`;
}

/** Balkendiagramm mit Nullpunkt in der Mitte (grün nach rechts, rot nach links) */
function balkenDiagramm(eintraege, { klickbar = false } = {}) {
  const gueltig = eintraege.filter((x) => x.wert !== null);
  if (!gueltig.length) return '<p class="leise">Keine Daten für diesen Zeitraum.</p>';
  const maxAbs = Math.max(...gueltig.map((x) => Math.abs(x.wert)), 0.01);
  return gueltig.map((x) => {
    const breite = (Math.abs(x.wert) / maxAbs) * 50;          // max. halbe Breite
    const tag = klickbar ? "button" : "div";
    return `<${tag} class="balken-zeile" ${klickbar ? `type="button" data-sektor="${esc(x.name)}"` : ""} title="${esc(x.name)}: ${prozent(x.wert)}${x.info ? " · " + esc(x.info) : ""}">
      <span class="n">${esc(x.name)}${x.anzahl ? ` <span class="anz">(${x.anzahl})</span>` : ""}</span>
      <span class="spur"><span class="balken ${farbe(x.wert) || "plus"}" style="width:${breite.toFixed(2)}%"></span></span>
      <span class="wert ${farbe(x.wert)}">${prozent(x.wert)}</span>
    </${tag}>`;
  }).join("");
}

/* ---------------------------------------------------------------------
   Sektoren: eigene Aktien nach Branche gruppieren
   --------------------------------------------------------------------- */
function sektorGruppen() {
  const aktien = alleAktien().filter(passtZuRegion);
  const gruppen = new Map();
  for (const a of aktien) {
    const s = a.sektor || "Ohne Sektor";
    if (!gruppen.has(s)) gruppen.set(s, []);
    gruppen.get(s).push(a);
  }
  return [...gruppen.entries()].map(([name, titel]) => {
    const werte = titel.map(perf).filter((p) => p !== null);
    const schnitt = werte.length ? werte.reduce((a, b) => a + b, 0) / werte.length : null;
    return { name, titel, wert: schnitt, anzahl: titel.length };
  }).sort((a, b) => (b.wert ?? -1e9) - (a.wert ?? -1e9));
}

function zeigeSektoren() {
  const gruppen = sektorGruppen();
  $("sektor-balken").innerHTML = balkenDiagramm(gruppen, { klickbar: true });

  $("sektor-karten").innerHTML = gruppen.map((g) => {
    const s = sortiertNachPerf(g.titel);
    const ohneWert = g.titel.filter((a) => perf(a) === null);
    const zeilen = [...s, ...ohneWert].map((a, i) => {
      const rang = s.length > 1 && i === 0 ? "▲" : s.length > 1 && i === s.length - 1 ? "▼" : "";
      return zeile(a, { unter: LAENDER[a.land] || a.land || "", rang });
    }).join("");
    return `<section class="karte" id="sektor-${encodeURIComponent(g.name)}">
      <div class="sektor-kopf"><h2>${esc(g.name)}</h2><span class="pill ${farbe(g.wert)}" title="Durchschnitt">Ø ${prozent(g.wert)}</span></div>
      <div class="zeilen">${zeilen}</div>
    </section>`;
  }).join("");

  // US-Sektor-ETFs
  const us = (zustand.daten.sektoren_us || []).map((e) => ({ name: e.name, wert: perf(e), info: e.symbol }))
    .sort((a, b) => (b.wert ?? -1e9) - (a.wert ?? -1e9));
  $("us-sektoren").innerHTML = us.length ? balkenDiagramm(us) : '<p class="leise">Noch keine Daten (erscheinen nach dem nächsten Update).</p>';

  // Alle Aktien sortiert (jede nur einmal)
  const alle = eindeutig(alleAktien().filter(passtZuRegion));
  const s = sortiertNachPerf(alle);
  $("alle-aktien").innerHTML = liste([...s, ...alle.filter((a) => !s.includes(a))].map((a) => ({ ...a, einheit: a.sektor })));
}

/* ---------------------------------------------------------------------
   Fear & Greed: Halbkreis-Anzeige (0 = extreme Angst, 100 = extreme Gier)
   --------------------------------------------------------------------- */
function stimmungKlasse(w) {
  if (w < 25) return "angst-extrem";
  if (w < 45) return "angst";
  if (w <= 55) return "neutral";
  if (w < 75) return "gier";
  return "gier-extrem";
}

function tacho(wert) {
  // Punkt auf dem Halbkreis für einen Wert 0–100
  const pt = (v, r) => {
    const t = Math.PI * (1 - v / 100);
    return [(100 + r * Math.cos(t)).toFixed(2), (100 - r * Math.sin(t)).toFixed(2)];
  };
  const bogen = (von, bis, klasse) => {
    const [x1, y1] = pt(von + 0.8, 80), [x2, y2] = pt(bis - 0.8, 80);   // kleine Lücke zwischen den Feldern
    return `<path d="M${x1} ${y1} A80 80 0 0 1 ${x2} ${y2}" class="${klasse}" stroke="currentColor" stroke-width="14" fill="none"/>`;
  };
  const [nx, ny] = pt(Math.max(0, Math.min(100, wert)), 66);
  return `<svg viewBox="0 0 200 112" aria-hidden="true">
    ${bogen(0, 25, "angst-extrem")}${bogen(25, 45, "angst")}${bogen(45, 55, "neutral")}${bogen(55, 75, "gier")}${bogen(75, 100, "gier-extrem")}
    <line x1="100" y1="100" x2="${nx}" y2="${ny}" stroke="var(--text)" stroke-width="3.5" stroke-linecap="round"/>
    <circle cx="100" cy="100" r="6" fill="var(--text)"/>
  </svg>`;
}

function stimmungHtml(st) {
  if (!st || (!st.aktien && !st.krypto)) return '<p class="leise">Noch keine Daten (erscheinen nach dem nächsten Update).</p>';
  const block = (titel, x) => {
    if (!x) return `<div class="stimmung"><h3>${titel}</h3><p class="leise klein">Keine Daten</p></div>`;
    const vgl = [["Vortag", x.vortag], ["1 Woche", x.woche], ["1 Monat", x.monat], ["1 Jahr", x.jahr]]
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([t, v]) => `<span>${t} <b class="${stimmungKlasse(v)}">${Math.round(v)}</b></span>`).join("");
    return `<div class="stimmung" title="Quelle: ${esc(x.quelle)}">
      <h3>${titel}</h3>
      ${tacho(x.wert)}
      <div class="zahl">${Math.round(x.wert)}</div>
      <div class="wort ${stimmungKlasse(x.wert)}">${esc(x.text)}${x.veraltet ? ' <span class="badge">älter</span>' : ""}</div>
      <div class="vergleich">${vgl}</div>
    </div>`;
  };
  return block("Aktien (USA)", st.aktien) + block("Krypto", st.krypto);
}

/* ---------------------------------------------------------------------
   News & Kalender
   --------------------------------------------------------------------- */
function newsZeit(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const tag = isoTag(d);
  if (tag === isoTag(new Date())) return fmtZeit.format(d);
  if (tag === isoTag(new Date(Date.now() - 864e5))) return "gestern " + fmtZeit.format(d);
  return fmtTagKurz.format(d) + " " + fmtZeit.format(d);
}

function newsHtml(news) {
  if (!news || !news.length) return '<li class="leise">Keine Schlagzeilen verfügbar.</li>';
  return news.map((n) => `<li>
    <a href="${esc(sichererLink(n.link))}" target="_blank" rel="noopener noreferrer">${esc(n.titel)}</a>
    <div class="meta">${esc(n.quelle)} · ${newsZeit(n.zeit)}${(n.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}${n.veraltet ? ' <span class="badge">älter</span>' : ""}</div>
  </li>`).join("");
}

function kalenderHtml(termine, { maxTage = 99 } = {}) {
  const heute = isoTag(new Date());
  const morgen = isoTag(new Date(Date.now() + 864e5));
  const gestern = isoTag(new Date(Date.now() - 864e5));
  const kuerzel = { Schweiz: "CH", USA: "US", Eurozone: "EU" };
  let html = "", letzterTag = "", tage = 0;
  for (const t of termine || []) {
    if (t.datum < (maxTage < 99 ? heute : gestern)) continue;
    if (t.datum !== letzterTag) {
      if (++tage > maxTage) break;
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
  return html || '<p class="leise">Keine anstehenden Termine.</p>';
}

function quellenHtml(q) {
  if (!q) return "";
  const feeds = (q.feeds || []).map((f) => `<tr><td>${f.ok ? "✅" : "❌"}</td><td>${esc(f.name)}</td><td class="leise">${f.ok ? `${f.anzahl} Meldungen` : esc(f.fehler || "Fehler")}</td></tr>`).join("");
  const kurse = Object.entries(q.kurse || {}).map(([k, v]) => `${esc(k)}: ${v}`).join(" · ");
  return `
    <p><b>Kurse frisch geladen:</b> ${esc(q.kurse_frisch || "–")}<br><span class="leise">${kurse}</span></p>
    <p><b>Wirtschaftskalender:</b> ${esc(q.kalender || "–")}<br><b>Quartalszahlen:</b> ${esc(q.quartalszahlen || "–")}<br>
       <b>Fear &amp; Greed:</b> Aktien ${esc(q.fear_greed_aktien || "–")} · Krypto ${esc(q.fear_greed_krypto || "–")}</p>
    <p><b>News-Feeds beim letzten Update:</b></p>
    <table class="quellen-tab">${feeds}</table>`;
}

/* ---------------------------------------------------------------------
   Seite aufbauen (nur der sichtbare Tab wird neu gezeichnet)
   --------------------------------------------------------------------- */
function zeigeAlles() {
  const d = zustand.daten;
  zeigeKopf();
  zeigeSteuerung();
  if (!d) return;

  // Hinweise oben (Beispieldaten, alte Daten, offline)
  const hinweise = [];
  if (d.beispieldaten) hinweise.push("Dies sind BEISPIELDATEN. Echte Kurse erscheinen nach dem ersten automatischen Update.");
  const alterStd = (Date.now() - new Date(d.erstellt).getTime()) / 36e5;
  if (alterStd > 16) hinweise.push(`Die Daten sind ${Math.round(alterStd)} Stunden alt – das letzte automatische Update hat evtl. nicht geklappt.`);
  if (zustand.offline) hinweise.push("Offline: Es werden die zuletzt gespeicherten Daten angezeigt.");
  $("hinweise").innerHTML = hinweise.map((h) => `<div class="banner">${esc(h)}</div>`).join("");

  const zt = zustand.zeitraum === "1T" ? "heute" : ZEITRAEUME[zustand.zeitraum];
  document.querySelectorAll(".zeitraum-text").forEach((el) => { el.textContent = zt; });

  switch (zustand.tab) {
    case "uebersicht": {
      $("ueberblick").innerHTML = (d.zusammenfassung || []).map((s) => `<p>${esc(s)}</p>`).join("");
      $("auffaellig").innerHTML = (d.auffaelligkeiten || []).map((a) =>
        `<li class="${farbe(a.diff_pct)}">${a.diff_pct >= 0 ? "▲" : "▼"} ${esc(a.text)}</li>`).join("");
      $("indizes").innerHTML = (d.indizes || []).map(kachel).join("");
      $("stimmung").innerHTML = stimmungHtml(d.stimmung);
      zeigeAktieDesTages();
      zeigeFavoriten();
      zeigeUeberraschungen();
      zeigePolitikerKurz();
      $("wissen").innerHTML = wissenHtml();
      $("mover-ch").innerHTML = topFlop(eindeutig(alleAktien()).filter((a) => a.land === "CH"));
      $("mover-us").innerHTML = topFlop(eindeutig(alleAktien()).filter((a) => a.land === "US"));
      // Übersicht: nur wichtige Termine (alle übrigen im Tab "Kalender")
      $("kalender-kurz").innerHTML = kalenderHtml((d.kalender || []).filter((t) => t.wichtigkeit !== "tief"), { maxTage: 2 });
      $("news-kurz").innerHTML = newsHtml((d.news || []).slice(0, 5));
      break;
    }
    case "aktien": {
      const u = zustand.unter.aktien;
      $("aktien-titel").innerHTML = `${{ sektoren: "Sektoren", heatmap: "Heatmap", screener: "Screener", vergleich: "Vergleich" }[u]} <span class="etikett zeitraum-text">${esc(zt)}</span>`;
      if (u === "sektoren") zeigeSektoren();
      else if (u === "heatmap") zeigeHeatmap();
      else if (u === "screener") zeigeScreener();
      else zeigeVergleich();
      break;
    }
    case "insider":
      zeigeInsider();
      break;
    case "maerkte":
      if (zustand.unter.maerkte === "makro") { zeigeMakro(); break; }
      if (zustand.unter.maerkte === "saison") { zeigeSaison(); break; }
      if (zustand.unter.maerkte === "rechner") { zeigeRechner(); break; }
      $("indizes-liste").innerHTML = liste(d.indizes, { unter: "" });
      $("etfs").innerHTML = liste((d.etfs || []).map((e) => ({ ...e, einheit: e.isin || "" })));
      $("krypto").innerHTML = liste(d.krypto);
      $("rohstoffe").innerHTML = liste(d.rohstoffe);
      $("devisen").innerHTML = liste(d.devisen);
      $("weitere").innerHTML = liste(d.weitere);
      break;
    case "kalender":
      zeigeKalender();
      break;
    case "news": {
      let news = (d.news || []).filter((n) => zustand.newsFilter === "alle" || (n.region || "INT") === zustand.newsFilter);
      if (zustand.newsSortierung === "neu") news = [...news].sort((a, b) => (b.zeit || "").localeCompare(a.zeit || ""));
      $("news").innerHTML = newsHtml(news);
      $("quellen").innerHTML = quellenHtml(d.quellen);
      break;
    }
  }
}

/** Aktive Knöpfe markieren, richtigen Tab einblenden */
function zeigeSteuerung() {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("aktiv", b.dataset.tab === zustand.tab));
  document.querySelectorAll(".seite").forEach((s) => s.classList.toggle("aktiv", s.dataset.seite === zustand.tab));
  document.querySelectorAll("#zeitraum-wahl button").forEach((b) => b.classList.toggle("aktiv", b.dataset.zeitraum === zustand.zeitraum));
  document.querySelectorAll("#region-wahl button").forEach((b) => b.classList.toggle("aktiv", b.dataset.region === zustand.region));
  document.querySelectorAll("#news-sortierung button").forEach((b) => b.classList.toggle("aktiv", b.dataset.sortierung === zustand.newsSortierung));
  document.querySelectorAll("#news-filter button").forEach((b) => b.classList.toggle("aktiv", b.dataset.filter === zustand.newsFilter));
  // Unterbereiche ein-/ausblenden
  document.querySelectorAll("[data-unter]").forEach((b) => {
    const [tab, u] = b.dataset.unter.split(":");
    b.classList.toggle("aktiv", zustand.unter[tab] === u);
  });
  document.querySelectorAll("[data-unterseite]").forEach((el) => {
    const [tab, u] = el.dataset.unterseite.split(":");
    el.classList.toggle("aktiv", zustand.unter[tab] === u);
  });
  // Regionen-Filter braucht es beim Vergleich nicht
  document.querySelector(".region-zeile #region-wahl").classList.toggle("versteckt", zustand.unter.aktien === "vergleich");
  // Zeitraum-Leiste nur dort, wo sie etwas bewirkt
  const ohneZeitraum = ["news", "kalender", "insider"].includes(zustand.tab)
    || (zustand.tab === "maerkte" && zustand.unter.maerkte !== "kurse");
  $("zeitleiste").classList.toggle("versteckt", ohneZeitraum);
}

function wechsleUnterbereich(tab, u) {
  zustand.unter[tab] = u;
  merken("unter_" + tab, u);
  zeigeAlles();
}

function wechsleTab(tab) {
  zustand.tab = tab;
  merken("tab", tab);
  zeigeAlles();
  window.scrollTo({ top: 0 });
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
    zustand.daten = await antwort.json();
    zustand.geladenUm = Date.now();
    // Der Service Worker markiert Antworten aus dem Offline-Speicher
    zustand.offline = antwort.headers.get("X-Aus-Speicher") === "1";
    zeigeAlles();
    ladeFundamentaldaten();          // Kennzahlen im Hintergrund nachladen (kennzahlen.js)
  } catch (fehler) {
    console.error(fehler);
    zustand.offline = true;
    if (zustand.daten) {
      zeigeAlles();
    } else {
      zeigeSteuerung();
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
    distanz = (e.touches[0].clientY - startY) / 2;
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
   Start: Knöpfe verbinden
   --------------------------------------------------------------------- */
$("neu-laden").addEventListener("click", laden);

document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => wechsleTab(b.dataset.tab)));
document.querySelectorAll("[data-gehe]").forEach((b) => b.addEventListener("click", () => wechsleTab(b.dataset.gehe)));
document.querySelectorAll("[data-unter]").forEach((b) => b.addEventListener("click", () => {
  const [tab, u] = b.dataset.unter.split(":");
  wechsleUnterbereich(tab, u);
}));

document.querySelectorAll("#zeitraum-wahl button").forEach((b) => b.addEventListener("click", () => {
  zustand.zeitraum = b.dataset.zeitraum;
  merken("zeitraum2", zustand.zeitraum);
  zeigeAlles();
}));

document.querySelectorAll("#region-wahl button").forEach((b) => b.addEventListener("click", () => {
  zustand.region = b.dataset.region;
  merken("region", zustand.region);
  zeigeAlles();
}));

document.querySelectorAll("#news-sortierung button").forEach((b) => b.addEventListener("click", () => {
  zustand.newsSortierung = b.dataset.sortierung;
  merken("newsSortierung", zustand.newsSortierung);
  zeigeAlles();
}));
document.querySelectorAll("#news-filter button").forEach((b) => b.addEventListener("click", () => {
  zustand.newsFilter = b.dataset.filter;
  merken("newsFilter", zustand.newsFilter);
  zeigeAlles();
}));

// Tipp auf einen Sektor-Balken -> zur passenden Sektor-Karte springen
$("sektor-balken").addEventListener("click", (ev) => {
  const knopf = ev.target.closest("[data-sektor]");
  if (!knopf) return;
  const karte = document.getElementById("sektor-" + encodeURIComponent(knopf.dataset.sektor));
  if (!karte) return;
  karte.scrollIntoView({ behavior: "smooth", block: "center" });
  karte.classList.add("hervor");
  setTimeout(() => karte.classList.remove("hervor"), 1500);
});

// Wenn die App aus dem Hintergrund zurückkommt und die Daten älter als 10 Min. sind: neu laden
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && Date.now() - zustand.geladenUm > 10 * 60 * 1000) laden();
});

// Börsenstatus jede Minute aktualisieren
setInterval(zeigeKopf, 60 * 1000);

zeigeSteuerung();
pullToRefresh();
laden();

// Service Worker anmelden (für Offline-Betrieb)
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("Service Worker:", e));
  });
}
