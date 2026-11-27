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
  // Bereiche, die Kennzahlen brauchen, neu zeichnen
  if (["uebersicht", "aktien", "insider"].includes(zustand.tab)) zeigeAlles();
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
  if (a >= 1e4) return zahl(n / 1e3, 0) + " Tsd." + w;
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
    ${(() => { const sc = qualitaetsScore(f, a); return sc ? `<p class="klein">Qualitäts-Score: <span class="score-mini score-${sc.stufe}">${sc.gesamt}</span>${sc.staerken.length ? ` · ${sc.staerken.slice(0, 2).join(", ")}` : ""}</p>` : ""; })()}
    ${sb.chancen ? `<p class="klein"><b class="plus">＋ Chancen:</b> ${esc(sb.chancen)}</p>` : ""}
    ${sb.risiken ? `<p class="klein"><b class="minus">− Risiken:</b> ${esc(sb.risiken)}</p>` : ""}
    ${sb.fakt ? `<p class="klein fakt">💡 <b>Wusstest du?</b> ${esc(sb.fakt)}</p>` : ""}
    <button type="button" class="knopf breit-knopf" data-oeffne="${esc(a.symbol)}">Alle Kennzahlen ansehen</button>`;
}

/* ---------------------------------------------------------------------
   Detailansicht einer Aktie
   --------------------------------------------------------------------- */
/** Gleitender Durchschnitt (für Wochenwerte bei 3J/5J) */
function gleitend(werte, n) {
  return werte.map((_, i) => (i < n - 1 ? null : werte.slice(i - n + 1, i + 1).reduce((a, v) => a + v, 0) / n));
}

/** Ungefähres Datum für "vor x Handelstagen/Wochen" */
function datumVor(e, schritte, wochen) {
  const ende = Date.parse((e.datum || isoTag(new Date())) + "T00:00:00Z");
  return new Date(ende - schritte * (wochen ? 7 : 1.4) * 864e5);
}

/** Grosser Kurschart mit 50-/200-Tage-Linie und Golden/Death Cross */
function grosserChart(e, zeitraum, f) {
  const lang = LANGE_ZEITRAEUME.includes(zeitraum);
  const r = reiheImZeitraum(e, zeitraum);
  if (r.length < 2) return '<p class="leise">Kein Verlauf verfügbar.</p>';
  const n = r.length;
  const x = r.map((_, i) => i - n + 1);
  const serien = [{ name: "Kurs", x, y: r, farbe: r[n - 1] >= r[0] ? "var(--plus)" : "var(--minus)", flaeche: true }];
  const markierungen = [];
  const technik = f && f.technik;
  if (lang) {
    const w = e.verlauf_w || [];
    const m10 = gleitend(w, 10).slice(-n), m40 = gleitend(w, 40).slice(-n);
    serien.push({ name: "10-Wochen-Linie (≈50 Tage)", x, y: m10, farbe: "var(--serie-1)", dicke: 1.5 });
    serien.push({ name: "40-Wochen-Linie (≈200 Tage)", x, y: m40, farbe: "var(--serie-2)", dicke: 1.5 });
  } else if (technik && technik.ma50 && zeitraum !== "1T" && zeitraum !== "1W") {
    // MA-Werte liegen als jeder 3. Tag vor (letzter Wert = heute)
    const zuSerie = (liste) => {
      const xs = [], ys = [];
      liste.forEach((v, k) => { const off = -3 * (liste.length - 1 - k); if (off >= -n + 1) { xs.push(off); ys.push(v); } });
      return { xs, ys };
    };
    const a = zuSerie(technik.ma50), b = zuSerie(technik.ma200);
    serien.push({ name: "50-Tage-Linie", x: a.xs, y: a.ys, farbe: "var(--serie-1)", dicke: 1.5 });
    serien.push({ name: "200-Tage-Linie", x: b.xs, y: b.ys, farbe: "var(--serie-2)", dicke: 1.5 });
    const len = (e.verlauf || []).length;
    for (const k of technik.kreuze || []) {
      const off = k.i - (len - 1);
      if (off >= -n + 1) markierungen.push({ x: off, text: k.typ === "golden" ? "Golden Cross" : "Death Cross", klasse: k.typ });
    }
  }
  const fmtX = (v) => fmtMonatKurz.format(datumVor(e, -v, lang));
  return `<div class="blatt-chart">${linienChart(serien, {
    xTyp: "zahl", hoehe: 190, xFormat: fmtX, xTooltip: (v) => "≈ " + fmtTagMonatJahr.format(datumVor(e, -v, lang)),
    yFormat: (v) => zahl(v, Math.abs(r[0]) < 10 ? 2 : 0), yTooltip: (v) => zahl(v, 2), markierungen, titel: "Kursverlauf",
  })}</div>`;
}

/** Kurzfazit der Technik (Trend, RSI) */
function technikHtml(t) {
  if (!t) return "";
  const rsiText = t.rsi === null || t.rsi === undefined ? "–" : t.rsi >= 70 ? "überkauft" : t.rsi <= 30 ? "überverkauft" : "neutral";
  const rsiStufe = t.rsi >= 70 || t.rsi <= 30 ? "mittel" : "neutral";
  const letztes = (t.kreuze || []).slice(-1)[0];
  return `<div class="technik">
    <div><span class="leise klein">Trend (50 vs. 200 Tage)</span><b class="${t.trend === "aufwärts" ? "plus" : t.trend === "abwärts" ? "minus" : ""}">${t.trend ? (t.trend === "aufwärts" ? "▲ aufwärts" : "▼ abwärts") : "–"}</b></div>
    <div><span class="leise klein">Abstand 200-Tage-Linie</span><b class="${farbe(t.abstand_ma200)}">${t.abstand_ma200 === null || t.abstand_ma200 === undefined ? "–" : prozent(t.abstand_ma200)}</b></div>
    <div><span class="leise klein">RSI (14 Tage)</span><b>${t.rsi === null || t.rsi === undefined ? "–" : zahl(t.rsi, 0)}</b> <span class="ampel ampel-${rsiStufe}"><span class="ampel-punkt"></span>${rsiText}</span></div>
    ${letztes ? `<div><span class="leise klein">Letztes Signal</span><b class="${letztes.typ === "golden" ? "plus" : "minus"}">${letztes.typ === "golden" ? "Golden Cross" : "Death Cross"}</b> <span class="leise klein">${kurzDatum(letztes.datum)}${letztes.datum.slice(2, 4)}</span></div>` : ""}
  </div>
  <p class="leise klein">Golden Cross = 50-Tage-Linie steigt über die 200-Tage-Linie (gilt als positives Signal), Death Cross = umgekehrt. RSI über 70 = stark gestiegen (überkauft), unter 30 = stark gefallen (überverkauft).</p>`;
}

/* ---------------------------------------------------------------------
   Qualitäts-Score (0–100) aus 4 Säulen à 25 Punkte
   Grobe, transparente Faustregel – keine Anlageberatung.
   --------------------------------------------------------------------- */
function skala(wert, schlecht, gut) {
  if (wert === null || wert === undefined || isNaN(wert)) return null;
  const t = (wert - schlecht) / (gut - schlecht);
  return Math.max(0, Math.min(1, t));
}
function mittel(teile) {
  const g = teile.filter((t) => t !== null);
  return g.length ? g.reduce((a, b) => a + b, 0) / g.length : null;
}
function gewinnCagr(jahre) {
  const g = (jahre || []).filter((j) => j.gewinn !== undefined);
  if (g.length < 3 || g[0].gewinn <= 0 || g[g.length - 1].gewinn <= 0) return null;
  return (Math.pow(g[g.length - 1].gewinn / g[0].gewinn, 1 / (g.length - 1)) - 1) * 100;
}

function qualitaetsScore(f, a) {
  if (!f || f.kurs === undefined) return null;
  const finanz = ["Banken & Finanzen", "Versicherungen"].includes((a && a.sektor) || f.sektor);
  const kgv = f.kgv_fwd > 0 ? f.kgv_fwd : f.kgv > 0 ? f.kgv : null;
  const saeulen = {
    Bewertung: mittel([kgv === null ? (f.kgv !== null && f.kgv <= 0 ? 0 : null) : skala(kgv, 40, 12), f.peg > 0 ? skala(f.peg, 3, 1) : null]),
    Profitabilität: mittel([skala(f.roe, 0, 25), skala(f.marge_netto, 0, 20)]),
    Wachstum: mittel([skala(f.umsatz_wachstum, -5, 15), skala(gewinnCagr(f.jahre) ?? f.gewinn_wachstum, -10, 20)]),
    Bilanz: mittel([finanz ? null : skala(f.verschuldung, 250, 30), f.fcf === null || f.fcf === undefined ? null : f.fcf > 0 ? 1 : 0,
      finanz ? null : skala(f.liquiditaet, 0.7, 1.8)]),
  };
  const vorhanden = Object.values(saeulen).filter((v) => v !== null);
  if (vorhanden.length < 2) return null;
  const gesamt = Math.round((vorhanden.reduce((s, v) => s + v, 0) / vorhanden.length) * 100);
  const texte = {
    Bewertung: ["Günstig bewertet", "Hoch bewertet"], Profitabilität: ["Sehr profitabel", "Schwache Profitabilität"],
    Wachstum: ["Starkes Wachstum", "Schwaches Wachstum"], Bilanz: ["Solide Bilanz", "Hohe Verschuldung / wenig Cash"],
  };
  const staerken = [], schwaechen = [];
  for (const [k, v] of Object.entries(saeulen)) {
    if (v === null) continue;
    if (v >= 0.7) staerken.push(texte[k][0]); else if (v <= 0.35) schwaechen.push(texte[k][1]);
  }
  return { gesamt, saeulen, staerken, schwaechen, stufe: gesamt >= 70 ? "gut" : gesamt >= 50 ? "mittel" : "schlecht" };
}

function scoreHtml(sc) {
  if (!sc) return "";
  const ring = 2 * Math.PI * 34, anteil = sc.gesamt / 100;
  return `<div class="score">
    <svg viewBox="0 0 80 80" class="score-ring score-${sc.stufe}" aria-label="Qualitäts-Score ${sc.gesamt} von 100">
      <circle cx="40" cy="40" r="34" class="ring-hg"/><circle cx="40" cy="40" r="34" class="ring-wert" stroke-dasharray="${(ring * anteil).toFixed(1)} ${ring.toFixed(1)}" transform="rotate(-90 40 40)"/>
      <text x="40" y="46" text-anchor="middle" class="ring-zahl">${sc.gesamt}</text></svg>
    <div class="score-saeulen">${Object.entries(sc.saeulen).map(([k, v]) => `<div class="score-saeule"><span>${k}</span>
      <span class="score-spur"><span style="width:${v === null ? 0 : Math.round(v * 100)}%" class="score-${v === null ? "neutral" : v >= 0.7 ? "gut" : v >= 0.4 ? "mittel" : "schlecht"}"></span></span>
      <b>${v === null ? "–" : Math.round(v * 25)}</b></div>`).join("")}</div>
  </div>
  ${sc.staerken.length ? `<p class="klein"><b class="plus">Stärken:</b> ${sc.staerken.join(" · ")}</p>` : ""}
  ${sc.schwaechen.length ? `<p class="klein"><b class="minus">Schwächen:</b> ${sc.schwaechen.join(" · ")}</p>` : ""}
  <p class="leise klein">Score aus Bewertung, Profitabilität, Wachstum und Bilanz (je max. 25 Punkte). Faustregel, keine Empfehlung.</p>`;
}

/** KGV heute im Vergleich zu den letzten Jahren */
function kgvHistHtml(e, h) {
  if (!h || !h.werte) return "";
  const n = h.werte.length, schritt = h.schritt_wochen || 1;
  const x = h.werte.map((_, i) => -(n - 1 - i) * schritt);
  const aktuell = h.aktuell;
  const urteil = aktuell === null || aktuell === undefined ? "" : aktuell < h.schnitt * 0.9 ? "<b class='plus'>günstiger als im Durchschnitt</b>"
    : aktuell > h.schnitt * 1.1 ? "<b class='minus'>teurer als im Durchschnitt</b>" : "<b>etwa im Durchschnitt</b>";
  return `<section class="blatt-abschnitt"><h3>KGV im Zeitverlauf</h3>
    ${linienChart([{ name: "KGV", x, y: h.werte, farbe: "var(--serie-1)" }, { name: "Durchschnitt", x: [x[0], 0], y: [h.schnitt, h.schnitt], farbe: "var(--serie-2)", gestrichelt: true }],
      { xTyp: "zahl", hoehe: 150, band: { min: h.min, max: h.max }, xFormat: (v) => fmtMonatKurz.format(datumVor(e, -v, true)),
        xTooltip: (v) => "≈ " + fmtTagMonatJahr.format(datumVor(e, -v, true)), yFormat: (v) => zahl(v, 0), yTooltip: (v) => zahl(v, 1), titel: "KGV-Verlauf" })}
    <p class="klein">Aktuell ${aktuell ? zahl(aktuell, 1) : "–"} · Durchschnitt ${zahl(h.schnitt, 1)} · Spanne ${zahl(h.min, 1)}–${zahl(h.max, 1)} → ${urteil}.</p>
    <p class="leise klein">Berechnet aus Kurs und zuletzt gemeldetem Jahresgewinn je Aktie (Näherung).</p></section>`;
}

/** Gewinn-Überraschungen der letzten Quartale */
function ueberraschungHtml(liste) {
  if (!liste || !liste.length) return "";
  const max = Math.max(...liste.map((u) => Math.abs(u.prozent || 0)), 1);
  return `<section class="blatt-abschnitt"><h3>Gewinn-Überraschungen</h3>
    <div class="ueberr">${liste.map((u) => `<div class="ueberr-zeile">
      <span class="leise klein">${kurzDatum(u.quartal)}${(u.quartal || "").slice(2, 4)}</span>
      <span class="klein">erw. ${zahl(u.schaetzung, 2)} → <b>${zahl(u.ist, 2)}</b></span>
      <span class="spur"><span class="balken ${farbe(u.prozent) || "plus"}" style="width:${((Math.abs(u.prozent || 0) / max) * 50).toFixed(1)}%"></span></span>
      <span class="pill ${farbe(u.prozent)}">${prozent(u.prozent)}</span></div>`).join("")}</div>
    <p class="leise klein">Tatsächlicher Gewinn je Aktie im Vergleich zur Analysten-Schätzung pro Quartal.</p></section>`;
}

function alarmHtml(e) {
  const kurs = e.kurs || 0;
  const zeilen = [`  - { symbol: "${e.symbol}", name: "${e.name}", unter: ${zahl(kurs * 0.9, 2).replace(/'/g, "")} }`,
    `  - { symbol: "${e.symbol}", name: "${e.name}", ueber: ${zahl(kurs * 1.1, 2).replace(/'/g, "")} }`,
    `  - { symbol: "${e.symbol}", name: "${e.name}", tag_prozent: 5 }`];
  const aktiv = ((zustand.daten && zustand.daten.alarme) || []).filter((a) => a.symbol === e.symbol);
  return `<details class="blatt-abschnitt alarm-box" id="alarm-box"><summary><h3>🔔 Kursalarm ${aktiv.length ? `<span class="etikett">${aktiv.length} aktiv</span>` : ""}</h3></summary>
    ${aktiv.length ? `<p class="klein">Aktiv: ${aktiv.map((a) => [a.ueber ? `über ${a.ueber}` : "", a.unter ? `unter ${a.unter}` : "", a.tag_prozent ? `±${a.tag_prozent} % am Tag` : ""].filter(Boolean).join(", ")).join(" · ")}</p>` : ""}
    <p class="klein">Alarme stehen in <b>config.yaml</b> unter <code>alarme:</code>. Eine dieser Zeilen kopieren und dort einfügen:</p>
    ${zeilen.map((z) => `<div class="code-zeile"><code>${esc(z)}</code><button type="button" class="link-knopf" data-kopieren="${esc(z)}">Kopieren</button></div>`).join("")}
    <p class="klein"><a href="https://github.com/Maurusehrler/Maurus/edit/main/config.yaml" target="_blank" rel="noopener">config.yaml auf GitHub bearbeiten →</a></p>
    <p class="leise klein">Geprüft wird alle 30 Minuten während der Börsenzeiten. Die Nachricht kommt über die App „ntfy“ (siehe README).</p></details>`;
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
  const e = eindeutig(alleAktien()).find((a) => a.symbol === symbol) || alleEintraege().find((a) => a.symbol === symbol);
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
      <div class="blatt-titel-zeile">
        <h2 id="blatt-titel">${LAND_FLAGGE[e.land] || ""} ${esc(e.name)}</h2>
        <button type="button" class="stern" data-favorit="${esc(e.symbol)}" aria-label="Favorit">${istFavorit(e.symbol) ? "⭐" : "☆"}</button>
      </div>
      <div class="leise klein">${esc(e.symbol)} · ${esc(e.sektor || "")}${f.branche ? " · " + esc(f.branche) : ""}</div>
      <div class="blatt-kurs"><b>${zahl(e.kurs, 2)}</b> <span class="leise">${esc(f.waehrung || "")}</span>
        <span class="pill ${farbe(p)}">${prozent(p)}</span> <span class="leise klein">${esc(z === "1T" ? "heute" : ZEITRAEUME[z])}</span></div>
    </div>
    <div class="umschalter breit-umschalter blatt-zeitraum" role="group" aria-label="Zeitraum">
      ${Object.keys(ZEITRAEUME).map((k) => `<button type="button" data-blatt-zeitraum="${k}" class="${k === z ? "aktiv" : ""}">${k}</button>`).join("")}
    </div>
    ${grosserChart(e, z, f)}
    ${f.technik ? `<section class="blatt-abschnitt"><h3>Technische Signale</h3>${technikHtml(f.technik)}</section>` : ""}
    ${(() => { const sc = qualitaetsScore(f, e); return sc ? `<section class="blatt-abschnitt"><h3>Qualitäts-Score</h3>${scoreHtml(sc)}</section>` : ""; })()}

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

    ${kgvHistHtml(e, f.kgv_hist)}
    ${ueberraschungHtml(f.ueberraschungen)}

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

    ${(f.insider || []).length ? `<section class="blatt-abschnitt"><h3>🕵️ Insider-Transaktionen</h3>
      <div class="trades">${f.insider.slice(0, 8).map((i) => insiderZeile({ ...i, waehrung: f.waehrung }, false)).join("")}</div></section>` : ""}
    ${e.kategorie === "aktie" && e.land === "US" ? '<section class="blatt-abschnitt" id="blatt-politiker"><h3>🏛️ Trades von US-Politikern</h3><p class="leise klein">Wird geladen …</p></section>' : ""}
    ${alarmHtml(e)}

    <p class="leise klein">Quelle: Yahoo Finance${f.stand ? ", Stand " + fmtDatumZeit.format(new Date(f.stand)) : ""}${f.veraltet ? " (letzter Abruf fehlgeschlagen)" : ""}. Daten ohne Gewähr.</p>`;
  $("blatt-inhalt").dataset.symbol = symbol;
  zeigeBlatt(nachOben);
  // Politiker-Trades zu dieser Aktie nachladen
  if ($("blatt-politiker")) {
    politikerZuAktie(symbol).then((liste) => {
      const box = $("blatt-politiker");
      if (box) box.innerHTML = `<h3>🏛️ Trades von US-Politikern</h3>${liste.length
        ? `<div class="trades">${liste.map((t) => tradeZeile(t)).join("")}</div>` : '<p class="leise klein">Keine gemeldeten Trades in den letzten 12 Monaten.</p>'}`;
    });
  }
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
  const fav = ev.target.closest("[data-favorit]");
  if (fav) { favoritUmschalten(fav.dataset.favorit); fav.textContent = istFavorit(fav.dataset.favorit) ? "⭐" : "☆"; if (zustand.tab === "uebersicht") zeigeFavoriten(); return; }
  const kopie = ev.target.closest("[data-kopieren]");
  if (kopie) {
    const text = kopie.dataset.kopieren;
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => { kopie.textContent = "Kopiert ✓"; }, () => { kopie.textContent = "Bitte markieren"; });
    return;
  }
  if (ev.target.closest("#lexikon-knopf")) { zeigeLexikon(); return; }
  if (ev.target.closest("#blatt-zu") || ev.target.id === "blatt-hintergrund") schliesseBlatt();
});
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") schliesseBlatt(); });
