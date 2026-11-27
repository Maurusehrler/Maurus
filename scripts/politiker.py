# -*- coding: utf-8 -*-
"""
Aktien-Trades von US-Kongressabgeordneten (z.B. Nancy Pelosi)
=============================================================

Quelle: die OFFIZIELLEN Offenlegungen des US-Repräsentantenhauses
(House Clerk, "Periodic Transaction Reports" nach dem STOCK Act).
  - Jahres-Index (ZIP mit XML): wer hat wann eine Meldung eingereicht
  - Pro Meldung ein PDF mit den einzelnen Käufen/Verkäufen

Abgeordnete müssen Trades innerhalb von 45 Tagen melden – die Daten sind
also immer etwas verzögert. Handschriftliche (eingescannte) Meldungen
lassen sich nicht automatisch lesen; sie erscheinen mit Link zum PDF.

Bereits gelesene Meldungen werden in docs/data/politiker.json gemerkt,
damit pro Lauf nur neue PDFs geladen werden.
"""
from __future__ import annotations

import io
import logging
import re
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone

import requests

log = logging.getLogger("boerse")

INDEX_URL = "https://disclosures-clerk.house.gov/public_disc/financial-pdfs/{jahr}FD.zip"
PDF_URL = "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/{jahr}/{doc}.pdf"
# Öffentlicher Datensatz "congress-legislators" (zuerst direkt von GitHub, sonst von der Projektseite)
PARTEIEN_URLS = ["https://raw.githubusercontent.com/unitedstates/congress-legislators/gh-pages/legislators-current.json",
                 "https://theunitedstates.io/congress-legislators/legislators-current.json"]
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
                    "(KHTML, like Gecko) Version/17.0 Safari/605.1.15"}

ART = {"P": "Kauf", "S": "Verkauf", "S (partial)": "Teilverkauf", "E": "Tausch"}
BESITZER = {"SP": "Ehepartner", "JT": "gemeinsam", "DC": "Kind"}
ANLAGE = {"ST": "Aktie", "OP": "Option", "CS": "Anleihe", "GS": "Staatsanleihe", "EF": "ETF/Fonds",
          "MF": "Fonds", "OT": "Andere", "PS": "Vorzugsaktie", "CT": "Krypto"}

# Erkennt die Zeile mit Transaktionsart, zwei Daten und Betrag, z.B.
# "(NVDA) [ST] P 01/14/2025 01/14/2025 $1,000,001 - $5,000,000"
TRADE_RE = re.compile(
    r"^(?P<vor>.*?)\s*(?P<art>S \(partial\)|P|S|E)\s+(?P<d1>\d{1,2}/\d{1,2}/\d{4})\s+"
    r"(?P<d2>\d{1,2}/\d{1,2}/\d{4})\s*(?P<betrag>.*)$")


def _datum(us: str) -> str | None:
    try:
        return datetime.strptime(us, "%m/%d/%Y").strftime("%Y-%m-%d")
    except Exception:  # noqa: BLE001
        return None


def _betrag_zahlen(text: str) -> tuple[int | None, int | None]:
    zahlen = [int(z.replace(",", "")) for z in re.findall(r"\$([\d,]+)", text)]
    if not zahlen:
        return None, None
    return zahlen[0], (zahlen[1] if len(zahlen) > 1 else None)


def lese_ptr_text(text: str) -> list[dict]:
    """Zerlegt den Text eines elektronisch eingereichten PTR-PDFs in einzelne Trades."""
    text = text.replace("\x00", "")
    zeilen = [z.strip() for z in text.splitlines() if z.strip()]
    trades, puffer, gestartet = [], [], False
    i = 0
    while i < len(zeilen):
        z = zeilen[i]
        if not gestartet:
            if "$200?" in z or z.startswith("Gains >"):
                gestartet = True
            i += 1
            continue
        # Ende der Tabelle (Zertifizierung / Fussnoten)
        if z.startswith(("I V D", "I P O", "C S", "* For the complete", "Digitally Signed", "Certification")):
            break
        if z.startswith(("F S", "S O", "Filing ID", "ID Owner", "Type", "Date", "Amount", "Gains", "$200?")):
            i += 1
            continue
        if z.startswith("D :") or z.startswith("D:"):
            if trades:
                trades[-1]["beschreibung"] = z.split(":", 1)[1].strip()[:240]
            puffer = []
            i += 1
            continue
        kandidat = " ".join(puffer + [z])
        m = TRADE_RE.match(kandidat)
        if m and m.group("vor"):
            betrag = m.group("betrag").strip()
            # Betrag kann auf die nächste Zeile umbrechen: "$1,001 -" / "$15,000"
            if betrag.endswith("-") and i + 1 < len(zeilen) and zeilen[i + 1].startswith("$"):
                betrag += " " + zeilen[i + 1]
                i += 1
            vor = m.group("vor").strip()
            besitzer = ""
            mb = re.match(r"^(SP|JT|DC)\s+", vor)
            if mb:
                besitzer, vor = mb.group(1), vor[mb.end():]
            ticker = re.search(r"\(([A-Z][A-Z0-9.\-/]{0,9})\)", vor)
            typ = re.search(r"\[([A-Z]{2})\]", vor)
            name = re.sub(r"\s*\[[A-Z]{2}\]\s*", " ", vor)
            name = re.sub(r"\s*\(([A-Z][A-Z0-9.\-/]{0,9})\)\s*", " ", name).strip(" -")
            bmin, bmax = _betrag_zahlen(betrag)
            trades.append({
                "titel": name[:120],
                "ticker": ticker.group(1) if ticker else None,
                "anlage": ANLAGE.get(typ.group(1), typ.group(1)) if typ else None,
                "art": ART.get(m.group("art"), m.group("art")),
                "datum": _datum(m.group("d1")),
                "betrag": re.sub(r"\s+", " ", betrag)[:40],
                "betrag_min": bmin, "betrag_max": bmax,
                "besitzer": BESITZER.get(besitzer, "selbst"),
            })
            puffer = []
        else:
            puffer.append(z)
            if len(puffer) > 6:          # Schutz: unbekannter Text
                puffer = puffer[-3:]
        i += 1
    return trades


def _parteien() -> dict:
    """(Nachname, Bundesstaat) -> Partei (D/R/I) aus dem öffentlichen Datensatz 'congress-legislators'."""
    for url in PARTEIEN_URLS:
        try:
            daten = requests.get(url, headers=UA, timeout=20).json()
            tabelle = {}
            for p in daten:
                term = p["terms"][-1]
                kuerzel = {"Democrat": "D", "Republican": "R"}.get(term.get("party"), "I")
                tabelle[(p["name"]["last"].lower(), term.get("state"))] = kuerzel
            return tabelle
        except Exception as e:  # noqa: BLE001
            log.info("  Parteien-Liste (%s) nicht geladen: %s", url.split("/")[2], str(e)[:80])
    return {}


def _kurzer_titel(titel: str) -> str:
    """'Apple Inc. - Common Stock' -> 'Apple Inc.' (spart Platz)"""
    t = re.sub(r"\s*-\s*(Class [A-Z] )?(Common Stock|Ordinary Shares|Common Shares|American Depositary Shares?)\b.*$", "", titel)
    t = re.sub(r"\s+(Common Stock|Ordinary Shares)$", "", t)
    return t.strip()[:90]


def lade_politiker(alt: dict, max_neu: int = 200, tage: int = 365) -> dict:
    """Holt neue Meldungen (Index + PDFs) und gibt die aktualisierte Datensammlung zurück."""
    from pypdf import PdfReader

    heute = date.today()
    jahre = [heute.year] + ([heute.year - 1] if heute.month <= 2 else [])
    verarbeitet = dict(alt.get("verarbeitet") or {})
    trades = list(alt.get("trades") or [])
    meldungen = []
    for jahr in jahre:
        r = requests.get(INDEX_URL.format(jahr=jahr), headers=UA, timeout=90)
        r.raise_for_status()
        z = zipfile.ZipFile(io.BytesIO(r.content))
        xml = next(n for n in z.namelist() if n.lower().endswith(".xml"))
        t = z.read(xml).decode("utf-8", "ignore")
        for block in re.findall(r"<Member>(.*?)</Member>", t, re.S):
            feld = lambda n: (re.search(fr"<{n}>(.*?)</{n}>", block, re.S) or [None, ""])[1].strip()  # noqa: E731
            if feld("FilingType") != "P":
                continue
            meldungen.append({"doc": feld("DocID"), "jahr": feld("Year") or str(jahr),
                              "vorname": feld("First"), "name": feld("Last"),
                              "staat": feld("StateDst"), "eingereicht": _datum(feld("FilingDate")) or ""})
    log.info("  Kongress: %d Trade-Meldungen im Index, %d bereits gelesen", len(meldungen), len(verarbeitet))

    grenze = (heute - timedelta(days=tage)).isoformat()
    neu = [m for m in meldungen if m["doc"] not in verarbeitet and m["eingereicht"] >= grenze]
    neu.sort(key=lambda m: m["eingereicht"], reverse=True)
    neu = neu[:max_neu]
    parteien = _parteien()

    def lies(m):
        url = PDF_URL.format(jahr=m["jahr"], doc=m["doc"])
        try:
            r = requests.get(url, headers=UA, timeout=60)
            r.raise_for_status()
            text = "\n".join((p.extract_text() or "") for p in PdfReader(io.BytesIO(r.content)).pages)
            return m, url, lese_ptr_text(text), None
        except Exception as e:  # noqa: BLE001
            return m, url, None, str(e)[:80]

    gelesen = papier = fehler = 0
    with ThreadPoolExecutor(max_workers=6) as pool:
        for m, url, liste, err in pool.map(lies, neu):
            if err:
                fehler += 1
                continue                      # beim nächsten Lauf nochmals versuchen
            staat = m["staat"][:2]
            person = f"{m['vorname']} {m['name']}".strip()
            partei = parteien.get((m["name"].lower(), staat), "")
            basis = {"person": person, "nachname": m["name"], "staat": m["staat"], "partei": partei,
                     "gemeldet": m["eingereicht"], "doc": m["doc"], "jahr": m["jahr"]}
            if liste:
                gelesen += 1
                for t in liste:
                    t["titel"] = _kurzer_titel(t["titel"])
                    trades.append({**basis, **t})
            else:
                papier += 1   # eingescannt/handschriftlich -> nur Hinweis mit Link
                trades.append({**basis, "titel": "Meldung als PDF (nicht automatisch lesbar)", "ticker": None,
                               "art": "Meldung", "datum": m["eingereicht"], "betrag": "", "papier": True})
            verarbeitet[m["doc"]] = m["eingereicht"]
    log.info("  Kongress: %d neue PDFs gelesen, %d nicht lesbar (Scan), %d Fehler", gelesen, papier, fehler)

    # Parteien nachtragen (auch bei älteren Einträgen), Platz sparen
    for t in trades:
        if not t.get("partei") and parteien:
            t["partei"] = parteien.get((t.get("nachname", "").lower(), (t.get("staat") or "")[:2]), "")
        if "link" in t:                       # alte Form -> Dokument-Nummer + Jahr
            m = re.search(r"/(\d{4})/(\d+)\.pdf", t.pop("link"))
            if m:
                t["jahr"], t["doc"] = m.group(1), m.group(2)
        t.pop("kammer", None)
        if t.get("titel"):
            t["titel"] = _kurzer_titel(t["titel"])
        # Leere Felder und Standardwerte weglassen (Aktie, selbst) – spart Platz
        for k in [k for k, v in t.items() if v in (None, "") or (k, v) in (("anlage", "Aktie"), ("besitzer", "selbst"))]:
            del t[k]
    # Doppelte Meldungen (z.B. Korrekturen) entfernen: gleicher Trade -> neueste Meldung behalten
    eindeutig, gesehen = [], set()
    for t in sorted(trades, key=lambda t: t.get("gemeldet", ""), reverse=True):
        schluessel = (t.get("person"), t.get("ticker"), t.get("titel"), t.get("art"), t.get("datum"),
                      t.get("betrag"), t.get("besitzer"), t.get("doc") if t.get("papier") else "")
        if schluessel in gesehen:
            continue
        gesehen.add(schluessel)
        eindeutig.append(t)
    trades = eindeutig
    # Alte Einträge entfernen, nach Datum sortieren
    trades = [t for t in trades if (t.get("datum") or t.get("gemeldet") or "") >= grenze]
    trades.sort(key=lambda t: (t.get("gemeldet") or "", t.get("datum") or ""), reverse=True)
    verarbeitet = {d: v for d, v in verarbeitet.items() if v >= grenze}
    return {"stand": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "quelle": "U.S. House Clerk – Periodic Transaction Reports (STOCK Act)",
            "status": f"{len(meldungen)} Meldungen im Index, {gelesen} neu gelesen, {papier} Scans, {fehler} Fehler",
            "verarbeitet": verarbeitet, "trades": trades}
