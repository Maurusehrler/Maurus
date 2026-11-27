/* =====================================================================
   Börsen-Übersicht – Analyse-Werkzeuge
   ---------------------------------------------------------------------
   Heatmap · Screener · Vergleich + Korrelation · Makro (Zinsen &
   Konjunktur) · Saisonalität · Sparrechner · Favoriten · Suche ·
   Gewinn-Überraschungen
   ===================================================================== */
"use strict";

function speicherLesen(k, standard) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : standard; } catch (e) { return standard; } }
function speicherSchreiben(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* egal */ } }

/** Alle Einträge, die man suchen/öffnen kann (Aktien, Indizes, ETFs, Krypto …) */
function alleEintraege() {
  const d = zustand.daten || {};
  return [...eindeutig(alleAktien()), ...(d.indizes || []), ...(d.etfs || []), ...(d.krypto || []),
    ...(d.rohstoffe || []), ...(d.devisen || []), ...(d.weitere || []), ...(d.sektoren_us || [])];
}

/* =====================================================================
   FAVORITEN (werden nur auf diesem Gerät gespeichert)
   ===================================================================== */
let favoriten = speicherLesen("favoriten", []);
function istFavorit(symbol) { return favoriten.includes(symbol); }
function favoritUmschalten(symbol) {
  favoriten = istFavorit(symbol) ? favoriten.filter((s) => s !== symbol) : [...favoriten, symbol];
  speicherSchreiben("favoriten", favoriten);
}
function zeigeFavoriten() {
  const ziel = $("favoriten");
  if (!ziel) return;
  const liste = favoriten.map((s) => alleEintraege().find((e) => e.symbol === s)).filter(Boolean);
  ziel.innerHTML = liste.length ? liste.map((e) => zeile(e, { unter: e.sektor || e.einheit || "" })).join("")
    : '<p class="leise klein">Tippe bei einer Aktie auf ☆, um sie hier anzuzeigen.</p>';
  ziel.classList.add("zeilen");
}

/* =====================================================================
   SUCHE
   ===================================================================== */
function oeffneSuche() {
  $("suche").classList.remove("versteckt");
  $("suche-eingabe").value = "";
  zeigeSuchergebnis("");
  setTimeout(() => $("suche-eingabe").focus(), 50);
}
function schliesseSuche() { $("suche").classList.add("versteckt"); }
function zeigeSuchergebnis(text) {
  const t = text.trim().toLowerCase();
  const treffer = alleEintraege().filter((e) => !t || e.name.toLowerCase().includes(t) || e.symbol.toLowerCase().includes(t)
    || (e.sektor || "").toLowerCase().includes(t)).slice(0, 40);
  $("suche-ergebnis").innerHTML = treffer.length
    ? `<div class="zeilen">${treffer.map((e) => `<div class="zeile klickbar" data-symbol="${esc(e.symbol)}">
        <div class="n">${istFavorit(e.symbol) ? "⭐ " : ""}${esc(e.name)}<span class="unter">${esc(e.symbol)} · ${esc(e.sektor || KATEGORIE_NAMEN[e.kategorie] || "")}</span></div>
        <div class="k">${zahl(e.kurs, stellen(e))}</div>
        <div><span class="pill ${farbe(perf(e))}">${prozent(perf(e))}</span></div></div>`).join("")}</div>`
    : '<p class="leise">Nichts gefunden.</p>';
}
const KATEGORIE_NAMEN = { index: "Index", aktie: "Aktie", etf: "ETF", krypto: "Krypto", rohstoff: "Rohstoff", devisen: "Devisen", weitere: "Indikator", sektor: "US-Sektor" };

/* =====================================================================
   HEATMAP (Treemap: Fläche = Börsenwert, Farbe = Veränderung)
   ===================================================================== */
const FARB_GRENZE = { "1T": 3, "1W": 6, "1M": 10, "3M": 15, "YTD": 25, "1J": 30, "3J": 60, "5J": 100 };

/** In USD umrechnen, damit Börsenwerte vergleichbar sind */
function inUsd(betrag, waehrung) {
  if (!betrag) return 0;
  const dev = Object.fromEntries((zustand.daten.devisen || []).map((e) => [e.symbol, e.kurs]));
  const kurs = { USD: 1, CHF: dev["USDCHF=X"] ? 1 / dev["USDCHF=X"] : 1.25, EUR: dev["EURUSD=X"] || 1.1, JPY: 1 / 150, GBP: 1.27 }[waehrung];
  return betrag * (kurs || 1);
}

/** "Squarified" Treemap: verteilt Rechtecke möglichst quadratisch */
function treemap(eintraege, x, y, b, h) {
  const summe = eintraege.reduce((a, e) => a + e.wert, 0);
  if (!summe) return [];
  const skala = (b * h) / summe;
  const items = eintraege.map((e) => ({ ...e, flaeche: e.wert * skala }));
  const ergebnis = [];
  let reihe = [], rest = items.slice();
  const schlechtestes = (r, seite) => {
    const s = r.reduce((a, e) => a + e.flaeche, 0), max = Math.max(...r.map((e) => e.flaeche)), min = Math.min(...r.map((e) => e.flaeche));
    return Math.max((seite * seite * max) / (s * s), (s * s) / (seite * seite * min));
  };
  const legeReihe = (r) => {
    const s = r.reduce((a, e) => a + e.flaeche, 0);
    if (b >= h) {
      const breite = s / h; let yy = y;
      for (const e of r) { const hh = e.flaeche / breite; ergebnis.push({ ...e, x, y: yy, b: breite, h: hh }); yy += hh; }
      x += breite; b -= breite;
    } else {
      const hoehe = s / b; let xx = x;
      for (const e of r) { const bb = e.flaeche / hoehe; ergebnis.push({ ...e, x: xx, y, b: bb, h: hoehe }); xx += bb; }
      y += hoehe; h -= hoehe;
    }
  };
  while (rest.length) {
    const seite = Math.min(b, h), e = rest[0];
    if (!reihe.length || schlechtestes([...reihe, e], seite) <= schlechtestes(reihe, seite)) { reihe.push(e); rest.shift(); }
    else { legeReihe(reihe); reihe = []; }
  }
  if (reihe.length) legeReihe(reihe);
  return ergebnis;
}

function zeigeHeatmap() {
  const box = $("heatmap");
  const breite = box.clientWidth || 360;
  const hoehe = Math.max(420, Math.min(window.innerHeight * 0.72, breite * 1.1));
  box.style.height = hoehe + "px";
  const aktien = eindeutig(alleAktien()).filter(passtZuRegion).map((a) => {
    const f = fundamentalVon(a.symbol) || {};
    return { ...a, wert: inUsd(f.marktkap, f.waehrung) || 1e9 };
  });
  const sektoren = {};
  for (const a of aktien) (sektoren[a.sektor || "Andere"] = sektoren[a.sektor || "Andere"] || []).push(a);
  const sektorListe = Object.entries(sektoren).map(([name, titel]) => ({ name, titel, wert: titel.reduce((s, t) => s + t.wert, 0) }))
    .sort((a, b) => b.wert - a.wert);
  const grenze = FARB_GRENZE[zustand.zeitraum] || 10;
  let html = "";
  for (const s of treemap(sektorListe, 0, 0, breite, hoehe)) {
    html += `<div class="hm-sektor" style="left:${s.x}px;top:${s.y}px;width:${s.b}px;height:${s.h}px"><span class="hm-sektor-name">${esc(s.name)}</span></div>`;
    const innen = treemap(s.titel.sort((a, b) => b.wert - a.wert), s.x + 1, s.y + 15, Math.max(s.b - 2, 1), Math.max(s.h - 16, 1));
    for (const t of innen) {
      const p = perf(t);
      const gross = t.b > 46 && t.h > 30;
      html += `<button type="button" class="hm-zelle klickbar" data-symbol="${esc(t.symbol)}" title="${esc(t.name)}: ${prozent(p)}"
        style="left:${t.x}px;top:${t.y}px;width:${Math.max(t.b - 1, 0)}px;height:${Math.max(t.h - 1, 0)}px;background:${divergierendeFarbe(p, grenze)}">
        ${gross ? `<span class="hm-name">${esc(t.name.length > 14 && t.b < 90 ? t.symbol.split(".")[0] : t.name)}</span><span class="hm-wert">${prozent(p)}</span>` : ""}
      </button>`;
    }
  }
  box.innerHTML = html;
  $("heatmap-legende").innerHTML = `<span>${prozent(-grenze)}</span><span class="hm-skala"></span><span>${prozent(grenze)}</span>`;
}

/* =====================================================================
   SCREENER
   ===================================================================== */
const SCREENER_FELDER = [
  { k: "kgv_max", name: "KGV höchstens", feld: "kgv", vergleich: "max" },
  { k: "div_min", name: "Dividende mind. %", feld: "div_rendite", vergleich: "min" },
  { k: "marge_min", name: "Nettomarge mind. %", feld: "marge_netto", vergleich: "min" },
  { k: "roe_min", name: "Eigenkapitalrendite mind. %", feld: "roe", vergleich: "min" },
  { k: "wachstum_min", name: "Umsatzwachstum mind. %", feld: "umsatz_wachstum", vergleich: "min" },
  { k: "schulden_max", name: "Verschuldung höchstens %", feld: "verschuldung", vergleich: "max" },
  { k: "score_min", name: "Qualitäts-Score mind.", feld: "_score", vergleich: "min" },
  { k: "rsi_max", name: "RSI höchstens", feld: "_rsi", vergleich: "max" },
];
const SCREENER_VORLAGEN = [
  { name: "💰 Dividenden-Perlen", filter: { div_min: 3, schulden_max: 150 }, extra: (a, f) => !f.ausschuettung || f.ausschuettung <= 85, sort: "div_rendite" },
  { name: "💎 Günstige Qualität", filter: { kgv_max: 20, roe_min: 15, score_min: 55 }, sort: "_score" },
  { name: "🚀 Wachstum", filter: { wachstum_min: 15 }, sort: "umsatz_wachstum" },
  { name: "🏰 Hohe Margen", filter: { marge_min: 20, roe_min: 15 }, sort: "marge_netto" },
  { name: "📉 Überverkauft (RSI < 30)", filter: { rsi_max: 30 }, sort: "_rsi_auf" },
  { name: "📈 Aufwärtstrend", filter: {}, extra: (a) => a.trend === "aufwärts" && (a.abstand_ma200 || 0) > 0, sort: "_perf" },
  { name: "🕵️ Insider kaufen", filter: {}, extra: (a, f) => (f.insider || []).some((i) => i.art === "Kauf" && i.datum >= tageZurueck(120)), sort: "_score" },
  { name: "⭐ Top-Score", filter: { score_min: 70 }, sort: "_score" },
];
const SCREENER_SORTIERUNG = [["_score", "Qualitäts-Score"], ["_perf", "Kursveränderung (Zeitraum)"], ["kgv", "KGV (tief zuerst)"],
  ["div_rendite", "Dividende"], ["marge_netto", "Nettomarge"], ["umsatz_wachstum", "Umsatzwachstum"], ["marktkap", "Börsenwert"]];
let screener = speicherLesen("screener", { filter: {}, vorlage: null, sort: "_score" });

function tageZurueck(n) { return isoTag(new Date(Date.now() - n * 864e5)); }

function screenerWert(a, f, feld) {
  if (feld === "_score") return (qualitaetsScore(f, a) || {}).gesamt ?? null;
  if (feld === "_rsi" || feld === "_rsi_auf") return a.rsi ?? null;
  if (feld === "_perf") return perf(a);
  return f[feld] ?? null;
}

function zeigeScreener() {
  const vorlage = SCREENER_VORLAGEN.find((v) => v.name === screener.vorlage);
  $("screener-vorlagen").innerHTML = [`<button type="button" class="chip-knopf ${!vorlage ? "aktiv" : ""}" data-vorlage="">Alle</button>`,
    ...SCREENER_VORLAGEN.map((v) => `<button type="button" class="chip-knopf ${vorlage === v ? "aktiv" : ""}" data-vorlage="${esc(v.name)}">${esc(v.name)}</button>`)].join("");
  const filter = { ...(vorlage ? vorlage.filter : {}), ...screener.filter };
  $("screener-filter").innerHTML = SCREENER_FELDER.map((s) => `<label>${esc(s.name)}
      <input type="number" inputmode="decimal" class="eingabe" data-screener="${s.k}" value="${filter[s.k] ?? ""}" placeholder="egal"></label>`).join("")
    + `<button type="button" class="knopf" id="screener-zuruecksetzen">Filter zurücksetzen</button>`;
  const sortierung = screener.sort || (vorlage && vorlage.sort) || "_score";
  $("screener-sortierung").innerHTML = SCREENER_SORTIERUNG.map(([k, n]) => `<option value="${k}" ${k === sortierung ? "selected" : ""}>${n}</option>`).join("");
  if (!fundamental) { $("screener-ergebnis").innerHTML = '<p class="leise">Kennzahlen werden geladen …</p>'; return; }

  const treffer = eindeutig(alleAktien()).filter(passtZuRegion).filter((a) => {
    const f = fundamentalVon(a.symbol) || {};
    for (const s of SCREENER_FELDER) {
      const grenze = filter[s.k];
      if (grenze === undefined || grenze === null || grenze === "") continue;
      const w = screenerWert(a, f, s.feld);
      if (w === null || w === undefined) return false;
      if (s.vergleich === "max" ? w > grenze || (s.feld === "kgv" && w <= 0) : w < grenze) return false;
    }
    return !(vorlage && vorlage.extra) || vorlage.extra(a, f);
  });
  const aufsteigend = sortierung === "kgv" || sortierung === "_rsi_auf";
  treffer.sort((a, b) => {
    const wa = screenerWert(a, fundamentalVon(a.symbol) || {}, sortierung), wb = screenerWert(b, fundamentalVon(b.symbol) || {}, sortierung);
    if (wa === null) return 1; if (wb === null) return -1;
    return aufsteigend ? wa - wb : wb - wa;
  });
  $("screener-titel").textContent = `${treffer.length} Treffer`;
  $("screener-ergebnis").innerHTML = treffer.length ? `<div class="zeilen">${treffer.map((a) => {
    const f = fundamentalVon(a.symbol) || {}, sc = qualitaetsScore(f, a);
    return `<div class="zeile screener-zeile klickbar" data-symbol="${esc(a.symbol)}">
      <div class="n">${esc(a.name)}<span class="unter">${esc(a.sektor || "")} · KGV ${f.kgv ? zahl(f.kgv, 1) : "–"} · Div. ${pz(f.div_rendite)} · Marge ${pz(f.marge_netto)}</span></div>
      <div>${sc ? `<span class="score-mini score-${sc.stufe}" title="Qualitäts-Score">${sc.gesamt}</span>` : ""}</div>
      <div><span class="pill ${farbe(perf(a))}">${prozent(perf(a))}</span></div></div>`;
  }).join("")}</div>` : '<p class="leise">Keine Aktie erfüllt alle Bedingungen.</p>';
}

/* =====================================================================
   VERGLEICH + KORRELATION
   ===================================================================== */
let vergleich = speicherLesen("vergleich", ["NESN.SW", "NOVN.SW", "ROG.SW"]);

function zeigeVergleich() {
  const aktien = eindeutig(alleAktien());
  const auswahl = vergleich.map((s) => alleEintraege().find((e) => e.symbol === s)).filter(Boolean);
  $("vergleich-liste").innerHTML = aktien.map((a) => `<option value="${esc(a.name)} (${esc(a.symbol)})"></option>`).join("");
  $("vergleich-auswahl").innerHTML = auswahl.map((e, i) => `<span class="vergleich-chip"><i style="background:${SERIEN_FARBEN[i]}"></i>${esc(e.name)}
    <button type="button" data-vergleich-weg="${esc(e.symbol)}" aria-label="${esc(e.name)} entfernen">✕</button></span>`).join("")
    || '<span class="leise klein">Noch keine Aktie gewählt.</span>';

  // Chart: alle starten bei 100
  const lang = LANGE_ZEITRAEUME.includes(zustand.zeitraum);
  const serien = auswahl.map((e, i) => {
    const r = reiheImZeitraum(e);
    const basis = r.find((v) => v) || 1;
    return { name: e.name, x: r.map((_, j) => j - r.length + 1), y: r.map((v) => (v ? (v / basis) * 100 : null)), farbe: SERIEN_FARBEN[i] };
  });
  $("vergleich-chart").innerHTML = serien.length ? linienChart(serien, {
    xTyp: "zahl", hoehe: 200, titel: "Vergleich", legende: true,
    xFormat: (x) => (x === 0 ? "heute" : `${Math.abs(Math.round(x))} ${lang ? "Wo." : "T."}`),
    xTooltip: (x) => (x === 0 ? "heute" : `vor ${Math.abs(Math.round(x))} ${lang ? "Wochen" : "Handelstagen"}`),
    yFormat: (v) => zahl(v, 0), yTooltip: (v) => `${zahl(v, 1)} (${prozent(v - 100)})`,
  }) : "";

  // Kennzahlen-Tabelle
  const zeilenDef = [["Kurs", (e) => zahl(e.kurs, stellen(e))], ["Veränderung", (e) => `<span class="${farbe(perf(e))}">${prozent(perf(e))}</span>`],
    ["Qualitäts-Score", (e, f) => { const s = qualitaetsScore(f, e); return s ? `<span class="score-mini score-${s.stufe}">${s.gesamt}</span>` : "–"; }],
    ["KGV", (e, f) => (f.kgv ? zahl(f.kgv, 1) : "–")], ["KGV erwartet", (e, f) => (f.kgv_fwd ? zahl(f.kgv_fwd, 1) : "–")],
    ["Dividende", (e, f) => pz(f.div_rendite, 2)], ["Nettomarge", (e, f) => pz(f.marge_netto)], ["Eigenkapitalrendite", (e, f) => pz(f.roe)],
    ["Umsatzwachstum", (e, f) => (f.umsatz_wachstum !== undefined && f.umsatz_wachstum !== null ? prozent(f.umsatz_wachstum) : "–")],
    ["Verschuldung", (e, f) => pz(f.verschuldung, 0)], ["Börsenwert", (e, f) => betrag(f.marktkap, f.waehrung)], ["RSI", (e) => (e.rsi ? zahl(e.rsi, 0) : "–")]];
  $("vergleich-tabelle").innerHTML = auswahl.length ? `<div class="tabelle-wrap"><table class="vergleich-tab">
    <thead><tr><th></th>${auswahl.map((e, i) => `<th><i class="farb-punkt" style="background:${SERIEN_FARBEN[i]}"></i>${esc(e.name)}</th>`).join("")}</tr></thead>
    <tbody>${zeilenDef.map(([n, fn]) => `<tr><td>${n}</td>${auswahl.map((e) => `<td>${fn(e, fundamentalVon(e.symbol) || {})}</td>`).join("")}</tr>`).join("")}</tbody>
  </table></div>` : "";
  zeigeKorrelation(auswahl);
}

/** Korrelation der täglichen (bzw. wöchentlichen) Renditen */
function korrelation(a, b) {
  const n = Math.min(a.length, b.length);
  const x = a.slice(-n), y = b.slice(-n);
  const mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}
function renditen(reihe) {
  const r = [];
  for (let i = 1; i < reihe.length; i++) if (reihe[i] && reihe[i - 1]) r.push(reihe[i] / reihe[i - 1] - 1);
  return r;
}
function zeigeKorrelation(auswahl) {
  if (auswahl.length < 2) { $("korrelation").innerHTML = '<p class="leise klein">Mindestens 2 Aktien wählen.</p>'; return; }
  const z = zustand.zeitraum === "1T" || zustand.zeitraum === "1W" ? "3M" : zustand.zeitraum;
  const r = auswahl.map((e) => renditen(reiheImZeitraum(e, z)));
  const kopf = auswahl.map((e, i) => `<th><i class="farb-punkt" style="background:${SERIEN_FARBEN[i]}"></i>${esc(e.symbol.split(".")[0])}</th>`).join("");
  const zeilen = auswahl.map((e, i) => `<tr><th><i class="farb-punkt" style="background:${SERIEN_FARBEN[i]}"></i>${esc(e.symbol.split(".")[0])}</th>${auswahl.map((_, j) => {
    const k = i === j ? 1 : korrelation(r[i], r[j]);
    const hg = k === null ? "transparent" : `color-mix(in srgb, ${k >= 0 ? "var(--serie-2)" : "var(--serie-1)"} ${Math.round(Math.abs(k) * 70)}%, var(--karte))`;
    return `<td style="background:${hg}">${k === null ? "–" : zahl(k, 2)}</td>`;
  }).join("")}</tr>`).join("");
  $("korrelation").innerHTML = `<div class="tabelle-wrap"><table class="korr-tab"><thead><tr><th></th>${kopf}</tr></thead><tbody>${zeilen}</tbody></table></div>
    <p class="leise klein">Berechnet aus den ${LANGE_ZEITRAEUME.includes(z) ? "wöchentlichen" : "täglichen"} Kursänderungen (${esc(ZEITRAEUME[z])}).</p>`;
}

/* =====================================================================
   MAKRO: Zinsen & Konjunktur
   ===================================================================== */
function makroChart(schluessel, titel, info) {
  const reihen = ((zustand.daten.makro || {}).reihen) || {};
  const serien = schluessel.map((k, i) => reihen[k] && { name: reihen[k].name, x: reihen[k].daten, y: reihen[k].werte, farbe: SERIEN_FARBEN[i] }).filter(Boolean);
  if (!serien.length) return "";
  const aktuell = schluessel.map((k, i) => reihen[k] && `<span class="makro-wert"><i class="farb-punkt" style="background:${SERIEN_FARBEN[i]}"></i>${esc(reihen[k].name)} <b>${zahl(reihen[k].aktuell, 2)}${reihen[k].einheit.startsWith("%") ? " %" : ""}</b>${reihen[k].veraltet ? ' <span class="badge">alt</span>' : ""}</span>`).filter(Boolean).join("");
  const einheit = reihen[schluessel.find((k) => reihen[k])].einheit;
  return `<section class="karte"><h2>${titel}</h2><div class="makro-werte">${aktuell}</div>
    ${linienChart(serien, { einheit: einheit.startsWith("%") ? "%" : einheit, nullLinie: true, yTooltip: (v) => zahl(v, 2), titel, ohneLegende: true })}
    ${info ? `<p class="leise klein">${info}</p>` : ""}</section>`;
}

function zeigeMakro() {
  const m = zustand.daten.makro;
  if (!m) { $("makro").innerHTML = '<section class="karte"><p class="leise">Makrodaten erscheinen nach dem nächsten Update.</p></section>'; return; }
  let html = "";
  const k = m.zinskurve;
  if (k && k.laufzeiten) {
    const idx = k.laufzeiten.map((_, i) => i);
    const serien = [{ name: "Heute", x: idx, y: k.heute, farbe: SERIEN_FARBEN[0], dicke: 2.5 },
      { name: "Vor 1 Monat", x: idx, y: k.monat, farbe: SERIEN_FARBEN[1], gestrichelt: true },
      { name: "Vor 1 Jahr", x: idx, y: k.jahr, farbe: SERIEN_FARBEN[2], gestrichelt: true }];
    const invertiert = k.heute[k.laufzeiten.indexOf("2J")] > k.heute[k.laufzeiten.indexOf("10J")];
    html += `<section class="karte"><h2>US-Zinskurve <span class="etikett">${kurzDatum(k.datum)}${(k.datum || "").slice(0, 4)}</span></h2>
      ${linienChart(serien, { xTyp: "zahl", einheit: "%", xFormat: (x) => k.laufzeiten[Math.round(x)] || "", xTooltip: (x) => `Laufzeit ${k.laufzeiten[Math.round(x)]}`, yTooltip: (v) => zahl(v, 2), titel: "Zinskurve" })}
      <p class="leise klein">Zinsen für US-Staatsanleihen nach Laufzeit. Normal steigt die Kurve. ${invertiert ? "<b>Aktuell ist sie invertiert (kurze Zinsen höher als lange)</b> – das ging in der Vergangenheit oft einer Rezession voraus." : "Aktuell ist sie normal (lange Zinsen höher als kurze)."}</p></section>`;
  }
  html += makroChart(["leitzins_snb", "leitzins_ezb", "leitzins_fed"], "Leitzinsen der Notenbanken", "Die Leitzinsen bestimmen, wie teuer Geld ist. Sinkende Zinsen helfen meist der Börse.");
  html += makroChart(["rendite_ch10", "rendite_de10", "rendite_us10"], "Rendite 10-jähriger Staatsanleihen");
  html += makroChart(["spread_10_2"], "Rezessions-Signal: US-Zinsdifferenz 10J − 2J", "Fällt die Linie unter 0 (invertierte Zinskurve), folgte historisch oft innerhalb von 6–24 Monaten eine Rezession. Kein sicherer Indikator.");
  html += makroChart(["inflation_ch", "inflation_ez", "inflation_us"], "Inflation (Teuerung ggü. Vorjahr)", "Ziel der Notenbanken: SNB 0–2 %, EZB und Fed 2 %.");
  html += makroChart(["arbeitslos_ch", "arbeitslos_ez", "arbeitslos_us"], "Arbeitslosenquote");
  html += makroChart(["bip_ch", "bip_ez", "bip_us"], "Wirtschaftswachstum (BIP ggü. Vorjahr)");
  $("makro").innerHTML = html;
}

/* =====================================================================
   SAISONALITÄT
   ===================================================================== */
let saisonIndex = speicherLesen("saisonIndex", "SMI");
const MONATE = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

function zeigeSaison() {
  const s = zustand.daten.saison || {};
  const namen = Object.keys(s);
  if (!namen.length) { $("saison").innerHTML = '<p class="leise">Daten erscheinen nach dem nächsten Update.</p>'; return; }
  if (!s[saisonIndex]) saisonIndex = namen[0];
  $("saison-wahl").innerHTML = namen.map((n) => `<button type="button" data-saison="${esc(n)}" class="${n === saisonIndex ? "aktiv" : ""}">${esc(n)}</button>`).join("");
  const d = s[saisonIndex];
  const maxAbs = Math.max(...d.monate.map((m) => Math.abs(m.schnitt || 0)), ...Object.values(d.dieses_jahr || {}).map((v) => Math.abs(v)), 0.5);
  const jetzt = new Date().getMonth() + 1;
  const spalten = d.monate.map((m) => {
    const h = (Math.abs(m.schnitt || 0) / maxAbs) * 50;
    const dj = (d.dieses_jahr || {})[m.monat];
    const djPos = dj === undefined ? null : 50 - (dj / maxAbs) * 50;
    return `<div class="saison-spalte ${m.monat === jetzt ? "aktuell" : ""}" title="${MONATE[m.monat - 1]}: Ø ${prozent(m.schnitt)}, in ${m.positiv} % der Jahre positiv${dj !== undefined ? `, ${new Date().getFullYear()}: ${prozent(dj)}` : ""}">
      <div class="saison-wert ${farbe(m.schnitt)}">${m.schnitt === null ? "–" : (m.schnitt >= 0 ? "+" : "−") + zahl(Math.abs(m.schnitt), 1)}</div>
      <div class="saison-flaeche">
        <div class="saison-balken ${m.schnitt >= 0 ? "plus" : "minus"}" style="height:${h.toFixed(1)}%;${m.schnitt >= 0 ? "bottom:50%" : "top:50%"}"></div>
        ${djPos === null ? "" : `<span class="saison-punkt" style="top:${Math.max(0, Math.min(100, djPos)).toFixed(1)}%"></span>`}
      </div>
      <div class="saison-monat">${MONATE[m.monat - 1]}</div>
      <div class="saison-positiv">${m.positiv === null ? "" : Math.round(m.positiv) + "%"}</div>
    </div>`;
  }).join("");
  $("saison").innerHTML = `<div class="saison-chart">${spalten}</div>
    <div class="legende"><span><i style="background:var(--plus)"></i>Ø Monatsrendite ${d.von}–${d.bis}</span><span><i class="rund" style="background:var(--text)"></i>${new Date().getFullYear()}</span><span class="leise">Zahl unten = Anteil Jahre mit Gewinn</span></div>
    <p class="leise klein">Vergangene Muster („Sell in May“, „Jahresendrally“) sind keine Garantie für die Zukunft.</p>`;
}

/* =====================================================================
   SPARRECHNER (Zinseszins)
   ===================================================================== */
let rechner = speicherLesen("rechner", { start: 10000, monat: 500, jahre: 20, rendite: 6, inflation: 0 });

/** Durchschnittliche Jahresrendite aus der 5-Jahres-Performance */
function jahresRendite(symbol) {
  const e = alleEintraege().find((x) => x.symbol === symbol);
  const p = e && e.perf && e.perf["5J"];
  return p === undefined || p === null ? null : (Math.pow(1 + p / 100, 1 / 5) - 1) * 100;
}

function zeigeRechner() {
  const felder = [["start", "Startkapital (Fr.)"], ["monat", "Sparrate pro Monat (Fr.)"], ["jahre", "Anlagedauer (Jahre)"], ["rendite", "Rendite pro Jahr (%)"], ["inflation", "Inflation abziehen (%)"]];
  if (!$("rechner-eingabe").dataset.fertig) {
    $("rechner-eingabe").innerHTML = felder.map(([k, n]) => `<label>${n}<input type="number" inputmode="decimal" class="eingabe" data-rechner="${k}" value="${rechner[k]}"></label>`).join("");
    $("rechner-eingabe").dataset.fertig = "1";
  }
  const vorlagen = [["Vorsichtig", 3], ["Ausgewogen", 5], ["Aktien weltweit (Ø langfristig)", 7]];
  for (const [sym, name] of [["^SSMI", "SMI"], ["^GSPC", "S&P 500"]]) {
    const r = jahresRendite(sym);
    if (r !== null) vorlagen.push([`${name} letzte 5 J.`, Math.round(r * 10) / 10]);
  }
  $("rechner-vorlagen").innerHTML = vorlagen.map(([n, r]) => `<button type="button" class="chip-knopf" data-rendite="${r}">${esc(n)}: ${zahl(r, 1)} %</button>`).join("");

  const { start, monat, jahre, rendite, inflation } = rechner;
  const r = (rendite - inflation) / 100 / 12;
  let wert = start, eingezahlt = start;
  const x = [0], yWert = [start], yEin = [start];
  for (let m = 1; m <= Math.min(jahre, 60) * 12; m++) {
    wert = wert * (1 + r) + monat;
    eingezahlt += monat;
    if (m % 12 === 0) { x.push(m / 12); yWert.push(Math.round(wert)); yEin.push(eingezahlt); }
  }
  const ertrag = wert - eingezahlt;
  $("rechner-ergebnis").innerHTML = `
    <div class="rechner-zahlen">
      <div><span class="leise klein">Endwert nach ${jahre} Jahren</span><b class="gross-zahl">${zahl(wert, 0)} Fr.</b></div>
      <div><span class="leise klein">Eingezahlt</span><b>${zahl(eingezahlt, 0)} Fr.</b></div>
      <div><span class="leise klein">Ertrag (Zinseszins)</span><b class="${farbe(ertrag)}">${zahl(ertrag, 0)} Fr.</b></div>
    </div>
    ${linienChart([{ name: "Vermögen", x, y: yWert, farbe: "var(--serie-1)", flaeche: true }, { name: "Eingezahlt", x, y: yEin, farbe: "var(--serie-2)", gestrichelt: true }],
      { xTyp: "zahl", hoehe: 200, xFormat: (v) => `${Math.round(v)} J.`, xTooltip: (v) => `nach ${Math.round(v)} Jahren`, yFormat: (v) => (v >= 1e6 ? zahl(v / 1e6, 1) + " Mio" : zahl(v / 1000, 0) + "k"), yTooltip: (v) => zahl(v, 0) + " Fr.", titel: "Sparplan" })}
    <p class="leise klein">${inflation ? `Rendite nach Abzug von ${zahl(inflation, 1)} % Inflation (Kaufkraft von heute). ` : ""}Vereinfachte Rechnung ohne Steuern und Gebühren. Vergangene Renditen sind keine Garantie.</p>`;
}

/* =====================================================================
   GEWINN-ÜBERRASCHUNGEN (Übersicht)
   ===================================================================== */
function zeigeUeberraschungen() {
  const ziel = $("ueberraschungen");
  if (!ziel) return;
  if (!fundamental) { ziel.innerHTML = '<p class="leise klein">Wird geladen …</p>'; return; }
  const grenze = tageZurueck(35);
  const liste = [];
  for (const [symbol, f] of Object.entries(fundamental.aktien || {})) {
    const letzte = (f.ueberraschungen || []).slice(-1)[0];
    // Quartalsende + Meldung ca. 3–6 Wochen später: nur kürzlich gemeldete anzeigen
    const termin = f.termine && f.termine.zahlen;
    if (letzte && letzte.prozent !== null && letzte.prozent !== undefined && termin && termin < isoTag(new Date()) && termin >= grenze) {
      liste.push({ symbol, name: f.name, ...letzte, datum: termin });
    }
  }
  // Ersatz: letzte gemeldete Quartale (falls Termine schon in die Zukunft verschoben sind)
  if (!liste.length) {
    for (const [symbol, f] of Object.entries(fundamental.aktien || {})) {
      const letzte = (f.ueberraschungen || []).slice(-1)[0];
      if (letzte && letzte.prozent !== null && letzte.quartal >= tageZurueck(80)) liste.push({ symbol, name: f.name, ...letzte });
    }
  }
  liste.sort((a, b) => Math.abs(b.prozent) - Math.abs(a.prozent));
  ziel.innerHTML = liste.length ? `<div class="zeilen">${liste.slice(0, 8).map((u) => `<div class="zeile klickbar" data-symbol="${esc(u.symbol)}">
      <div class="n">${esc(u.name)}<span class="unter">Gewinn/Aktie ${zahl(u.ist, 2)} statt erwartet ${zahl(u.schaetzung, 2)}</span></div>
      <div class="k klein">${u.prozent >= 0 ? "übertroffen" : "verfehlt"}</div>
      <div><span class="pill ${farbe(u.prozent)}">${prozent(u.prozent)}</span></div></div>`).join("")}</div>`
    : '<p class="leise klein">Keine kürzlich gemeldeten Quartalszahlen.</p>';
}

/* =====================================================================
   Bedienung
   ===================================================================== */
document.addEventListener("click", (ev) => {
  const v = ev.target.closest("[data-vorlage]");
  if (v) { screener = { filter: {}, vorlage: v.dataset.vorlage || null, sort: null }; speicherSchreiben("screener", screener); zeigeScreener(); return; }
  if (ev.target.closest("#screener-zuruecksetzen")) { screener = { filter: {}, vorlage: null, sort: "_score" }; speicherSchreiben("screener", screener); zeigeScreener(); return; }
  const weg = ev.target.closest("[data-vergleich-weg]");
  if (weg) { vergleich = vergleich.filter((s) => s !== weg.dataset.vergleichWeg); speicherSchreiben("vergleich", vergleich); zeigeVergleich(); return; }
  const si = ev.target.closest("[data-saison]");
  if (si) { saisonIndex = si.dataset.saison; speicherSchreiben("saisonIndex", saisonIndex); zeigeSaison(); return; }
  const rr = ev.target.closest("[data-rendite]");
  if (rr) { rechner.rendite = Number(rr.dataset.rendite); document.querySelector('[data-rechner="rendite"]').value = rechner.rendite; speicherSchreiben("rechner", rechner); zeigeRechner(); return; }
  if (ev.target.closest("#suche-knopf")) { oeffneSuche(); return; }
  if (ev.target.closest("#suche-zu")) { schliesseSuche(); return; }
  if (ev.target.closest("#suche .klickbar")) schliesseSuche();
});

document.addEventListener("change", (ev) => {
  const sf = ev.target.closest("[data-screener]");
  if (sf) {
    const w = sf.value === "" ? null : Number(sf.value);
    screener.filter = { ...screener.filter, [sf.dataset.screener]: w };
    speicherSchreiben("screener", screener); zeigeScreener(); return;
  }
  if (ev.target.id === "screener-sortierung") { screener.sort = ev.target.value; speicherSchreiben("screener", screener); zeigeScreener(); return; }
  if (ev.target.id === "vergleich-suche") {
    const text = ev.target.value;
    const m = text.match(/\(([^)]+)\)\s*$/);
    const t = (m ? m[1] : text).trim().toLowerCase();
    const treffer = alleEintraege().find((e) => e.symbol.toLowerCase() === t || e.name.toLowerCase() === t)
      || alleEintraege().find((e) => e.name.toLowerCase().includes(t));
    if (treffer && !vergleich.includes(treffer.symbol)) {
      vergleich = [...vergleich, treffer.symbol].slice(-5);
      speicherSchreiben("vergleich", vergleich);
    }
    ev.target.value = "";
    zeigeVergleich();
  }
});

document.addEventListener("input", (ev) => {
  const rf = ev.target.closest("[data-rechner]");
  if (rf) { rechner[rf.dataset.rechner] = Number(rf.value) || 0; speicherSchreiben("rechner", rechner); zeigeRechner(); return; }
  if (ev.target.id === "suche-eingabe") zeigeSuchergebnis(ev.target.value);
});

// Heatmap bei Drehen des iPads neu zeichnen
window.addEventListener("resize", () => { if (zustand.tab === "aktien" && zustand.unter.aktien === "heatmap") zeigeHeatmap(); });
