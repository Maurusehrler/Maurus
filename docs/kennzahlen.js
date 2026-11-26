/* =====================================================================
   Börsen-Übersicht – Kennzahlen, Aktie des Tages, Finanzwissen
   ---------------------------------------------------------------------
   - lädt data/fundamentals.json (wird 1x täglich von GitHub erneuert)
   - "Aktie des Tages" und "Begriff des Tages" auf der Übersicht
   - Detailansicht pro Aktie (Fenster von unten) mit allen Kennzahlen
   Die Ampel-Bewertungen sind grobe Faustregeln zur Orientierung –
   keine Anlageberatung. Je nach Branche sind andere Werte normal.
   ===================================================================== */
"use strict";

const FUNDAMENTAL_URL = "data/fundamentals.json";
let fundamental = null;          // geladene Fundamentaldaten
let fundamentalStand = "";       // zu welchem Daten-Update sie gehören
let aktieVersatz = 0;            // "Nächste Aktie" auf der Übersicht
let blattZeitraum = null;        // Zeitraum im Detailfenster

/* ---------------------------------------------------------------------
   Laden
   --------------------------------------------------------------------- */
async function ladeFundamentaldaten() {
  const stand = (zustand.daten && zustand.daten.erstellt) || "";
  if (fundamental && fundamentalStand === stand) return;
  try {
    const antwort = await fetch(`${FUNDAMENTAL_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!antwort.ok) throw new Error(`HTTP ${antwort.status}`);
    fundamental = await antwort.json();
    fundamentalStand = stand;
  } catch (e) {
    console.warn("Fundamentaldaten:", e);
  }
  if (zustand.tab === "uebersicht") zeigeAktieDesTages();
}

function fundamentalVon(symbol) {
  return (fundamental && fundamental.aktien && fundamental.aktien[symbol]) || null;
}

/* ---------------------------------------------------------------------
   Formatierung
   --------------------------------------------------------------------- */

/** Grosse Beträge: 1'234'000'000 -> "1.23 Mrd." */
function betrag(n, waehrung = "") {
  if (n === null || n === undefined || isNaN(n)) return "–";
  const a = Math.abs(n);
  const w = waehrung ? " " + waehrung : "";
  if (a >= 1e12) return zahl(n / 1e12, 2) + " Bio." + w;
  if (a >= 1e9) return zahl(n / 1e9, 2) + " Mrd." + w;
  if (a >= 1e6) return zahl(n / 1e6, 1) + " Mio." + w;
  return zahl(n, 0) + w;
}

function pz(n, stellen = 1) {
  return n === null || n === undefined || isNaN(n) ? "–" : zahl(n, stellen) + " %";
}

/** Veränderung in % zwischen zwei Werten (bei negativem Vorjahr nicht sinnvoll) */
function veraenderung(neu, alt) {
  if (neu === null || neu === undefined || !alt || alt <= 0) return null;
  return (neu / alt - 1) * 100;
}

const EMPFEHLUNG = { strong_buy: "Stark kaufen", buy: "Kaufen", hold: "Halten", underperform: "Untergewichten", sell: "Verkaufen" };
const LAND_FLAGGE = { CH: "🇨🇭", US: "🇺🇸", DE: "🇩🇪", JP: "🇯🇵", UK: "🇬🇧", FR: "🇫🇷", NL: "🇳🇱", IT: "🇮🇹" };

/* ---------------------------------------------------------------------
   Kennzahlen: Bedeutung + Ampel-Faustregel
   stufe: gut / mittel / schlecht / neutral
   --------------------------------------------------------------------- */
function stufe(wert, grenzen, woerter, hoeherIstBesser = false) {
  // grenzen = [g1, g2]; woerter = [gut, mittel, schlecht]
  if (wert === null || wert === undefined || isNaN(wert)) return null;
  const [g1, g2] = grenzen;
  if (hoeherIstBesser) {
    if (wert >= g2) return { stufe: "gut", wort: woerter[0] };
    if (wert >= g1) return { stufe: "mittel", wort: woerter[1] };
    return { stufe: "schlecht", wort: woerter[2] };
  }
  if (wert < g1) return { stufe: "gut", wort: woerter[0] };
  if (wert <= g2) return { stufe: "mittel", wort: woerter[1] };
  return { stufe: "schlecht", wort: woerter[2] };
}

const BEWERTUNG = (v) => (v !== null && v !== undefined && v <= 0 ? { stufe: "schlecht", wort: "Verlust" } : null);

const KENNZAHLEN = [
  {
    gruppe: "Bewertung – ist die Aktie teuer?",
    werte: [
      { k: "kgv", name: "KGV (Kurs-Gewinn-Verhältnis)", fmt: (v) => zahl(v, 1),
        info: "Aktienkurs geteilt durch den Gewinn pro Aktie der letzten 12 Monate. Ein KGV von 20 heisst: Du zahlst das 20-Fache des Jahresgewinns. Wachstumsfirmen haben oft ein höheres KGV.",
        ampel: (v) => BEWERTUNG(v) || stufe(v, [15, 25], ["günstig", "fair", "hoch"]) },
      { k: "kgv_fwd", name: "KGV erwartet (nächste 12 Monate)", fmt: (v) => zahl(v, 1),
        info: "Wie das KGV, aber mit dem von Analysten erwarteten Gewinn. Ist es tiefer als das normale KGV, wird Gewinnwachstum erwartet.",
        ampel: (v) => BEWERTUNG(v) || stufe(v, [15, 25], ["günstig", "fair", "hoch"]) },
      { k: "peg", name: "PEG (KGV im Verhältnis zum Wachstum)", fmt: (v) => zahl(v, 2),
        info: "KGV geteilt durch das erwartete jährliche Gewinnwachstum. Unter 1 gilt als günstig im Verhältnis zum Wachstum.",
        ampel: (v) => BEWERTUNG(v) || stufe(v, [1, 2], ["günstig", "fair", "hoch"]) },
      { k: "kbv", name: "KBV (Kurs-Buchwert-Verhältnis)", fmt: (v) => zahl(v, 2),
        info: "Börsenwert geteilt durch das Eigenkapital in der Bilanz. Unter 1 = Börse bewertet die Firma tiefer als ihr Buchwert. Bei Banken und Versicherungen besonders wichtig.",
        ampel: (v) => BEWERTUNG(v) || stufe(v, [1.5, 4], ["günstig", "fair", "hoch"]) },
      { k: "kuv", name: "KUV (Kurs-Umsatz-Verhältnis)", fmt: (v) => zahl(v, 2),
        info: "Börsenwert geteilt durch den Jahresumsatz. Hilfreich bei Firmen, die (noch) keinen Gewinn machen.",
        ampel: (v) => stufe(v, [2, 6], ["günstig", "fair", "hoch"]) },
      { k: "ev_ebitda", name: "EV/EBITDA", fmt: (v) => zahl(v, 1),
        info: "Unternehmenswert (inkl. Schulden) geteilt durch den Gewinn vor Zinsen, Steuern und Abschreibungen. Gut für Vergleiche zwischen Firmen mit unterschiedlicher Verschuldung.",
        ampel: (v) => BEWERTUNG(v) || stufe(v, [10, 18], ["günstig", "fair", "hoch"]) },
    ],
  },
  {
    gruppe: "Profitabilität – wie viel bleibt hängen?",
    werte: [
      { k: "marge_brutto", name: "Bruttomarge", fmt: (v) => pz(v),
        info: "Anteil des Umsatzes, der nach den direkten Herstellkosten übrig bleibt. Hohe Bruttomargen deuten auf Preissetzungsmacht hin.",
        ampel: (v) => stufe(v, [25, 50], ["hoch", "mittel", "tief"], true) },
      { k: "marge_op", name: "Operative Marge (EBIT-Marge)", fmt: (v) => pz(v),
        info: "Anteil des Umsatzes, der nach allen Betriebskosten als Gewinn übrig bleibt (vor Zinsen und Steuern).",
        ampel: (v) => stufe(v, [8, 20], ["hoch", "mittel", "tief"], true) },
      { k: "marge_netto", name: "Nettomarge", fmt: (v) => pz(v),
        info: "Wie viele Rappen von jedem Franken Umsatz am Ende als Reingewinn übrig bleiben.",
        ampel: (v) => stufe(v, [5, 15], ["hoch", "mittel", "tief"], true) },
      { k: "roe", name: "Eigenkapitalrendite (ROE)", fmt: (v) => pz(v),
        info: "Gewinn im Verhältnis zum Eigenkapital. Zeigt, wie gut das Geld der Aktionäre arbeitet. Über 15 % gilt als stark (Achtung: hohe Schulden erhöhen den ROE künstlich).",
        ampel: (v) => stufe(v, [8, 15], ["stark", "mittel", "schwach"], true) },
      { k: "roa", name: "Gesamtkapitalrendite (ROA)", fmt: (v) => pz(v),
        info: "Gewinn im Verhältnis zum gesamten Vermögen der Firma – unabhängig von der Finanzierung.",
        ampel: (v) => stufe(v, [3, 8], ["stark", "mittel", "schwach"], true) },
    ],
  },
  {
    gruppe: "Wachstum",
    werte: [
      { k: "umsatz_wachstum", name: "Umsatzwachstum (letztes Quartal ggü. Vorjahr)", fmt: (v) => (v === null || v === undefined ? "–" : prozent(v)),
        info: "Wie stark der Umsatz im letzten Quartal gegenüber dem gleichen Quartal im Vorjahr gewachsen ist.",
        ampel: (v) => stufe(v, [0, 10], ["stark", "leicht", "rückläufig"], true) },
      { k: "gewinn_wachstum", name: "Gewinnwachstum (letztes Quartal ggü. Vorjahr)", fmt: (v) => (v === null || v === undefined ? "–" : prozent(v)),
        info: "Veränderung des Gewinns gegenüber dem gleichen Quartal im Vorjahr.",
        ampel: (v) => stufe(v, [0, 10], ["stark", "leicht", "rückläufig"], true) },
      { k: "eps", name: "Gewinn je Aktie (12 Monate)", fmt: (v, f) => zahl(v, 2) + (f.waehrung ? " " + f.waehrung : ""),
        info: "Reingewinn geteilt durch die Anzahl Aktien (EPS). Basis für das KGV.", ampel: () => null },
      { k: "eps_fwd", name: "Gewinn je Aktie erwartet", fmt: (v, f) => zahl(v, 2) + (f.waehrung ? " " + f.waehrung : ""),
        info: "Von Analysten für die nächsten 12 Monate erwarteter Gewinn je Aktie.", ampel: () => null },
    ],
  },
  {
    gruppe: "Dividende",
    werte: [
      { k: "div_rendite", name: "Dividendenrendite", fmt: (v) => pz(v, 2),
        info: "Jährliche Dividende im Verhältnis zum Aktienkurs. 3 % heisst: Für 1'000 Fr. Aktien gibt es ca. 30 Fr. pro Jahr.",
        ampel: (v) => (!v ? { stufe: "neutral", wort: "keine" } : stufe(v, [1, 3], ["hoch", "mittel", "tief"], true)) },
      { k: "div_satz", name: "Dividende pro Aktie (Jahr)", fmt: (v, f) => zahl(v, 2) + (f.waehrung ? " " + f.waehrung : ""),
        info: "Betrag, der pro Aktie und Jahr ausgeschüttet wird.", ampel: () => null },
      { k: "ausschuettung", name: "Ausschüttungsquote", fmt: (v) => pz(v, 0),
        info: "Anteil des Gewinns, der als Dividende ausbezahlt wird. Über 90 % kann auf Dauer schwierig werden.",
        ampel: (v) => (!v ? null : stufe(v, [60, 90], ["nachhaltig", "erhöht", "sehr hoch"])) },
    ],
  },
  {
    gruppe: "Bilanz & Risiko",
    werte: [
      { k: "verschuldung", name: "Verschuldungsgrad (Schulden/Eigenkapital)", fmt: (v) => pz(v, 0),
        info: "Finanzschulden im Verhältnis zum Eigenkapital. Unter 50 % ist solide. Bei Banken und Versicherungen wenig aussagekräftig.",
        ampel: (v) => stufe(v, [50, 150], ["tief", "mittel", "hoch"]) },
      { k: "liquiditaet", name: "Liquiditätsgrad (Current Ratio)", fmt: (v) => zahl(v, 2),
        info: "Kurzfristiges Vermögen geteilt durch kurzfristige Schulden. Über 1 kann die Firma ihre kurzfristigen Rechnungen decken.",
        ampel: (v) => stufe(v, [1, 1.5], ["gut", "knapp", "eng"], true) },
      { k: "beta", name: "Beta (Schwankung ggü. Markt)", fmt: (v) => zahl(v, 2),
        info: "1 = schwankt wie der Gesamtmarkt, 2 = doppelt so stark, 0.5 = halb so stark.",
        ampel: (v) => (v === null || v === undefined ? null : { stufe: "neutral", wort: v < 0.8 ? "ruhig" : v <= 1.2 ? "wie Markt" : "schwankend" }) },
    ],
  },
  {
    gruppe: "Grösse",
    werte: [
      { k: "marktkap", name: "Börsenwert", fmt: (v, f) => betrag(v, f.waehrung), info: "Aktienkurs mal Anzahl Aktien = was die ganze Firma an der Börse wert ist.", ampel: () => null },
      { k: "umsatz", name: "Umsatz (12 Monate)", fmt: (v, f) => betrag(v, f.bilanz_waehrung), info: "Gesamte Verkäufe der letzten 12 Monate.", ampel: () => null },
      { k: "gewinn", name: "Reingewinn (12 Monate)", fmt: (v, f) => betrag(v, f.bilanz_waehrung), info: "Gewinn nach allen Kosten, Zinsen und Steuern.", ampel: () => null },
      { k: "fcf", name: "Free Cashflow", fmt: (v, f) => betrag(v, f.bilanz_waehrung), info: "Geld, das nach allen Investitionen tatsächlich übrig bleibt – daraus werden Dividenden, Rückkäufe und Schuldenabbau bezahlt.", ampel: () => null },
      { k: "mitarbeiter", name: "Mitarbeitende", fmt: (v) => zahl(v, 0), info: "Anzahl Vollzeitstellen.", ampel: () => null },
    ],
  },
];

function ampelHtml(a) {
  if (!a) return "";
  return `<span class="ampel ampel-${a.stufe}"><span class="ampel-punkt"></span>${esc(a.wort)}</span>`;
}

/* ---------------------------------------------------------------------
   Aktie des Tages
   --------------------------------------------------------------------- */
function aktieDesTages() {
  const liste = eindeutig(alleAktien()).filter((a) => a.kurs !== null).sort((a, b) => a.symbol.localeCompare(b.symbol));
  if (!liste.length) return null;
  const tagNr = Math.floor(Date.now() / 864e5);          // jeden Tag eine andere Aktie
  return liste[(tagNr + aktieVersatz) % liste.length];
}

function kurzKennzahlen(f) {
  const auswahl = ["kgv", "div_rendite", "marge_netto", "umsatz_wachstum"];
  const defs = KENNZAHLEN.flatMap((g) => g.werte).filter((d) => auswahl.includes(d.k));
  return `<div class="kz-chips">${defs.map((d) => {
    const v = f[d.k];
    const kurzname = { kgv: "KGV", div_rendite: "Dividende", marge_netto: "Nettomarge", umsatz_wachstum: "Wachstum" }[d.k];
    return `<div class="kz-chip"><span class="leise">${kurzname}</span><b>${v === null || v === undefined ? "–" : d.fmt(v, f)}</b>${ampelHtml(d.ampel(v))}</div>`;
  }).join("")}</div>`;
}

function zeigeAktieDesTages() {
  const ziel = $("aktie-des-tages");
  if (!ziel || !zustand.daten) return;
  const a = aktieDesTages();
  if (!a) { ziel.innerHTML = "<h2>Aktie des Tages</h2><p class='leise'>Keine Daten.</p>"; return; }
  const f = fundamentalVon(a.symbol) || {};
  const sb = f.steckbrief || {};
  const p1j = a.perf && a.perf["1J"];
  ziel.innerHTML = `
    <div class="titel-zeile">
      <h2>Aktie des Tages</h2>
      <button type="button" class="link-knopf" id="naechste-aktie">Nächste →</button>
    </div>
    <div class="adt-kopf">
      <div>
        <div class="adt-name">${LAND_FLAGGE[a.land] || ""} ${esc(a.name)}</div>
        <div class="leise klein">${esc(a.sektor || "")} · ${esc(a.symbol)}</div>
      </div>
      <div class="adt-kurs">
        <div><b>${zahl(a.kurs, 2)}</b> <span class="leise klein">${esc(f.waehrung || "")}</span></div>
        <div class="klein">1 Jahr <span class="${farbe(p1j)}">${prozent(p1j)}</span></div>
      </div>
    </div>
    <p class="adt-text">${esc(sb.was || f.beschreibung_en || "Für diese Aktie gibt es noch keinen Steckbrief.")}</p>
    ${f.kurs !== undefined ? kurzKennzahlen(f) : '<p class="leise klein">Kennzahlen werden geladen …</p>'}
    ${sb.chancen ? `<p class="klein"><b class="plus">＋ Chancen:</b> ${esc(sb.chancen)}</p>` : ""}
    ${sb.risiken ? `<p class="klein"><b class="minus">− Risiken:</b> ${esc(sb.risiken)}</p>` : ""}
    ${sb.fakt ? `<p class="klein fakt">💡 <b>Wusstest du?</b> ${esc(sb.fakt)}</p>` : ""}
    <button type="button" class="knopf breit-knopf" data-oeffne="${esc(a.symbol)}">Alle Kennzahlen ansehen</button>`;
}

/* ---------------------------------------------------------------------
   Detailansicht einer Aktie
   --------------------------------------------------------------------- */
function grosserChart(e, zeitraum) {
  const w = reiheImZeitraum(e, zeitraum).filter((v) => v !== null && !isNaN(v));
  if (w.length < 2) return '<p class="leise">Kein Verlauf verfügbar.</p>';
  const min = Math.min(...w), max = Math.max(...w), spanne = max - min || 1;
  const pts = w.map((v, i) => [(i / (w.length - 1)) * 300, 112 - ((v - min) / spanne) * 104]);
  const linie = pts.map((p) => p.map((z) => z.toFixed(1)).join(",")).join(" ");
  const klasse = w[w.length - 1] >= w[0] ? "plus" : "minus";
  return `<div class="gross-chart">
    <svg viewBox="0 0 300 120" preserveAspectRatio="none" class="${klasse}" aria-label="Kursverlauf">
      <line x1="0" y1="8" x2="300" y2="8" class="gitter"/><line x1="0" y1="112" x2="300" y2="112" class="gitter"/>
      <polygon points="0,120 ${linie} 300,120" fill="currentColor" opacity="0.12"/>
      <polyline points="${linie}" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
    </svg>
    <span class="achse oben">${zahl(max, 2)}</span><span class="achse unten">${zahl(min, 2)}</span>
  </div>`;
}

/** Balken für den Reingewinn pro Jahr */
function gewinnChart(jahre, waehrung) {
  const mitGewinn = jahre.filter((j) => j.gewinn !== undefined);
  if (!mitGewinn.length) return "";
  const maxAbs = Math.max(...mitGewinn.map((j) => Math.abs(j.gewinn)), 1);
  const hatMinus = mitGewinn.some((j) => j.gewinn < 0);
  return `<div class="gewinn-chart ${hatMinus ? "mit-minus" : ""}">${mitGewinn.map((j) => {
    const h = (Math.abs(j.gewinn) / maxAbs) * (hatMinus ? 50 : 100);
    return `<div class="gc-spalte" title="${esc(j.jahr)}: ${betrag(j.gewinn, waehrung)}">
      <div class="gc-wert">${betrag(j.gewinn)}</div>
      <div class="gc-flaeche"><div class="gc-balken ${j.gewinn >= 0 ? "plus" : "minus"}" style="height:${h.toFixed(1)}%"></div></div>
      <div class="gc-jahr">${esc(j.jahr)}</div>
    </div>`;
  }).join("")}</div>`;
}

function jahresTabelle(jahre, waehrung) {
  if (!jahre || !jahre.length) return '<p class="leise">Keine Jahreszahlen verfügbar.</p>';
  const zeilen = jahre.map((j, i) => {
    const vj = jahre[i - 1] || {};
    const du = veraenderung(j.umsatz, vj.umsatz), dg = veraenderung(j.gewinn, vj.gewinn);
    return `<tr>
      <td><b>${esc(j.jahr)}</b></td>
      <td>${betrag(j.umsatz)}${du !== null ? `<br><span class="${farbe(du)} klein">${prozent(du)}</span>` : ""}</td>
      <td>${betrag(j.gewinn)}${dg !== null ? `<br><span class="${farbe(dg)} klein">${prozent(dg)}</span>` : ""}</td>
      <td class="eps">${j.eps !== undefined ? zahl(j.eps, 2) : "–"}</td>
      <td>${betrag(j.fcf)}</td>
    </tr>`;
  }).join("");
  return `<div class="tabelle-wrap"><table class="jahre-tab">
    <thead><tr><th>Jahr</th><th>Umsatz</th><th>Reingewinn</th><th class="eps">Gewinn/Aktie</th><th>Free Cashflow</th></tr></thead>
    <tbody>${zeilen}</tbody></table></div>
    <p class="leise klein">Beträge in ${esc(waehrung || "Berichtswährung")}. Prozent = Veränderung zum Vorjahr.</p>`;
}

function spanneHtml(titel, tief, hoch, kurs, waehrung) {
  if (!tief || !hoch || !kurs || hoch <= tief) return "";
  const pos = Math.max(0, Math.min(100, ((kurs - tief) / (hoch - tief)) * 100));
  return `<div class="spanne">
    <div class="spanne-titel klein"><span>${titel}</span><span class="leise">${zahl(tief, 2)} – ${zahl(hoch, 2)} ${esc(waehrung || "")}</span></div>
    <div class="spanne-spur"><span class="spanne-punkt" style="left:${pos.toFixed(1)}%"></span></div>
  </div>`;
}

function oeffneAktie(symbol, { nachOben = true } = {}) {
  const e = eindeutig(alleAktien()).find((a) => a.symbol === symbol);
  if (!e) return;
  const f = fundamentalVon(symbol) || {};
  const sb = f.steckbrief || {};
  const z = blattZeitraum || zustand.zeitraum;
  const p = (() => { const alt = zustand.zeitraum; zustand.zeitraum = z; const r = perf(e); zustand.zeitraum = alt; return r; })();
  const potenzial = f.kursziel && f.kurs ? (f.kursziel / f.kurs - 1) * 100 : null;
  const t = f.termine || {};

  const kennzahlenHtml = KENNZAHLEN.map((g) => {
    const zeilen = g.werte.filter((d) => f[d.k] !== null && f[d.k] !== undefined).map((d) => `
      <details class="kz-zeile">
        <summary><span class="kz-name">${esc(d.name)}</span><span class="kz-wert">${d.fmt(f[d.k], f)}</span>${ampelHtml(d.ampel(f[d.k])) || "<span></span>"}</summary>
        <p class="leise klein">${esc(d.info)}</p>
      </details>`).join("");
    return zeilen ? `<h3 class="kz-gruppe">${esc(g.gruppe)}</h3>${zeilen}` : "";
  }).join("");

  $("blatt-inhalt").innerHTML = `
    <div class="blatt-kopf">
      <h2 id="blatt-titel">${LAND_FLAGGE[e.land] || ""} ${esc(e.name)}</h2>
      <div class="leise klein">${esc(e.symbol)} · ${esc(e.sektor || "")}${f.branche ? " · " + esc(f.branche) : ""}</div>
      <div class="blatt-kurs"><b>${zahl(e.kurs, 2)}</b> <span class="leise">${esc(f.waehrung || "")}</span>
        <span class="pill ${farbe(p)}">${prozent(p)}</span> <span class="leise klein">${esc(z === "1T" ? "heute" : ZEITRAEUME[z])}</span></div>
    </div>
    <div class="umschalter breit-umschalter blatt-zeitraum" role="group" aria-label="Zeitraum">
      ${Object.keys(ZEITRAEUME).map((k) => `<button type="button" data-blatt-zeitraum="${k}" class="${k === z ? "aktiv" : ""}">${k}</button>`).join("")}
    </div>
    ${grosserChart(e, z)}

    ${sb.was || f.beschreibung_en ? `<section class="blatt-abschnitt">
      <h3>Was macht ${esc(e.name)}?</h3>
      <p>${esc(sb.was || f.beschreibung_en)}</p>
      ${sb.chancen ? `<p class="klein"><b class="plus">＋ Chancen:</b> ${esc(sb.chancen)}</p>` : ""}
      ${sb.risiken ? `<p class="klein"><b class="minus">− Risiken:</b> ${esc(sb.risiken)}</p>` : ""}
      ${sb.fakt ? `<p class="klein fakt">💡 <b>Wusstest du?</b> ${esc(sb.fakt)}</p>` : ""}
    </section>` : ""}

    ${f.jahre && f.jahre.length ? `<section class="blatt-abschnitt">
      <h3>Gewinn der letzten Jahre</h3>
      ${gewinnChart(f.jahre, f.bilanz_waehrung)}
      ${jahresTabelle(f.jahre, f.bilanz_waehrung)}
    </section>` : ""}

    <section class="blatt-abschnitt">
      <h3>Kennzahlen <span class="leise klein">(antippen für Erklärung)</span></h3>
      ${kennzahlenHtml || '<p class="leise">Kennzahlen werden beim nächsten Update geladen.</p>'}
      <p class="leise klein">Ampel = grobe Faustregel zur Orientierung. Je nach Branche sind andere Werte normal. Keine Anlageberatung.</p>
    </section>

    ${f.kursziel || f.hoch52 ? `<section class="blatt-abschnitt">
      <h3>Analysten & Kursspanne</h3>
      ${f.empfehlung ? `<p>Empfehlung: <b>${esc(EMPFEHLUNG[f.empfehlung] || f.empfehlung)}</b>${f.analysten ? ` <span class="leise klein">(${f.analysten} Analysten)</span>` : ""}</p>` : ""}
      ${f.kursziel ? `<p>Durchschnittliches Kursziel: <b>${zahl(f.kursziel, 2)} ${esc(f.waehrung || "")}</b>
        ${potenzial !== null ? `<span class="pill ${farbe(potenzial)}">${prozent(potenzial)}</span>` : ""}</p>` : ""}
      ${spanneHtml("Kursziele der Analysten (tief – hoch)", f.kursziel_tief, f.kursziel_hoch, f.kurs, f.waehrung)}
      ${spanneHtml("52-Wochen-Spanne", f.tief52, f.hoch52, f.kurs, f.waehrung)}
    </section>` : ""}

    ${t.zahlen || t.ex_div ? `<section class="blatt-abschnitt">
      <h3>Nächste Termine</h3>
      ${t.zahlen ? `<p>📊 Quartalszahlen: <b>${kurzDatum(t.zahlen)}${t.zahlen.slice(0, 4)}</b>${t.eps_schaetzung !== null && t.eps_schaetzung !== undefined ? ` <span class="leise klein">· erwarteter Gewinn/Aktie ${zahl(t.eps_schaetzung, 2)}</span>` : ""}</p>` : ""}
      ${t.ex_div ? `<p>💰 Ex-Dividende: <b>${kurzDatum(t.ex_div)}${t.ex_div.slice(0, 4)}</b></p>` : ""}
    </section>` : ""}

    <p class="leise klein">Quelle: Yahoo Finance${f.stand ? ", Stand " + fmtDatumZeit.format(new Date(f.stand)) : ""}${f.veraltet ? " (letzter Abruf fehlgeschlagen)" : ""}. Daten ohne Gewähr.</p>`;
  $("blatt-inhalt").dataset.symbol = symbol;
  zeigeBlatt(nachOben);
}

/* ---------------------------------------------------------------------
   Finanzwissen: Begriff des Tages + Lexikon
   --------------------------------------------------------------------- */
const LEXIKON = [
  { b: "KGV (Kurs-Gewinn-Verhältnis)", t: "Aktienkurs geteilt durch Gewinn pro Aktie. Sagt, wie viele Jahresgewinne du für eine Aktie bezahlst.", x: "Kurs 100 Fr., Gewinn 5 Fr. pro Aktie → KGV 20." },
  { b: "PEG-Ratio", t: "KGV geteilt durch das erwartete Gewinnwachstum in Prozent. Berücksichtigt, dass schnell wachsende Firmen ein höheres KGV verdienen.", x: "KGV 30, Wachstum 30 % pro Jahr → PEG 1." },
  { b: "KBV (Kurs-Buchwert-Verhältnis)", t: "Börsenwert im Verhältnis zum Eigenkapital in der Bilanz. Wichtig bei Banken, Versicherungen und Immobilienfirmen.", x: "KBV 0.8 → die Börse bewertet die Firma unter ihrem Buchwert." },
  { b: "KUV (Kurs-Umsatz-Verhältnis)", t: "Börsenwert geteilt durch den Umsatz. Nützlich bei jungen Firmen ohne Gewinn.", x: "Börsenwert 10 Mrd., Umsatz 2 Mrd. → KUV 5." },
  { b: "Gewinn je Aktie (EPS)", t: "Reingewinn geteilt durch die Anzahl Aktien. Steigt der EPS über Jahre, wächst die Firma profitabel.", x: "1 Mrd. Gewinn, 100 Mio. Aktien → EPS 10." },
  { b: "Dividendenrendite", t: "Jährliche Dividende im Verhältnis zum Kurs. Hohe Renditen können auch ein Warnsignal sein, wenn der Kurs stark gefallen ist.", x: "Dividende 3 Fr., Kurs 100 Fr. → 3 %." },
  { b: "Ausschüttungsquote", t: "Anteil des Gewinns, der als Dividende ausbezahlt wird. Über 100 % zahlt die Firma mehr aus, als sie verdient.", x: "Gewinn 5 Fr., Dividende 3 Fr. → 60 %." },
  { b: "Ex-Dividenden-Tag", t: "Ab diesem Tag wird die Aktie ohne Anspruch auf die nächste Dividende gehandelt. Der Kurs sinkt meist ungefähr um die Dividende.", x: "Wer die Aktie am Vortag besitzt, erhält die Dividende." },
  { b: "Bruttomarge", t: "Umsatz minus direkte Herstellkosten, in Prozent vom Umsatz. Zeigt, wie viel Preissetzungsmacht eine Firma hat.", x: "Software-Firmen haben oft über 70 %, Detailhändler unter 30 %." },
  { b: "EBIT und operative Marge", t: "EBIT = Gewinn vor Zinsen und Steuern. Die operative Marge zeigt, wie profitabel das Kerngeschäft ist.", x: "Umsatz 100, EBIT 20 → operative Marge 20 %." },
  { b: "Nettomarge", t: "Reingewinn in Prozent vom Umsatz – was am Ende wirklich übrig bleibt.", x: "Nettomarge 10 % → 10 Rappen Gewinn pro Franken Umsatz." },
  { b: "Eigenkapitalrendite (ROE)", t: "Gewinn im Verhältnis zum Eigenkapital. Warren Buffett achtet stark darauf. Über 15 % gilt als gut.", x: "Eigenkapital 100, Gewinn 20 → ROE 20 %." },
  { b: "Free Cashflow", t: "Bargeld, das nach allen Investitionen übrig bleibt. Damit zahlt eine Firma Dividenden, kauft Aktien zurück oder baut Schulden ab.", x: "Gewinn kann man 'schönrechnen', Cashflow kaum." },
  { b: "Verschuldungsgrad", t: "Schulden im Verhältnis zum Eigenkapital. Hohe Schulden machen eine Firma anfällig, wenn Zinsen steigen oder Geschäfte schlecht laufen.", x: "Schulden 50, Eigenkapital 100 → 50 %." },
  { b: "Marktkapitalisierung", t: "Börsenwert = Kurs × Anzahl Aktien. Large Caps sind über 10 Mrd. wert, Small Caps unter 2 Mrd.", x: "Apple, Microsoft und Nvidia sind mehrere Billionen Dollar wert." },
  { b: "Beta", t: "Misst, wie stark eine Aktie im Vergleich zum Gesamtmarkt schwankt. Beta 1.5 → schwankt 50 % stärker als der Markt.", x: "Versorger haben oft ein Beta unter 1, Tech-Aktien darüber." },
  { b: "Burggraben (Moat)", t: "Ein dauerhafter Wettbewerbsvorteil, der Konkurrenten fernhält: starke Marke, Netzwerkeffekte, Patente, hohe Wechselkosten.", x: "Visa und Mastercard: Händler und Kunden nutzen sie, weil alle sie nutzen." },
  { b: "Diversifikation", t: "Geld auf viele verschiedene Anlagen verteilen, damit der Absturz einer einzelnen Aktie nicht das ganze Depot trifft.", x: "Statt 1 Aktie lieber viele Firmen, Branchen und Länder – z.B. über einen ETF." },
  { b: "ETF", t: "Börsengehandelter Fonds, der einen Index nachbildet (z.B. MSCI World). Günstig, breit gestreut, jederzeit handelbar.", x: "Mit einem MSCI-World-ETF besitzt du Anteile an über 1'000 Firmen." },
  { b: "TER (Gesamtkostenquote)", t: "Jährliche Kosten eines Fonds in Prozent des angelegten Geldes. Bei ETFs meist zwischen 0.05 % und 0.5 %.", x: "TER 0.2 % → 2 Fr. Kosten pro Jahr für 1'000 Fr." },
  { b: "Zinseszins", t: "Erträge werfen selbst wieder Erträge ab. Über lange Zeit wächst das Vermögen dadurch exponentiell.", x: "10'000 Fr. mit 7 % pro Jahr → nach 30 Jahren rund 76'000 Fr." },
  { b: "Cost-Average-Effekt", t: "Regelmässig den gleichen Betrag investieren (Sparplan). Bei tiefen Kursen kauft man automatisch mehr Anteile.", x: "Jeden Monat 200 Fr. in einen ETF." },
  { b: "Inflation", t: "Allgemeiner Anstieg der Preise. Geld verliert an Kaufkraft – deshalb sollte Erspartes mehr rentieren als die Inflation.", x: "Bei 2 % Inflation kosten 100 Fr. Einkäufe nach einem Jahr 102 Fr." },
  { b: "Leitzins", t: "Zins, den die Notenbank (SNB, Fed, EZB) festlegt. Er beeinflusst Hypotheken, Sparzinsen und die Börse.", x: "Sinkende Zinsen sind meist gut für Aktien, besonders für Wachstumsfirmen." },
  { b: "Volatilität und VIX", t: "Volatilität misst, wie stark Kurse schwanken. Der VIX ('Angstbarometer') zeigt die erwartete Schwankung des S&P 500.", x: "VIX unter 15 = ruhig, über 30 = grosse Nervosität." },
  { b: "Fear & Greed Index", t: "Stimmungsbarometer von 0 (extreme Angst) bis 100 (extreme Gier). Viele Anleger handeln antizyklisch: kaufen bei Angst, vorsichtig bei Gier.", x: "Warren Buffett: 'Sei ängstlich, wenn andere gierig sind.'" },
  { b: "Quartalszahlen", t: "Alle drei Monate veröffentlichen Firmen Umsatz, Gewinn und Ausblick. Entscheidend ist oft, ob die Erwartungen der Analysten übertroffen werden.", x: "Gewinn besser als erwartet + schwacher Ausblick → Kurs kann trotzdem fallen." },
  { b: "Aktienrückkauf", t: "Die Firma kauft eigene Aktien zurück. Dadurch gibt es weniger Aktien, und jeder Aktionär besitzt einen grösseren Anteil am Gewinn.", x: "Apple reduziert so seit Jahren die Anzahl Aktien." },
  { b: "Verwässerung", t: "Eine Firma gibt neue Aktien aus. Bestehende Aktionäre besitzen danach einen kleineren Anteil.", x: "Häufig bei jungen Wachstumsfirmen und Bitcoin-Treasury-Firmen." },
  { b: "Bullen- und Bärenmarkt", t: "Bullenmarkt = lang anhaltend steigende Kurse. Bärenmarkt = Kurse fallen um mindestens 20 % vom Hoch.", x: "Der Bulle stösst mit den Hörnern nach oben, der Bär schlägt mit der Tatze nach unten." },
  { b: "Hexensabbat (Grosser Verfall)", t: "Am 3. Freitag im März, Juni, September und Dezember verfallen viele Optionen und Futures gleichzeitig. Das kann starke Kursbewegungen auslösen.", x: "Im Kalender als 'Grosser Verfall' markiert." },
  { b: "Index", t: "Ein Korb von Aktien, der einen Markt abbildet. Der SMI enthält die 20 grössten Schweizer Firmen, der S&P 500 die 500 grössten US-Firmen.", x: "Steigt der SMI um 1 %, haben die SMI-Aktien im Schnitt (gewichtet) 1 % gewonnen." },
];

function wissenHtml() {
  const tagNr = Math.floor(Date.now() / 864e5);
  const w = LEXIKON[tagNr % LEXIKON.length];
  return `<h3 class="wissen-begriff">${esc(w.b)}</h3><p>${esc(w.t)}</p>${w.x ? `<p class="klein beispiel">Beispiel: ${esc(w.x)}</p>` : ""}`;
}

function zeigeLexikon() {
  $("blatt-inhalt").innerHTML = `<div class="blatt-kopf"><h2 id="blatt-titel">Finanz-Lexikon</h2>
    <p class="leise klein">${LEXIKON.length} wichtige Begriffe einfach erklärt.</p></div>
    ${LEXIKON.map((w) => `<details class="lexikon-eintrag"><summary>${esc(w.b)}</summary><p>${esc(w.t)}</p>${w.x ? `<p class="klein beispiel">Beispiel: ${esc(w.x)}</p>` : ""}</details>`).join("")}`;
  delete $("blatt-inhalt").dataset.symbol;
  zeigeBlatt();
}

/* ---------------------------------------------------------------------
   Fenster (Blatt) öffnen / schliessen
   --------------------------------------------------------------------- */
function zeigeBlatt(nachOben = true) {
  $("blatt").classList.remove("versteckt");
  $("blatt-hintergrund").classList.remove("versteckt");
  if (nachOben) $("blatt").scrollTop = 0;
  document.body.classList.add("blatt-offen");
}

function schliesseBlatt() {
  $("blatt").classList.add("versteckt");
  $("blatt-hintergrund").classList.add("versteckt");
  document.body.classList.remove("blatt-offen");
  blattZeitraum = null;
}

// Klicks an einer Stelle abfangen (funktioniert auch für neu gezeichnete Elemente)
document.addEventListener("click", (ev) => {
  const zeileEl = ev.target.closest(".klickbar[data-symbol]");
  if (zeileEl) { blattZeitraum = null; oeffneAktie(zeileEl.dataset.symbol); return; }
  const oeffne = ev.target.closest("[data-oeffne]");
  if (oeffne) { blattZeitraum = null; oeffneAktie(oeffne.dataset.oeffne); return; }
  const bz = ev.target.closest("[data-blatt-zeitraum]");
  if (bz) { blattZeitraum = bz.dataset.blattZeitraum; oeffneAktie($("blatt-inhalt").dataset.symbol, { nachOben: false }); return; }
  if (ev.target.closest("#naechste-aktie")) { aktieVersatz += 1; zeigeAktieDesTages(); return; }
  if (ev.target.closest("#lexikon-knopf")) { zeigeLexikon(); return; }
  if (ev.target.closest("#blatt-zu") || ev.target.id === "blatt-hintergrund") schliesseBlatt();
});
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") schliesseBlatt(); });
