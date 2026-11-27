/* =====================================================================
   Börsen-Übersicht – Diagramme (ohne externe Bibliotheken)
   ---------------------------------------------------------------------
   linienChart(): Liniendiagramm mit Achsen, Legende und Tooltip.
   Beim Antippen / Darüberfahren erscheint eine senkrechte Linie mit
   den Werten aller Linien an dieser Stelle.
   ===================================================================== */
"use strict";

// Feste Farbreihenfolge für Linien (geprüfte Palette, gut unterscheidbar)
const SERIEN_FARBEN = ["var(--serie-1)", "var(--serie-2)", "var(--serie-3)", "var(--serie-4)", "var(--serie-5)", "var(--serie-6)"];
const chartDaten = {};      // Daten pro Diagramm (für den Tooltip)
let chartZaehler = 0;

const fmtMonatKurz = new Intl.DateTimeFormat("de-CH", { timeZone: "UTC", month: "short", year: "2-digit" });
const fmtTagMonatJahr = new Intl.DateTimeFormat("de-CH", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });

function datumZuZahl(d) { return Date.parse(d + "T00:00:00Z"); }

/** Schöne Achsenwerte (z.B. 0, 1, 2, 3 statt 0.13, 1.27 …) */
function achsenSchritte(min, max, anzahl = 4) {
  const spanne = max - min || Math.abs(max) || 1;
  const roh = spanne / anzahl;
  const basis = Math.pow(10, Math.floor(Math.log10(roh)));
  const schritt = [1, 2, 2.5, 5, 10].map((f) => f * basis).find((s) => s >= roh) || roh;
  const start = Math.floor(min / schritt) * schritt;
  const werte = [];
  for (let v = start; v <= max + schritt * 0.001; v += schritt) werte.push(Math.round(v * 1e6) / 1e6);
  return werte;
}

/**
 * Liniendiagramm.
 * serien: [{ name, x: [...Datum "JJJJ-MM-TT" oder Zahl], y: [...], farbe?, gestrichelt?, flaeche? }]
 * optionen: { hoehe, einheit, nullLinie, yFormat(v), xFormat(x), xTyp: "datum"|"zahl", legende, band:{min,max}, markierungen:[{x, text, klasse}] }
 */
function linienChart(serien, optionen = {}) {
  const id = "c" + (++chartZaehler);
  const B = 320, H = optionen.hoehe || 170, L = 40, R = 8, O = 10, U = 22;
  const xTyp = optionen.xTyp || "datum";
  const xWert = (x) => (xTyp === "datum" ? datumZuZahl(x) : x);
  const alleX = serien.flatMap((s) => s.x.map(xWert));
  const alleY = serien.flatMap((s) => s.y.filter((v) => v !== null && v !== undefined && !isNaN(v)));
  if (!alleX.length || !alleY.length) return '<p class="leise klein">Keine Daten.</p>';
  if (optionen.band) alleY.push(optionen.band.min, optionen.band.max);
  if (optionen.nullLinie) alleY.push(0);
  const xmin = Math.min(...alleX), xmax = Math.max(...alleX);
  let ymin = Math.min(...alleY), ymax = Math.max(...alleY);
  const puffer = (ymax - ymin) * 0.06 || 1;
  ymin -= puffer; ymax += puffer;
  const schritte = achsenSchritte(ymin, ymax);
  ymin = Math.min(ymin, schritte[0]); ymax = Math.max(ymax, schritte[schritte.length - 1]);
  const px = (x) => L + ((xWert(x) - xmin) / (xmax - xmin || 1)) * (B - L - R);
  const py = (y) => O + (1 - (y - ymin) / (ymax - ymin || 1)) * (H - O - U);
  const yf = optionen.yFormat || ((v) => zahl(v, Math.abs(ymax - ymin) < 10 ? 1 : 0));

  let svg = "";
  // Gitterlinien + y-Achse
  for (const v of schritte) {
    if (v < ymin - 1e-9 || v > ymax + 1e-9) continue;
    svg += `<line x1="${L}" x2="${B - R}" y1="${py(v).toFixed(1)}" y2="${py(v).toFixed(1)}" class="gitter${v === 0 && optionen.nullLinie ? " null" : ""}"/>`;
    svg += `<text x="${L - 5}" y="${(py(v) + 3).toFixed(1)}" class="achse-text" text-anchor="end">${yf(v)}</text>`;
  }
  // x-Achse: 3–4 Beschriftungen
  const xAnz = 4;
  for (let i = 0; i < xAnz; i++) {
    const xv = xmin + ((xmax - xmin) * i) / (xAnz - 1);
    const text = optionen.xFormat ? optionen.xFormat(xv) : xTyp === "datum" ? fmtMonatKurz.format(new Date(xv)) : zahl(xv, 0);
    const xp = L + ((xv - xmin) / (xmax - xmin || 1)) * (B - L - R);
    svg += `<text x="${xp.toFixed(1)}" y="${H - 6}" class="achse-text" text-anchor="${i === 0 ? "start" : i === xAnz - 1 ? "end" : "middle"}">${text}</text>`;
  }
  // Band (z.B. Spanne min–max)
  if (optionen.band) {
    svg += `<rect x="${L}" width="${B - L - R}" y="${py(optionen.band.max).toFixed(1)}" height="${(py(optionen.band.min) - py(optionen.band.max)).toFixed(1)}" class="band"/>`;
  }
  // Linien
  serien.forEach((s, i) => {
    const farbe = s.farbe || SERIEN_FARBEN[i % SERIEN_FARBEN.length];
    let pfad = "", offen = false;
    s.x.forEach((x, j) => {
      const y = s.y[j];
      if (y === null || y === undefined || isNaN(y)) { offen = false; return; }
      pfad += `${offen ? "L" : "M"}${px(x).toFixed(1)} ${py(y).toFixed(1)} `;
      offen = true;
    });
    if (s.flaeche) {
      const erste = s.x.findIndex((_, j) => s.y[j] !== null && s.y[j] !== undefined);
      svg += `<path d="${pfad} L${px(s.x[s.x.length - 1]).toFixed(1)} ${py(Math.max(ymin, 0)).toFixed(1)} L${px(s.x[erste]).toFixed(1)} ${py(Math.max(ymin, 0)).toFixed(1)} Z" fill="${farbe}" opacity="0.14"/>`;
    }
    svg += `<path d="${pfad}" fill="none" stroke="${farbe}" stroke-width="${s.dicke || 2}" ${s.gestrichelt ? 'stroke-dasharray="4 3"' : ""} stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`;
  });
  // Markierungen (z.B. Golden Cross)
  for (const m of optionen.markierungen || []) {
    const xp = px(m.x);
    svg += `<line x1="${xp.toFixed(1)}" x2="${xp.toFixed(1)}" y1="${O}" y2="${H - U}" class="markierung ${m.klasse || ""}"/>`;
    svg += `<text x="${xp.toFixed(1)}" y="${O + 8}" class="achse-text markierung-text ${m.klasse || ""}" text-anchor="middle">${esc(m.text)}</text>`;
  }

  chartDaten[id] = { serien, px, py, xWert, xTyp, B, H, L, R, O, U, einheit: optionen.einheit || "", yTooltip: optionen.yTooltip || yf, xFormat: optionen.xTooltip };
  const legende = !optionen.ohneLegende && (serien.length > 1 || optionen.legende)
    ? `<div class="legende">${serien.map((s, i) => `<span><i style="background:${s.farbe || SERIEN_FARBEN[i % SERIEN_FARBEN.length]}"></i>${esc(s.name)}</span>`).join("")}</div>` : "";
  return `<div class="chart" data-chart="${id}">
    ${legende}
    <svg viewBox="0 0 ${B} ${H}" role="img" aria-label="${esc(optionen.titel || "Diagramm")}">${svg}
      <line class="fadenkreuz" x1="0" x2="0" y1="${O}" y2="${H - U}" visibility="hidden"/>
    </svg>
    <div class="chart-tooltip versteckt"></div>
  </div>`;
}

/** Tooltip: nächster Punkt jeder Linie zur Finger-/Mausposition */
function chartZeigen(ev) {
  const box = ev.target.closest(".chart[data-chart]");
  if (!box) return;
  const d = chartDaten[box.dataset.chart];
  if (!d) return;
  const svg = box.querySelector("svg"), rect = svg.getBoundingClientRect();
  const punkt = ev.touches ? ev.touches[0] : ev;
  const xp = ((punkt.clientX - rect.left) / rect.width) * d.B;
  if (xp < d.L || xp > d.B - d.R) return;
  let bestX = null, zeilen = [];
  d.serien.forEach((s, i) => {
    let besteJ = -1, abstand = Infinity;
    s.x.forEach((x, j) => {
      if (s.y[j] === null || s.y[j] === undefined) return;
      const a = Math.abs(d.px(x) - xp);
      if (a < abstand) { abstand = a; besteJ = j; }
    });
    if (besteJ < 0) return;
    if (bestX === null) bestX = s.x[besteJ];
    const farbe = s.farbe || SERIEN_FARBEN[i % SERIEN_FARBEN.length];
    zeilen.push(`<div><i style="background:${farbe}"></i>${esc(s.name)}: <b>${d.yTooltip(s.y[besteJ])}${d.einheit ? " " + esc(d.einheit) : ""}</b></div>`);
  });
  if (bestX === null) return;
  const linie = svg.querySelector(".fadenkreuz");
  const lx = d.px(bestX);
  linie.setAttribute("x1", lx); linie.setAttribute("x2", lx); linie.setAttribute("visibility", "visible");
  const tip = box.querySelector(".chart-tooltip");
  const titel = d.xFormat ? d.xFormat(bestX) : d.xTyp === "datum" ? fmtTagMonatJahr.format(new Date(d.xWert(bestX))) : String(bestX);
  tip.innerHTML = `<div class="tip-titel">${esc(titel)}</div>${zeilen.join("")}`;
  tip.classList.remove("versteckt");
  const links = (lx / d.B) * rect.width;
  tip.style.left = `${Math.min(Math.max(links - tip.offsetWidth / 2, 0), rect.width - tip.offsetWidth)}px`;
}

function chartVerbergen(ev) {
  const box = ev.target.closest && ev.target.closest(".chart[data-chart]");
  if (!box) return;
  box.querySelector(".chart-tooltip").classList.add("versteckt");
  const l = box.querySelector(".fadenkreuz");
  if (l) l.setAttribute("visibility", "hidden");
}

document.addEventListener("pointermove", chartZeigen);
document.addEventListener("pointerdown", chartZeigen);
document.addEventListener("pointerleave", chartVerbergen, true);
document.addEventListener("pointerout", (ev) => { if (ev.target.tagName === "svg") chartVerbergen(ev); });

/** Farbe für eine Veränderung: rot – grau – grün (Stärke nach Betrag) */
function divergierendeFarbe(p, grenze) {
  if (p === null || p === undefined || isNaN(p)) return "var(--neutral-hg)";
  const t = Math.max(-1, Math.min(1, p / grenze));
  const staerke = Math.round(Math.abs(t) * 100);
  const ziel = t >= 0 ? "var(--plus)" : "var(--minus)";
  return `color-mix(in srgb, ${ziel} ${Math.max(staerke, 8)}%, var(--neutral-mitte))`;
}
