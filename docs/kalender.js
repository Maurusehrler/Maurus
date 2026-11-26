/* =====================================================================
   Börsen-Übersicht – Kalender
   ---------------------------------------------------------------------
   Monatsansicht mit Punkten + Liste aller Termine:
   Quartalszahlen (mit Schätzungen), Dividenden, Notenbanken,
   Konjunkturdaten, eigene Events/Präsentationen, Optionsverfall,
   Börsenfeiertage. Die Termine kommen aus data/markets.json.
   ===================================================================== */
"use strict";

// Termin-Arten: Name, Symbol und Farbe (CSS-Klasse typ-...)
const TERMIN_TYPEN = {
  zahlen: { name: "Quartalszahlen", icon: "📊" },
  dividende: { name: "Dividenden", icon: "💰" },
  notenbank: { name: "Notenbanken", icon: "🏦" },
  konjunktur: { name: "Konjunktur", icon: "📈" },
  event: { name: "Events", icon: "🎤" },
  verfall: { name: "Verfall", icon: "⏳" },
  feiertag: { name: "Börse zu", icon: "🚫" },
};

const kal = {
  monat: null,          // erster Tag des angezeigten Monats (Date, UTC)
  filter: "alle",       // "alle" oder eine Termin-Art
  tag: null,            // ausgewählter Tag "JJJJ-MM-TT" oder null
};
try { const f = localStorage.getItem("kalFilter"); if (f && (f === "alle" || TERMIN_TYPEN[f])) kal.filter = f; } catch (e) { /* egal */ }

const fmtMonat = new Intl.DateTimeFormat("de-CH", { timeZone: "UTC", month: "long", year: "numeric" });

function alleTermine() {
  return (zustand.daten && zustand.daten.kalender) || [];
}

function gefilterteTermine() {
  return alleTermine().filter((t) => kal.filter === "alle" || t.typ === kal.filter);
}

/** Monatsraster (Montag bis Sonntag) mit farbigen Punkten pro Termin-Art */
function monatHtml() {
  const heute = isoTag(new Date());
  const j = kal.monat.getUTCFullYear(), m = kal.monat.getUTCMonth();
  const erster = new Date(Date.UTC(j, m, 1));
  const versatz = (erster.getUTCDay() + 6) % 7;                 // Montag = 0
  const tageImMonat = new Date(Date.UTC(j, m + 1, 0)).getUTCDate();
  const proTag = {};
  for (const t of gefilterteTermine()) (proTag[t.datum] = proTag[t.datum] || []).push(t);

  let html = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"].map((w) => `<div class="monat-wt">${w}</div>`).join("");
  for (let i = 0; i < versatz; i++) html += '<div class="monat-tag leer"></div>';
  for (let d = 1; d <= tageImMonat; d++) {
    const iso = `${j}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const termine = proTag[iso] || [];
    const typen = [...new Set(termine.map((t) => t.typ))].slice(0, 4);
    const klassen = ["monat-tag", iso === heute ? "heute" : "", iso === kal.tag ? "gewaehlt" : "", iso < heute ? "vorbei" : "", termine.length ? "hat-termine" : ""].join(" ");
    html += `<button type="button" class="${klassen}" data-kal-tag="${iso}" ${termine.length ? `aria-label="${d}. – ${termine.length} Termine"` : "disabled"}>
      <span class="monat-zahl">${d}</span>
      <span class="monat-punkte">${typen.map((t) => `<i class="typ-${t}"></i>`).join("")}</span>
    </button>`;
  }
  return html;
}

function filterHtml() {
  const zaehler = {};
  const heute = isoTag(new Date());
  for (const t of alleTermine()) if (t.datum >= heute) zaehler[t.typ] = (zaehler[t.typ] || 0) + 1;
  const chips = [`<button type="button" class="chip-knopf ${kal.filter === "alle" ? "aktiv" : ""}" data-kal-filter="alle">Alle</button>`];
  for (const [typ, info] of Object.entries(TERMIN_TYPEN)) {
    if (!zaehler[typ]) continue;
    chips.push(`<button type="button" class="chip-knopf ${kal.filter === typ ? "aktiv" : ""}" data-kal-filter="${typ}">
      <i class="typ-punkt typ-${typ}"></i>${info.name} <span class="leise">${zaehler[typ]}</span></button>`);
  }
  return chips.join("");
}

/** Liste der Termine, nach Tagen gruppiert */
function terminListeHtml() {
  const heute = isoTag(new Date());
  const morgen = isoTag(new Date(Date.now() + 864e5));
  const kuerzel = { Schweiz: "CH", USA: "US", Eurozone: "EU", Europa: "EU" };
  let termine = gefilterteTermine();
  // Ohne gewählten Tag: Termine des angezeigten Monats (ab heute)
  const monat = `${kal.monat.getUTCFullYear()}-${String(kal.monat.getUTCMonth() + 1).padStart(2, "0")}`;
  termine = kal.tag ? termine.filter((t) => t.datum === kal.tag)
    : termine.filter((t) => t.datum >= heute && t.datum.startsWith(monat));
  if (!termine.length) return '<p class="leise">Keine Termine für diese Auswahl.</p>';
  let html = "", letzterTag = "";
  for (const t of termine.slice(0, 150)) {
    if (t.datum !== letzterTag) {
      const [j, m, d] = t.datum.split("-").map(Number);
      const name = fmtWochentag.format(new Date(Date.UTC(j, m - 1, d)));
      html += `<div class="tag-titel">${t.datum === heute ? "Heute · " : t.datum === morgen ? "Morgen · " : ""}${esc(name)}</div>`;
      letzterTag = t.datum;
    }
    const info = TERMIN_TYPEN[t.typ] || { icon: "•", name: "" };
    const details = [t.prognose ? (t.typ === "konjunktur" ? `Prognose ${esc(t.prognose)}` : esc(t.prognose)) : "",
      t.vorher ? `zuvor ${esc(t.vorher)}` : ""].filter(Boolean).join(" · ");
    const klick = t.symbol ? ` klickbar" data-symbol="${esc(t.symbol)}` : "";
    html += `<div class="termin termin-${esc(t.wichtigkeit || "")}${klick}">
      <div class="zeit">${esc(t.zeit || "")}</div>
      <div><span class="termin-titel"><i class="typ-punkt typ-${esc(t.typ)}"></i>${t.land ? `<b>${esc(kuerzel[t.land] || t.land)}</b> ` : ""}${esc(t.titel)}</span>
      ${details ? `<div class="detail">${details}</div>` : ""}</div>
    </div>`;
  }
  return html;
}

function zeigeKalender() {
  if (!kal.monat) {
    const h = new Date();
    kal.monat = new Date(Date.UTC(h.getFullYear(), h.getMonth(), 1));
  }
  $("monat-titel").textContent = fmtMonat.format(kal.monat);
  $("monat").innerHTML = monatHtml();
  $("kalender-filter").innerHTML = filterHtml();
  $("termine-titel").textContent = kal.tag
    ? `Termine am ${kurzDatum(kal.tag)}`
    : `Termine im ${fmtMonat.format(kal.monat)}${kal.filter === "alle" ? "" : " · " + TERMIN_TYPEN[kal.filter].name}`;
  $("kalender").innerHTML = terminListeHtml();
}

// Bedienung
document.addEventListener("click", (ev) => {
  const tag = ev.target.closest("[data-kal-tag]");
  if (tag) { kal.tag = kal.tag === tag.dataset.kalTag ? null : tag.dataset.kalTag; zeigeKalender(); return; }
  const filter = ev.target.closest("[data-kal-filter]");
  if (filter) {
    kal.filter = filter.dataset.kalFilter;
    try { localStorage.setItem("kalFilter", kal.filter); } catch (e) { /* egal */ }
    zeigeKalender();
    return;
  }
  if (ev.target.closest("#monat-zurueck")) { kal.monat = new Date(Date.UTC(kal.monat.getUTCFullYear(), kal.monat.getUTCMonth() - 1, 1)); kal.tag = null; zeigeKalender(); }
  if (ev.target.closest("#monat-vor")) { kal.monat = new Date(Date.UTC(kal.monat.getUTCFullYear(), kal.monat.getUTCMonth() + 1, 1)); kal.tag = null; zeigeKalender(); }
});
