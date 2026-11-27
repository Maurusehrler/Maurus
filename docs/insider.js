/* =====================================================================
   Börsen-Übersicht – Insider & Politiker
   ---------------------------------------------------------------------
   1) US-Politiker: Aktien-Trades von Abgeordneten des Repräsentanten-
      hauses (offizielle STOCK-Act-Meldungen, Quelle: House Clerk).
      Achtung: Meldungen erfolgen bis zu 45 Tage nach dem Trade.
   2) Firmen-Insider: Käufe/Verkäufe von Managern und Verwaltungsräten
      der Aktien in deiner Liste (aus den Fundamentaldaten).
   ===================================================================== */
"use strict";

const POLITIKER_URL = "data/politiker.json";
let politikerDaten = null;
let politikerLaedt = null;
const pol = speicherLesen("politikerFilter", { art: "alle", person: "", nurBeobachtet: false, suche: "" });
let insiderArt = speicherLesen("insiderArt", "Kauf");

async function ladePolitiker() {
  if (politikerDaten) return politikerDaten;
  if (!politikerLaedt) {
    politikerLaedt = fetch(`${POLITIKER_URL}?t=${Date.now()}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null)
      .then((d) => { politikerDaten = d || { trades: [] }; return politikerDaten; });
  }
  return politikerLaedt;
}

function beobachtet(t) {
  const liste = ((zustand.daten && zustand.daten.politiker_beobachten) || []).map((n) => n.toLowerCase());
  return liste.includes((t.nachname || "").toLowerCase());
}

/** Geschätzter Betrag (Mitte der gemeldeten Spanne) */
function betragMitte(t) {
  if (!t.betrag_min) return 0;
  return t.betrag_max ? (t.betrag_min + t.betrag_max) / 2 : t.betrag_min;
}

function parteiBadge(p) {
  if (!p) return "";
  return `<span class="partei partei-${esc(p)}" title="${p === "D" ? "Demokraten" : p === "R" ? "Republikaner" : "Unabhängig"}">${esc(p)}</span>`;
}

/** Link zur offiziellen Meldung (PDF beim House Clerk) */
function pdfLink(t) {
  if (t.link) return sichererLink(t.link);
  return t.doc && t.jahr ? `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${encodeURIComponent(t.jahr)}/${encodeURIComponent(t.doc)}.pdf` : "";
}

function tradeZeile(t, { mitPerson = true } = {}) {
  const inListe = t.ticker && eindeutig(alleAktien()).some((a) => a.symbol === t.ticker);
  const klick = inListe ? ` klickbar" data-symbol="${esc(t.ticker)}` : "";
  const artKlasse = t.art === "Kauf" ? "plus" : t.art && t.art.includes("erkauf") ? "minus" : "";
  return `<div class="trade${klick}">
    <div class="trade-kopf">
      ${mitPerson ? `<span class="trade-person">${beobachtet(t) ? "⭐ " : ""}${esc(t.person)} ${parteiBadge(t.partei)} <span class="leise klein">${esc(t.staat || "")}</span></span>` : ""}
      <span class="pill ${artKlasse}">${esc(t.art || "")}</span>
    </div>
    <div class="trade-titel">${t.ticker ? `<b>${esc(t.ticker)}</b> ` : ""}${esc(t.titel || "")}${t.anlage && t.anlage !== "Aktie" ? ` <span class="tag">${esc(t.anlage)}</span>` : ""}</div>
    <div class="leise klein">${t.betrag ? esc(t.betrag) + " · " : ""}Trade ${t.datum ? kurzDatum(t.datum) + t.datum.slice(2, 4) : "–"} · gemeldet ${t.gemeldet ? kurzDatum(t.gemeldet) + t.gemeldet.slice(2, 4) : "–"}${t.besitzer && t.besitzer !== "selbst" ? " · " + esc(t.besitzer) : ""}
      ${pdfLink(t) ? ` · <a href="${esc(pdfLink(t))}" target="_blank" rel="noopener noreferrer">PDF</a>` : ""}</div>
    ${t.beschreibung ? `<div class="klein trade-beschreibung">${esc(t.beschreibung)}</div>` : ""}
  </div>`;
}

/* ---------------------------------------------------------------------
   US-Politiker
   --------------------------------------------------------------------- */
async function zeigePolitiker() {
  const ziel = $("politiker");
  ziel.innerHTML = '<section class="karte"><p class="leise">Wird geladen …</p></section>';
  const d = await ladePolitiker();
  const alle = (d.trades || []).filter((t) => !t.papier);
  if (!alle.length) {
    ziel.innerHTML = '<section class="karte"><p class="leise">Noch keine Politiker-Trades vorhanden. Sie werden beim nächsten Update geladen (die ersten Läufe lesen nach und nach alle Meldungen ein).</p></section>';
    return;
  }
  const personen = [...new Set(alle.map((t) => t.person))].sort();
  let liste = alle.filter((t) =>
    (pol.art === "alle" || (pol.art === "Kauf" ? t.art === "Kauf" : t.art !== "Kauf")) &&
    (!pol.person || t.person === pol.person) &&
    (!pol.nurBeobachtet || beobachtet(t)) &&
    (!pol.suche || (t.ticker || "").toLowerCase().includes(pol.suche.toLowerCase()) || (t.titel || "").toLowerCase().includes(pol.suche.toLowerCase())));

  // Auswertung: meistgekaufte Aktien und aktivste Politiker (letzte 90 Tage, gemeldet)
  const grenze = tageZurueck(90);
  const kaeufe = alle.filter((t) => t.art === "Kauf" && t.ticker && (t.gemeldet || "") >= grenze);
  const proTicker = {};
  for (const t of kaeufe) {
    const x = (proTicker[t.ticker] = proTicker[t.ticker] || { ticker: t.ticker, titel: t.titel, anzahl: 0, personen: new Set(), volumen: 0 });
    x.anzahl += 1; x.personen.add(t.nachname); x.volumen += betragMitte(t);
  }
  const top = Object.values(proTicker).sort((a, b) => b.personen.size - a.personen.size || b.volumen - a.volumen).slice(0, 10);
  const maxVol = Math.max(...top.map((x) => x.volumen), 1);
  const proPerson = {};
  for (const t of alle.filter((t) => (t.gemeldet || "") >= grenze)) {
    const x = (proPerson[t.person] = proPerson[t.person] || { person: t.person, partei: t.partei, trades: 0, volumen: 0 });
    x.trades += 1; x.volumen += betragMitte(t);
  }
  const aktivste = Object.values(proPerson).sort((a, b) => b.volumen - a.volumen).slice(0, 8);

  ziel.innerHTML = `
    <section class="karte hinweis-karte">
      <p class="klein">🏛️ Mitglieder des US-Repräsentantenhauses müssen Aktien-Trades (auch von Ehepartnern) innerhalb von 45 Tagen offenlegen (STOCK Act).
      Beträge werden nur als Spanne gemeldet. <span class="leise">Quelle: ${esc(d.quelle || "House Clerk")} · Stand ${d.stand ? fmtDatumZeit.format(new Date(d.stand)) : "–"}</span></p>
    </section>
    <div class="raster zwei-gleich">
      <section class="karte">
        <h2>Meistgekauft von Politikern <span class="etikett">90 Tage</span></h2>
        ${top.length ? `<div class="balken-liste">${top.map((x) => `<div class="balken-zeile einfach${eindeutig(alleAktien()).some((a) => a.symbol === x.ticker) ? ` klickbar" data-symbol="${esc(x.ticker)}` : ""}">
          <span class="n"><b>${esc(x.ticker)}</b> <span class="anz">${x.personen.size} Pers.</span></span>
          <span class="spur links"><span class="balken plus" style="width:${((x.volumen / maxVol) * 100).toFixed(1)}%"></span></span>
          <span class="wert">~${betrag(x.volumen)} $</span></div>`).join("")}</div>
          <p class="leise klein">Balken = geschätztes Kaufvolumen (Mitte der gemeldeten Spannen).</p>` : '<p class="leise klein">Keine Käufe.</p>'}
      </section>
      <section class="karte">
        <h2>Aktivste Politiker <span class="etikett">90 Tage</span></h2>
        <div class="zeilen">${aktivste.map((x) => `<button type="button" class="zeile zeile-knopf" data-pol-person="${esc(x.person)}">
          <div class="n">${esc(x.person)} ${parteiBadge(x.partei)}<span class="unter">${x.trades} Trades</span></div>
          <div class="k">~${betrag(x.volumen)} $</div><div></div></button>`).join("")}</div>
      </section>
    </div>
    <section class="karte">
      <div class="titel-zeile"><h2>Alle Trades <span class="etikett">${liste.length}</span></h2></div>
      <div class="filter-zeile-pol">
        <div class="umschalter" role="group" aria-label="Art">
          ${[["alle", "Alle"], ["Kauf", "Käufe"], ["Verkauf", "Verkäufe"]].map(([k, n]) => `<button type="button" data-pol-art="${k}" class="${pol.art === k ? "aktiv" : ""}">${n}</button>`).join("")}
        </div>
        <button type="button" class="chip-knopf ${pol.nurBeobachtet ? "aktiv" : ""}" data-pol-beobachtet>⭐ Nur beobachtete</button>
        <select id="pol-person" class="eingabe klein-eingabe" aria-label="Politiker"><option value="">Alle Politiker</option>
          ${personen.map((p) => `<option ${p === pol.person ? "selected" : ""}>${esc(p)}</option>`).join("")}</select>
        <input id="pol-suche" class="eingabe klein-eingabe" type="search" placeholder="Ticker, z.B. NVDA" value="${esc(pol.suche)}">
      </div>
      <div class="trades">${liste.slice(0, 150).map((t) => tradeZeile(t)).join("") || '<p class="leise">Keine Trades für diese Auswahl.</p>'}</div>
      ${liste.length > 150 ? `<p class="leise klein">… und ${liste.length - 150} weitere. Filter verwenden, um sie zu sehen.</p>` : ""}
    </section>`;
}

/** Übersicht: neueste Trades der beobachteten Politiker (steht schon in markets.json) */
async function zeigePolitikerKurz() {
  const ziel = $("politiker-kurz");
  if (!ziel) return;
  const kurz = zustand.daten && zustand.daten.politiker_neu;
  const d = kurz ? { trades: kurz } : await ladePolitiker();
  const alle = (d.trades || []).filter((t) => !t.papier && t.ticker);
  const auswahl = (alle.filter(beobachtet).length ? alle.filter(beobachtet) : alle).slice(0, 5);
  ziel.innerHTML = auswahl.length ? `<div class="trades">${auswahl.map((t) => tradeZeile(t)).join("")}</div>`
    : '<p class="leise klein">Noch keine Daten – erscheinen nach dem nächsten Update.</p>';
}

/** Detailansicht einer Aktie: Politiker-Trades zu diesem Ticker */
async function politikerZuAktie(symbol) {
  const d = await ladePolitiker();
  const basis = symbol.split(".")[0];
  return (d.trades || []).filter((t) => t.ticker === symbol || (!symbol.includes(".") && t.ticker === basis)).slice(0, 10);
}

/* ---------------------------------------------------------------------
   Firmen-Insider
   --------------------------------------------------------------------- */
function zeigeFirmenInsider() {
  const ziel = $("firmen-insider");
  if (!fundamental) { ziel.innerHTML = '<section class="karte"><p class="leise">Wird geladen …</p></section>'; return; }
  const alle = [];
  for (const [symbol, f] of Object.entries(fundamental.aktien || {})) {
    for (const i of f.insider || []) alle.push({ ...i, symbol, firma: f.name, waehrung: f.waehrung });
  }
  alle.sort((a, b) => b.datum.localeCompare(a.datum));
  const grenze = tageZurueck(180);
  // Netto-Käufe/-Verkäufe pro Aktie (180 Tage)
  const netto = {};
  for (const i of alle.filter((i) => i.datum >= grenze && (i.art === "Kauf" || i.art === "Verkauf"))) {
    const x = (netto[i.symbol] = netto[i.symbol] || { symbol: i.symbol, firma: i.firma, kauf: 0, verkauf: 0, waehrung: i.waehrung });
    if (i.art === "Kauf") x.kauf += i.wert || 0; else x.verkauf += i.wert || 0;
  }
  const mitKauf = Object.values(netto).filter((x) => x.kauf > 0).sort((a, b) => b.kauf - a.kauf);
  const liste = alle.filter((i) => insiderArt === "alle" || i.art === insiderArt);
  ziel.innerHTML = `
    <section class="karte hinweis-karte"><p class="klein">🕵️ Manager und Verwaltungsräte müssen eigene Aktienkäufe und -verkäufe melden.
      <b>Käufe gelten als aussagekräftiger</b> – Insider verkaufen aus vielen Gründen (Steuern, Hauskauf), kaufen aber meist nur, wenn sie an steigende Kurse glauben.
      <span class="leise">Quelle: Yahoo Finance (v.a. US-Aktien; für Schweizer Titel oft keine Daten).</span></p></section>
    <section class="karte">
      <h2>Aktien mit Insider-Käufen <span class="etikett">6 Monate</span></h2>
      ${mitKauf.length ? `<div class="zeilen">${mitKauf.map((x) => `<div class="zeile klickbar" data-symbol="${esc(x.symbol)}">
        <div class="n">${esc(x.firma)}<span class="unter">gekauft ${betrag(x.kauf, x.waehrung)}${x.verkauf ? ` · verkauft ${betrag(x.verkauf, x.waehrung)}` : ""}</span></div>
        <div></div><div><span class="pill plus">Kauf</span></div></div>`).join("")}</div>` : '<p class="leise klein">Keine Insider-Käufe in deinen Aktien.</p>'}
    </section>
    <section class="karte">
      <div class="titel-zeile"><h2>Alle Insider-Transaktionen</h2>
        <div class="umschalter" role="group" aria-label="Art">${[["Kauf", "Käufe"], ["Verkauf", "Verkäufe"], ["alle", "Alle"]].map(([k, n]) => `<button type="button" data-insider-art="${k}" class="${insiderArt === k ? "aktiv" : ""}">${n}</button>`).join("")}</div>
      </div>
      <div class="trades">${liste.slice(0, 120).map((i) => insiderZeile(i, true)).join("") || '<p class="leise">Keine Einträge.</p>'}</div>
    </section>`;
}

function insiderZeile(i, mitFirma) {
  const kl = i.art === "Kauf" ? "plus" : i.art === "Verkauf" ? "minus" : "";
  return `<div class="trade${mitFirma ? ` klickbar" data-symbol="${esc(i.symbol)}` : ""}">
    <div class="trade-kopf"><span class="trade-person">${mitFirma ? `<b>${esc(i.firma)}</b> · ` : ""}${esc(i.person)}</span><span class="pill ${kl}">${esc(i.art)}</span></div>
    <div class="leise klein">${esc(i.position || "")} · ${kurzDatum(i.datum)}${i.datum.slice(2, 4)}${i.aktien ? ` · ${zahl(i.aktien, 0)} Aktien` : ""}${i.wert ? ` · ${betrag(i.wert, i.waehrung || "")}` : ""}</div>
  </div>`;
}

function zeigeInsider() {
  if (zustand.unter.insider === "firmen") zeigeFirmenInsider(); else zeigePolitiker();
}

/* Bedienung */
document.addEventListener("click", (ev) => {
  const a = ev.target.closest("[data-pol-art]");
  if (a) { pol.art = a.dataset.polArt; speicherSchreiben("politikerFilter", pol); zeigePolitiker(); return; }
  if (ev.target.closest("[data-pol-beobachtet]")) { pol.nurBeobachtet = !pol.nurBeobachtet; speicherSchreiben("politikerFilter", pol); zeigePolitiker(); return; }
  const p = ev.target.closest("[data-pol-person]");
  if (p) { pol.person = p.dataset.polPerson; speicherSchreiben("politikerFilter", pol); zeigePolitiker().then(() => document.querySelector(".trades").scrollIntoView({ behavior: "smooth" })); return; }
  const ia = ev.target.closest("[data-insider-art]");
  if (ia) { insiderArt = ia.dataset.insiderArt; speicherSchreiben("insiderArt", insiderArt); zeigeFirmenInsider(); }
});
document.addEventListener("change", (ev) => {
  if (ev.target.id === "pol-person") { pol.person = ev.target.value; speicherSchreiben("politikerFilter", pol); zeigePolitiker(); }
  if (ev.target.id === "pol-suche") { pol.suche = ev.target.value.trim(); speicherSchreiben("politikerFilter", pol); zeigePolitiker(); }
});
