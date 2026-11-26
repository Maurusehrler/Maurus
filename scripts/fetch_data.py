#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Börsen-Übersicht: Daten-Skript
==============================

Dieses Skript holt alle Kurse, News und Termine aus KOSTENLOSEN Quellen und
speichert sie in der Datei  docs/data/markets.json .
Die Webseite (docs/index.html) liest danach nur noch diese Datei.

Aufruf:
    python scripts/fetch_data.py                 # echte Daten holen
    python scripts/fetch_data.py --beispieldaten # Testdaten erzeugen (ohne Internet)

Datenquellen (alle gratis, ohne API-Schlüssel):
    - Yahoo Finance über die Bibliothek "yfinance"  (Indizes, Aktien, Rohstoffe, Devisen)
    - stooq.com                                       (Ersatzquelle für Indizes/US-Aktien)
    - CoinGecko                                       (Krypto)
    - frankfurter.app (EZB-Referenzkurse)             (Ersatzquelle für Devisen)
    - RSS-Feeds verschiedener Medien                  (News)
    - ForexFactory-Wochenkalender + yfinance          (Wirtschaftskalender, Quartalszahlen)

Fehlertoleranz:
    Jede Quelle wird einzeln in try/except abgefragt. Fällt eine aus, wird
    die nächste Ersatzquelle versucht. Klappt gar nichts, wird der letzte
    bekannte Wert aus der bisherigen JSON-Datei übernommen und als
    "veraltet" markiert. So geht nie die ganze Seite kaputt.
"""

from __future__ import annotations

import argparse
import html
import io
import json
import logging
import os
import random
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import requests
import yaml

# ---------------------------------------------------------------------------
# Grundeinstellungen
# ---------------------------------------------------------------------------
ROOT = Path(__file__).resolve().parent.parent          # Hauptordner des Projekts
CONFIG_DATEI = ROOT / "config.yaml"
AUSGABE_DATEI = ROOT / "docs" / "data" / "markets.json"

# Viele Webseiten blockieren Anfragen ohne "Browser-Kennung".
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.0 Safari/605.1.15"
)
VERLAUF_PUNKTE = 23        # ca. 1 Monat Handelstage für die Mini-Charts

logging.basicConfig(level=logging.INFO, format="%(levelname)-7s %(message)s")
log = logging.getLogger("boerse")
# yfinance ist sehr gesprächig – nur echte Fehler anzeigen
logging.getLogger("yfinance").setLevel(logging.CRITICAL)

# Kategorie-Namen für Texte
KATEGORIE_TEXT = {
    "index": "Index", "aktie_ch": "CH-Aktie", "aktie_us": "US-Aktie",
    "krypto": "Krypto", "rohstoff": "Rohstoff", "devisen": "Devisen", "weitere": "Indikator",
}


# ===========================================================================
# Hilfsfunktionen
# ===========================================================================
def jetzt_utc() -> datetime:
    return datetime.now(timezone.utc)


def zahl_ch(wert: float, stellen: int = 2) -> str:
    """Formatiert eine Zahl im Schweizer Format: 12'345.67"""
    return f"{wert:,.{stellen}f}".replace(",", "'")


def prozent_text(p: float, mit_vorzeichen: bool = True) -> str:
    """0.8 -> '+0.8 %'"""
    if mit_vorzeichen:
        return f"{'+' if p >= 0 else '−'}{abs(p):.1f}\u00a0%"
    return f"{abs(p):.1f}\u00a0%"


def runden(v: float) -> float:
    """Rundet sinnvoll, damit die JSON-Datei klein bleibt."""
    if v is None:
        return None
    a = abs(v)
    if a < 10:
        return round(v, 5)
    if a < 1000:
        return round(v, 3)
    return round(v, 2)


def http_get(url: str, timeout: int = 20, versuche: int = 3, **kwargs) -> requests.Response:
    """GET-Anfrage mit mehreren Versuchen (wartet zwischen den Versuchen länger)."""
    headers = {"User-Agent": USER_AGENT, "Accept": "*/*"}
    headers.update(kwargs.pop("headers", {}))
    letzter_fehler = None
    for i in range(versuche):
        try:
            r = requests.get(url, headers=headers, timeout=timeout, **kwargs)
            if r.status_code == 429:              # "zu viele Anfragen" -> warten
                raise requests.HTTPError("429 Too Many Requests")
            r.raise_for_status()
            return r
        except Exception as e:                    # noqa: BLE001 – bewusst alles abfangen
            letzter_fehler = e
            time.sleep(2 * (i + 1))
    raise letzter_fehler  # type: ignore[misc]


def lade_json(pfad: Path) -> dict:
    """Liest eine JSON-Datei; bei Problemen kommt ein leeres dict zurück."""
    try:
        with open(pfad, encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return {}


def boerse_offen(boerse: dict, zeitpunkt: datetime) -> bool:
    """True, wenn die Börse zum angegebenen Zeitpunkt geöffnet ist."""
    lokal = zeitpunkt.astimezone(ZoneInfo(boerse["zeitzone"]))
    if lokal.weekday() >= 5 or lokal.strftime("%Y-%m-%d") in boerse.get("feiertage", []):
        return False
    hm = lokal.strftime("%H:%M")
    return boerse["oeffnung"] <= hm < boerse["schluss"]


# ===========================================================================
# 1) KURSE
# ===========================================================================
def yahoo_mehrere(symbole: list[str]) -> dict[str, list[tuple[str, float]]]:
    """Holt Tageskurse (2 Monate) für viele Symbole in EINER Anfrage (schont das Limit)."""
    ergebnis: dict[str, list[tuple[str, float]]] = {}
    if not symbole:
        return ergebnis
    try:
        import yfinance as yf
        df = yf.download(symbole, period="2mo", interval="1d", group_by="ticker",
                         auto_adjust=False, progress=False, threads=True)
    except Exception as e:  # noqa: BLE001
        log.warning("Yahoo (Sammelabfrage) fehlgeschlagen: %s", e)
        return ergebnis
    if df is None or df.empty:
        log.warning("Yahoo (Sammelabfrage) lieferte keine Daten")
        return ergebnis
    mehrstufig = getattr(df.columns, "nlevels", 1) > 1
    for s in symbole:
        try:
            teil = df[s] if mehrstufig else df
            serie = teil["Close"].dropna()
            punkte = [(idx.strftime("%Y-%m-%d"), float(v)) for idx, v in serie.items()]
            if len(punkte) >= 2:
                ergebnis[s] = punkte
        except Exception:  # noqa: BLE001
            pass
    return ergebnis


def yahoo_einzeln(symbol: str) -> list[tuple[str, float]] | None:
    """Zweiter Versuch für ein einzelnes Symbol (zwei verschiedene Abfragearten)."""
    import yfinance as yf
    for versuch in ("history", "download"):
        try:
            if versuch == "history":
                df = yf.Ticker(symbol).history(period="2mo", interval="1d", auto_adjust=False)
            else:
                df = yf.download(symbol, period="3mo", interval="1d", auto_adjust=False,
                                 progress=False, multi_level_index=False)
            serie = df["Close"].dropna()
            punkte = [(idx.strftime("%Y-%m-%d"), float(v)) for idx, v in serie.items()]
            if len(punkte) >= 2:
                return punkte
            log.info("  %s (%s): keine Kursreihe erhalten", symbol, versuch)
        except Exception as e:  # noqa: BLE001
            log.info("  %s (%s) fehlgeschlagen: %s", symbol, versuch, str(e)[:120])
        time.sleep(1)
    return None


def stooq(symbol: str) -> list[tuple[str, float]] | None:
    """Ersatzquelle stooq.com (CSV-Download)."""
    try:
        r = http_get(f"https://stooq.com/q/d/l/?s={symbol}&i=d", timeout=15, versuche=2)
        zeilen = r.text.strip().splitlines()
        if not zeilen or not zeilen[0].lower().startswith("date"):
            return None
        punkte = []
        for z in zeilen[1:][-45:]:
            teile = z.split(",")
            punkte.append((teile[0], float(teile[4])))   # Datum, Schlusskurs
        return punkte if len(punkte) >= 2 else None
    except Exception:  # noqa: BLE001
        return None


def frankfurter(basis: str, ziel: str) -> list[tuple[str, float]] | None:
    """Ersatzquelle für Devisen: offizielle EZB-Referenzkurse."""
    start = (date.today() - timedelta(days=45)).isoformat()
    for url in (f"https://api.frankfurter.app/{start}..?from={basis}&to={ziel}",
                f"https://api.frankfurter.dev/v1/{start}..?base={basis}&symbols={ziel}"):
        try:
            daten = http_get(url, timeout=15, versuche=2).json()
            punkte = sorted((d, float(v[ziel])) for d, v in daten["rates"].items())
            if len(punkte) >= 2:
                return punkte
        except Exception:  # noqa: BLE001
            continue
    return None


def coingecko(eintraege: list[dict]) -> dict[str, dict]:
    """Krypto-Kurse von CoinGecko (gratis, ohne Schlüssel)."""
    ergebnis: dict[str, dict] = {}
    ids = ",".join(e["coingecko"] for e in eintraege)
    try:
        markt = http_get(
            "https://api.coingecko.com/api/v3/coins/markets",
            params={"vs_currency": "usd", "ids": ids, "price_change_percentage": "24h"},
            headers={"Accept": "application/json"},
        ).json()
    except Exception as e:  # noqa: BLE001
        log.warning("CoinGecko nicht erreichbar: %s", e)
        return ergebnis
    for m in markt:
        try:
            verlauf = None
            try:   # Verlauf der letzten 30 Tage (eine Anfrage pro Coin)
                time.sleep(1.5)  # freundlich zum Gratis-Limit
                chart = http_get(
                    f"https://api.coingecko.com/api/v3/coins/{m['id']}/market_chart",
                    params={"vs_currency": "usd", "days": "30", "interval": "daily"},
                    headers={"Accept": "application/json"}, versuche=2,
                ).json()
                verlauf = [float(p[1]) for p in chart["prices"]]
            except Exception:  # noqa: BLE001
                pass
            ergebnis[m["id"]] = {
                "kurs": float(m["current_price"]),
                "diff": float(m.get("price_change_24h") or 0),
                "diff_pct": float(m.get("price_change_percentage_24h") or 0),
                "verlauf": verlauf,
            }
        except Exception:  # noqa: BLE001
            continue
    return ergebnis


def eintrag_aus_serie(item: dict, kategorie: str, punkte: list[tuple[str, float]],
                      quelle: str) -> dict:
    """Baut aus einer Kursreihe einen Eintrag mit Stand, Veränderung und Verlauf."""
    werte = [v for _, v in punkte]
    kurs, vortag = werte[-1], werte[-2]
    diff = kurs - vortag
    return {
        **basis_eintrag(item, kategorie),
        "kurs": runden(kurs),
        "vortag": runden(vortag),
        "diff": runden(diff),
        "diff_pct": round(diff / vortag * 100, 3) if vortag else 0.0,
        "datum": punkte[-1][0],
        "verlauf": [runden(v) for v in werte[-VERLAUF_PUNKTE:]],
        "quelle": quelle,
        "stand": jetzt_utc().isoformat(timespec="seconds"),
        "veraltet": False,
    }


def basis_eintrag(item: dict, kategorie: str) -> dict:
    e = {"symbol": item["symbol"], "name": item["name"], "kategorie": kategorie}
    for feld in ("region", "einheit"):
        if feld in item:
            e[feld] = item[feld]
    return e


def ersatz_aus_vorherigem(item: dict, kategorie: str, vorher: dict) -> dict:
    """Letzten bekannten Wert übernehmen (oder leeren Eintrag, falls es keinen gibt)."""
    alt = vorher.get(f"{kategorie}:{item['symbol']}")
    if alt and alt.get("kurs") is not None and alt.get("quelle") != "Beispieldaten":
        e = dict(alt)
        e["veraltet"] = True
        e["hinweis"] = "Quelle nicht erreichbar – letzter bekannter Wert"
        return e
    return {**basis_eintrag(item, kategorie), "kurs": None, "fehler": True,
            "veraltet": True, "hinweis": "Keine Daten verfügbar"}


def zaehle(statistik: dict, e: dict) -> None:
    """Zählt, wie viele Kurse aus welcher Quelle stammen (für die Anzeige 'Datenquellen')."""
    schluessel = "veraltet/fehlend" if e.get("veraltet") else e.get("quelle", "?")
    statistik[schluessel] = statistik.get(schluessel, 0) + 1


def lade_kurse(cfg: dict, vorher: dict, statistik: dict) -> dict[str, list[dict]]:
    """Holt alle Kurse mit Ersatzquellen. Gibt pro Gruppe eine Liste zurück."""
    gruppen = [
        ("indizes", "index", cfg.get("indizes", [])),
        ("aktien_ch", "aktie_ch", cfg.get("aktien_ch", [])),
        ("aktien_us", "aktie_us", cfg.get("aktien_us", [])),
        ("rohstoffe", "rohstoff", cfg.get("rohstoffe", [])),
        ("devisen", "devisen", cfg.get("devisen", [])),
        ("weitere", "weitere", cfg.get("weitere", [])),
    ]
    krypto_cfg = cfg.get("krypto", [])

    # --- Schritt 1: Alles in einer Sammelabfrage bei Yahoo holen -----------
    alle = list(dict.fromkeys([i["symbol"] for _, _, l in gruppen for i in l] +
                              [k["symbol"] for k in krypto_cfg]))
    log.info("Hole %d Kurse bei Yahoo Finance …", len(alle))
    reihen = yahoo_mehrere(alle)
    log.info("  -> %d von %d erhalten", len(reihen), len(alle))

    # --- Schritt 2: Fehlende einzeln nachfragen (max. 15, sonst droht Sperre)
    fehlend = [s for s in alle if s not in reihen]
    if fehlend and len(fehlend) <= 15:
        for s in fehlend:
            p = yahoo_einzeln(s)
            if p:
                reihen[s] = p
            time.sleep(0.5)

    ergebnis: dict[str, list[dict]] = {}
    for gruppe, kategorie, liste in gruppen:
        eintraege = []
        for item in liste:
            sym = item["symbol"]
            e = None
            if sym in reihen:
                e = eintrag_aus_serie(item, kategorie, reihen[sym], "Yahoo Finance")
            # --- Schritt 3: Ersatzquellen -------------------------------------
            # a) Alternativ-Symbole aus config.yaml (z.B. andere Aktienklasse)
            for alt_symbol in item.get("alternativ", []) if e is None else []:
                p = yahoo_einzeln(alt_symbol)
                if p:
                    e = eintrag_aus_serie(item, kategorie, p, f"Yahoo Finance ({alt_symbol})")
                    break
            if e is None and item.get("stooq"):
                p = stooq(item["stooq"])
                if p:
                    e = eintrag_aus_serie(item, kategorie, p, "stooq.com")
            if e is None and kategorie == "devisen" and item.get("basis"):
                p = frankfurter(item["basis"], item["ziel"])
                if p:
                    e = eintrag_aus_serie(item, kategorie, p, "EZB (frankfurter.app)")
            # --- Schritt 4: letzter bekannter Wert ------------------------------
            if e is None:
                log.warning("  ! Keine aktuellen Daten für %s (%s)", item["name"], sym)
                e = ersatz_aus_vorherigem(item, kategorie, vorher)
            zaehle(statistik, e)
            eintraege.append(e)
        ergebnis[gruppe] = eintraege

    # --- Krypto: CoinGecko zuerst, dann Yahoo, dann letzter Wert -------------
    cg = coingecko(krypto_cfg) if krypto_cfg else {}
    krypto = []
    for item in krypto_cfg:
        d = cg.get(item["coingecko"])
        if d:
            e = {**basis_eintrag(item, "krypto"), "kurs": runden(d["kurs"]),
                 "diff": runden(d["diff"]), "diff_pct": round(d["diff_pct"], 3),
                 "datum": datetime.now(ZoneInfo("Europe/Zurich")).strftime("%Y-%m-%d"),
                 "verlauf": [runden(v) for v in (d["verlauf"] or [])][-31:]
                 or (vorher.get(f"krypto:{item['symbol']}", {}).get("verlauf") or []),
                 "quelle": "CoinGecko", "stand": jetzt_utc().isoformat(timespec="seconds"),
                 "veraltet": False, "zeitraum": "24 Std."}
        elif item["symbol"] in reihen:
            e = eintrag_aus_serie(item, "krypto", reihen[item["symbol"]], "Yahoo Finance")
        else:
            e = ersatz_aus_vorherigem(item, "krypto", vorher)
        zaehle(statistik, e)
        krypto.append(e)
    ergebnis["krypto"] = krypto
    return ergebnis


# ===========================================================================
# 2) NEWS AUS RSS-FEEDS
# ===========================================================================
def text_saeubern(t: str) -> str:
    """Entfernt HTML-Tags und überflüssige Leerzeichen."""
    t = re.sub(r"<[^>]+>", " ", t or "")
    return re.sub(r"\s+", " ", html.unescape(t)).strip()


def woerter(titel: str) -> set[str]:
    return {w for w in re.findall(r"[a-zäöüéèàß0-9]+", titel.lower()) if len(w) > 3}


def stichwort_treffer(titel: str, stichwoerter: dict[str, float],
                     ganze_woerter: set[str] = frozenset()) -> tuple[float, list[str]]:
    """Zählt Punkte für wichtige Stichwörter im Titel.

    - Abkürzungen (z.B. "Fed", "SNB", "Öl") müssen als ganzes Wort vorkommen und
      exakt so geschrieben sein ("Fed" trifft nicht "Federer").
    - Namen aus "ganze_woerter" (deine Aktien) ebenfalls nur als ganzes Wort
      ("Meta" trifft nicht "Metall").
    - Alle anderen Begriffe treffen auch Wortanfänge ("Zins" trifft "Zinsen").
    """
    punkte, treffer = 0.0, []
    for wort, gewicht in stichwoerter.items():
        anfang = r"(?<![\wäöüÄÖÜ])"
        ende = r"(?![\wäöüÄÖÜ])"
        if len(wort) <= 3 or wort.isupper():
            muster, flags = anfang + re.escape(wort) + ende, 0
        elif wort in ganze_woerter:
            muster, flags = anfang + re.escape(wort) + ende, re.IGNORECASE
        else:
            muster, flags = anfang + re.escape(wort), re.IGNORECASE
        if re.search(muster, titel, flags):
            punkte += float(gewicht)
            treffer.append(wort)
    return punkte, treffer


def lade_news(cfg: dict, vorher: dict) -> tuple[list[dict], list[dict]]:
    """Liest alle RSS-Feeds, entfernt Duplikate und sortiert nach Wichtigkeit."""
    import feedparser

    ncfg = cfg.get("news", {})
    feeds = ncfg.get("feeds", [])
    max_alter = timedelta(hours=ncfg.get("max_alter_stunden", 36))
    stichwoerter = {str(k): float(v) for k, v in (ncfg.get("stichwoerter") or {}).items()}
    # Die Namen der eigenen Aktien zählen automatisch als Stichwort
    aktien_namen = {item["name"] for item in cfg.get("aktien_ch", []) + cfg.get("aktien_us", [])}
    for name in aktien_namen:
        stichwoerter.setdefault(name, 2.5)

    jetzt = jetzt_utc()
    status, roh = [], []

    def ein_feed(feed: dict):
        try:
            r = http_get(feed["url"], timeout=15, versuche=2,
                         headers={"Accept": "application/rss+xml, application/xml, text/xml, */*"})
            geparst = feedparser.parse(r.content)
            artikel = []
            for x in geparst.entries:
                titel = text_saeubern(x.get("title", ""))
                link = x.get("link", "")
                if not titel or not link.startswith("http"):
                    continue
                zeit = None
                for feld in ("published_parsed", "updated_parsed"):
                    if x.get(feld):
                        zeit = datetime(*x[feld][:6], tzinfo=timezone.utc)
                        break
                artikel.append({"titel": titel, "link": link, "quelle": feed["name"],
                                "zeit": zeit, "bonus": float(feed.get("bonus", 0))})
            if not artikel:
                return feed, [], "Feed leer oder kein RSS"
            return feed, artikel, None
        except Exception as e:  # noqa: BLE001
            return feed, [], f"{type(e).__name__}: {str(e)[:90]}"

    with ThreadPoolExecutor(max_workers=6) as pool:
        for feed, artikel, fehler in pool.map(ein_feed, feeds):
            status.append({"name": feed["name"], "url": feed["url"], "ok": fehler is None,
                           "anzahl": len(artikel), "fehler": fehler})
            roh.extend(artikel)
            log.info("  Feed %-22s %s", feed["name"], f"OK ({len(artikel)})" if not fehler else f"FEHLER: {fehler}")

    # --- Bewerten -----------------------------------------------------------
    bewertet = []
    for a in roh:
        if a["zeit"] and a["zeit"] > jetzt + timedelta(hours=2):
            a["zeit"] = jetzt                      # falsche Zukunftszeiten korrigieren
        if a["zeit"] and jetzt - a["zeit"] > max_alter:
            continue                               # zu alt
        alter_h = (jetzt - a["zeit"]).total_seconds() / 3600 if a["zeit"] else 18
        aktualitaet = max(0.0, 10 - alter_h / 2.4)  # 10 Punkte = brandneu, 0 = 24 h alt
        punkte, treffer = stichwort_treffer(a["titel"], stichwoerter, aktien_namen)
        # Gesamtpunkte = Aktualität + Stichwörter (max. 12) + Bonus der Quelle (config.yaml)
        a["score"] = round(aktualitaet + min(punkte, 12) + a["bonus"], 2)
        a["tags"] = treffer[:3]
        bewertet.append(a)
    bewertet.sort(key=lambda a: (a["score"], a["zeit"] or jetzt), reverse=True)

    # --- Duplikate entfernen (gleicher Link oder sehr ähnlicher Titel) -------
    behalten, gesehene_links, gesehene_woerter = [], set(), []
    pro_quelle: dict[str, int] = {}
    max_pro_quelle = ncfg.get("max_pro_quelle", 6)
    for a in bewertet:
        link = a["link"].split("?")[0].rstrip("/")
        w = woerter(a["titel"])
        if link in gesehene_links:
            continue
        if any(w and len(w & g) / max(1, len(w | g)) >= 0.6 for g in gesehene_woerter):
            continue
        if pro_quelle.get(a["quelle"], 0) >= max_pro_quelle:
            continue
        gesehene_links.add(link)
        gesehene_woerter.append(w)
        pro_quelle[a["quelle"]] = pro_quelle.get(a["quelle"], 0) + 1
        behalten.append(a)
        if len(behalten) >= ncfg.get("max_artikel", 25):
            break

    news = [{"titel": a["titel"], "link": a["link"], "quelle": a["quelle"],
             "zeit": a["zeit"].isoformat(timespec="minutes") if a["zeit"] else None,
             "tags": a["tags"], "score": a["score"]} for a in behalten]

    # Falls ALLE Feeds ausgefallen sind: alte News behalten (mit Hinweis)
    if not news and vorher.get("news"):
        log.warning("Keine News erhalten – verwende die vorherigen Schlagzeilen")
        news = [dict(n, veraltet=True) for n in vorher["news"]]
    return news, status


# ===========================================================================
# 3) WIRTSCHAFTSKALENDER
# ===========================================================================
LAENDER = {"CHF": "Schweiz", "USD": "USA", "EUR": "Eurozone", "GBP": "Grossbritannien",
           "JPY": "Japan", "CNY": "China"}

# Übersetzung häufiger Termine (alles andere bleibt Englisch)
UEBERSETZUNG = {
    "Federal Funds Rate": "Fed-Zinsentscheid",
    "FOMC Statement": "Fed: geldpolitische Erklärung",
    "FOMC Press Conference": "Fed-Pressekonferenz",
    "FOMC Meeting Minutes": "Fed-Sitzungsprotokoll",
    "FOMC Economic Projections": "Fed-Wirtschaftsprognosen",
    "Fed Chair Powell Speaks": "Rede von Fed-Chef Powell",
    "Main Refinancing Rate": "EZB-Zinsentscheid",
    "Monetary Policy Statement": "EZB: geldpolitische Erklärung",
    "ECB Press Conference": "EZB-Pressekonferenz",
    "ECB President Lagarde Speaks": "Rede von EZB-Präsidentin Lagarde",
    "SNB Policy Rate": "SNB-Zinsentscheid",
    "SNB Monetary Policy Assessment": "SNB: geldpolitische Lagebeurteilung",
    "SNB Press Conference": "SNB-Pressekonferenz",
    "SNB Chairman Schlegel Speaks": "Rede von SNB-Präsident Schlegel",
    "CPI m/m": "Inflation (KPI) ggü. Vormonat",
    "CPI y/y": "Inflation (KPI) ggü. Vorjahr",
    "Core CPI m/m": "Kerninflation ggü. Vormonat",
    "Core CPI Flash Estimate y/y": "Kerninflation (Schnellschätzung) ggü. Vorjahr",
    "CPI Flash Estimate y/y": "Inflation (Schnellschätzung) ggü. Vorjahr",
    "Core PCE Price Index m/m": "PCE-Kerninflation ggü. Vormonat",
    "PPI m/m": "Produzentenpreise ggü. Vormonat",
    "Non-Farm Employment Change": "US-Arbeitsmarkt: neue Stellen",
    "Unemployment Rate": "Arbeitslosenquote",
    "Unemployment Claims": "Erstanträge Arbeitslosenhilfe",
    "Average Hourly Earnings m/m": "Stundenlöhne ggü. Vormonat",
    "Advance GDP q/q": "BIP (1. Schätzung) ggü. Vorquartal",
    "Prelim GDP q/q": "BIP (vorläufig) ggü. Vorquartal",
    "Final GDP q/q": "BIP (final) ggü. Vorquartal",
    "GDP q/q": "BIP ggü. Vorquartal",
    "Retail Sales m/m": "Detailhandelsumsätze ggü. Vormonat",
    "Core Retail Sales m/m": "Detailhandel (Kern) ggü. Vormonat",
    "ISM Manufacturing PMI": "ISM-Einkaufsmanagerindex Industrie",
    "ISM Services PMI": "ISM-Einkaufsmanagerindex Dienstleistungen",
    "Manufacturing PMI": "Einkaufsmanagerindex Industrie",
    "Services PMI": "Einkaufsmanagerindex Dienstleistungen",
    "KOF Economic Barometer": "KOF-Konjunkturbarometer",
    "German ifo Business Climate": "ifo-Geschäftsklima (DE)",
    "German ZEW Economic Sentiment": "ZEW-Konjunkturerwartungen (DE)",
    "CB Consumer Confidence": "Verbrauchervertrauen (Conference Board)",
    "Prelim UoM Consumer Sentiment": "Konsumklima Uni Michigan (vorläufig)",
    "JOLTS Job Openings": "Offene Stellen (JOLTS)",
    "Trade Balance": "Handelsbilanz",
}


def lade_kalender(cfg: dict, vorher: dict, quellen: dict) -> list[dict]:
    kcfg = cfg.get("kalender", {})
    tz = ZoneInfo(cfg.get("zeitzone", "Europe/Zurich"))
    heute = datetime.now(tz).date()
    termine: list[dict] = []

    # --- a) automatischer Wochenkalender (ForexFactory) ----------------------
    try:
        daten = http_get("https://nfs.faireconomy.media/ff_calendar_thisweek.json",
                         timeout=20, versuche=2).json()
        waehrungen = set(kcfg.get("waehrungen", ["CHF", "USD", "EUR"]))
        wichtig = set(kcfg.get("wichtigkeit", ["High"]))
        for ev in daten:
            land = ev.get("country")
            impact = ev.get("impact")
            if land not in waehrungen:
                continue
            if impact not in wichtig and not (land == "CHF" and kcfg.get("chf_auch_mittel") and impact == "Medium"):
                continue
            zeitpunkt = datetime.fromisoformat(ev["date"]).astimezone(tz)
            if zeitpunkt.date() < heute - timedelta(days=1):
                continue      # Vergangenes weglassen (gestern behalten wir noch)
            titel_en = ev.get("title", "")
            termine.append({
                "datum": zeitpunkt.strftime("%Y-%m-%d"),
                "zeit": zeitpunkt.strftime("%H:%M") if zeitpunkt.strftime("%H:%M") != "00:00" else None,
                "titel": UEBERSETZUNG.get(titel_en, titel_en),
                "land": LAENDER.get(land, land),
                "wichtigkeit": "hoch" if impact == "High" else "mittel",
                "prognose": ev.get("forecast") or None,
                "vorher": ev.get("previous") or None,
                "typ": "konjunktur",
            })
        quellen["kalender"] = "OK (ForexFactory)"
    except Exception as e:  # noqa: BLE001
        log.warning("Wirtschaftskalender nicht erreichbar: %s", e)
        quellen["kalender"] = f"Fehler: {str(e)[:80]} – zeige letzte bekannte Termine"
        termine.extend(t for t in vorher.get("kalender", [])
                       if t.get("typ") == "konjunktur" and t.get("datum", "") >= heute.isoformat())

    # --- b) eigene, fixe Termine aus config.yaml -----------------------------
    bis = heute + timedelta(days=21)
    for t in kcfg.get("eigene_termine", []) or []:
        try:
            d = date.fromisoformat(str(t["datum"]))
        except Exception:  # noqa: BLE001
            continue
        if heute <= d <= bis:
            # Doppelte vermeiden, falls der automatische Kalender den Termin schon hat
            termine.append({"datum": d.isoformat(), "zeit": t.get("zeit"), "titel": t["titel"],
                            "land": t.get("land", ""), "wichtigkeit": "hoch", "typ": "notenbank"})

    # --- c) Quartalszahlen der eigenen Aktien --------------------------------
    termine.extend(lade_quartalszahlen(cfg, vorher, heute, kcfg.get("quartalszahlen_tage", 14), quellen))

    termine.sort(key=lambda t: (t["datum"], t.get("zeit") or "99:99"))
    return termine


def lade_quartalszahlen(cfg: dict, vorher: dict, heute: date, tage: int, quellen: dict) -> list[dict]:
    aktien = cfg.get("aktien_ch", []) + cfg.get("aktien_us", [])
    bis = heute + timedelta(days=tage)

    def eine(item):
        try:
            import yfinance as yf
            kal = yf.Ticker(item["symbol"]).calendar or {}
            daten = kal.get("Earnings Date") or []
            if not isinstance(daten, list):
                daten = [daten]
            for d in daten:
                d = d if isinstance(d, date) else date.fromisoformat(str(d)[:10])
                if heute <= d <= bis:
                    return {"datum": d.isoformat(), "zeit": None,
                            "titel": f"Quartalszahlen {item['name']}",
                            "land": "Schweiz" if item["symbol"].endswith(".SW") else "USA",
                            "wichtigkeit": "mittel", "typ": "zahlen"}
            return False   # erfolgreich abgefragt, aber kein Termin im Zeitraum
        except Exception:  # noqa: BLE001
            return None    # Abfrage fehlgeschlagen

    with ThreadPoolExecutor(max_workers=4) as pool:
        resultate = list(pool.map(eine, aktien))
    erfolgreich = sum(r is not None for r in resultate)
    gefunden = [r for r in resultate if r]
    if aktien and erfolgreich == 0:
        quellen["quartalszahlen"] = "Fehler – zeige letzte bekannte Termine"
        return [t for t in vorher.get("kalender", [])
                if t.get("typ") == "zahlen" and t.get("datum", "") >= heute.isoformat()]
    quellen["quartalszahlen"] = f"OK ({erfolgreich}/{len(aktien)} Aktien abgefragt)"
    return gefunden


# ===========================================================================
# 4) AUSWERTUNG: Zusammenfassung und Auffälligkeiten
# ===========================================================================
def ok(e: dict | None) -> bool:
    return bool(e) and e.get("kurs") is not None and e.get("diff_pct") is not None


def finde(liste: list[dict], symbol: str) -> dict | None:
    return next((e for e in liste if e["symbol"] == symbol), None)


def richtung(p: float, hoeher="höher", tiefer="tiefer") -> str:
    if abs(p) < 0.05:
        return "praktisch unverändert"
    return f"{prozent_text(p, False)} {hoeher if p > 0 else tiefer}"


def bewegung(name: str, p: float, verb_plus="stieg", verb_minus="fiel") -> str:
    if abs(p) < 0.05:
        return f"{name} blieb praktisch unverändert"
    return f"{name} {verb_plus if p > 0 else verb_minus} um {prozent_text(p, False)}"


def erstelle_zusammenfassung(k: dict, cfg: dict, jetzt: datetime) -> list[str]:
    """Regelbasierter Tagesüberblick in ganzen Sätzen (ohne KI)."""
    saetze: list[str] = []
    boersen = {b["region"]: b for b in cfg.get("boersen", [])}

    def verb(region: str) -> str:
        b = boersen.get(region)
        return "notiert" if b and boerse_offen(b, jetzt) else "schloss"

    # --- Schweiz ---
    smi = finde(k["indizes"], "^SSMI")
    ch = sorted([a for a in k["aktien_ch"] if ok(a) and not a.get("veraltet")], key=lambda a: a["diff_pct"])
    if ok(smi):
        s = f"Der SMI {verb('Schweiz')} {richtung(smi['diff_pct'])} bei {zahl_ch(smi['kurs'])} Punkten"
        if ch and abs(smi["diff_pct"]) >= 0.05:
            if smi["diff_pct"] > 0 and ch[-1]["diff_pct"] > 0:
                s += f", angeführt von {ch[-1]['name']} ({prozent_text(ch[-1]['diff_pct'])})"
            elif smi["diff_pct"] < 0 and ch[0]["diff_pct"] < 0:
                s += f", belastet von {ch[0]['name']} ({prozent_text(ch[0]['diff_pct'])})"
        saetze.append(s + ".")

    # --- USA ---
    spx, ndq = finde(k["indizes"], "^GSPC"), finde(k["indizes"], "^IXIC")
    if ok(spx):
        s = f"An der Wall Street {verb('USA')} der S&P 500 {richtung(spx['diff_pct'])}"
        if ok(ndq):
            s += (f", der Nasdaq {'gewann' if ndq['diff_pct'] >= 0 else 'verlor'} "
                  f"{prozent_text(ndq['diff_pct'], False)}")
        saetze.append(s + ".")
    us = sorted([a for a in k["aktien_us"] if ok(a) and not a.get("veraltet")], key=lambda a: a["diff_pct"])
    if us:
        top = max(us, key=lambda a: abs(a["diff_pct"]))
        if abs(top["diff_pct"]) >= 2:
            saetze.append(f"Auffälligster US-Titel war {top['name']} ({prozent_text(top['diff_pct'])}).")

    # --- Europa ---
    dax = finde(k["indizes"], "^GDAXI")
    if ok(dax):
        saetze.append(f"{bewegung('Der DAX', dax['diff_pct'], 'gewann', 'verlor').replace(' um ', ' ')}.")

    # --- Krypto ---
    btc = next((e for e in k["krypto"] if e["name"].lower() == "bitcoin"), None)
    if ok(btc):
        saetze.append(f"{bewegung('Bitcoin', btc['diff_pct'])} auf {zahl_ch(btc['kurs'], 0)} USD"
                      f"{' (24 Std.)' if btc.get('zeitraum') else ''}.")

    # --- Rohstoffe (nur nennenswerte Bewegungen) ---
    teile = []
    for e in k["rohstoffe"]:
        if ok(e) and abs(e["diff_pct"]) >= 1:
            name = e["name"].replace("Öl (Brent)", "Brent-Öl").replace("Öl (WTI)", "WTI-Öl")
            teile.append(f"{name} {'verteuerte sich' if e['diff_pct'] > 0 else 'verbilligte sich'} "
                         f"um {prozent_text(e['diff_pct'], False)}")
    if teile:
        saetze.append(", ".join(teile[:3]) + ".")

    # --- Franken ---
    usdchf = finde(k["devisen"], "USDCHF=X")
    eurchf = finde(k["devisen"], "EURCHF=X")
    if ok(usdchf) and abs(usdchf["diff_pct"]) >= 0.4:
        auf = usdchf["diff_pct"] < 0
        saetze.append(f"Der Franken {'legte' if auf else 'gab'} gegenüber dem Dollar "
                      f"{'zu' if auf else 'nach'} (USD/CHF {zahl_ch(usdchf['kurs'], 4)}).")
    elif ok(eurchf) and abs(eurchf["diff_pct"]) >= 0.4:
        auf = eurchf["diff_pct"] < 0
        saetze.append(f"Der Franken {'legte' if auf else 'gab'} gegenüber dem Euro "
                      f"{'zu' if auf else 'nach'} (EUR/CHF {zahl_ch(eurchf['kurs'], 4)}).")

    # --- Stimmung (VIX) ---
    vix = finde(k["weitere"], "^VIX")
    if ok(vix):
        if vix["kurs"] >= 30:
            saetze.append(f"Die Nervosität ist hoch: Der VIX steht bei {zahl_ch(vix['kurs'], 1)}.")
        elif vix["kurs"] >= 20:
            saetze.append(f"Die Schwankungsbreite ist erhöht (VIX {zahl_ch(vix['kurs'], 1)}).")

    if not saetze:
        saetze.append("Aktuell liegen keine frischen Kursdaten vor.")
    return saetze


def erstelle_auffaelligkeiten(k: dict, cfg: dict) -> list[dict]:
    """Hinweise bei grossen Bewegungen gemäss den Schwellen in config.yaml."""
    s = cfg.get("schwellen", {})
    regeln = [("indizes", s.get("index", 2)), ("aktien_ch", s.get("aktie", 5)),
              ("aktien_us", s.get("aktie", 5)), ("krypto", s.get("krypto", 5)),
              ("rohstoffe", s.get("rohstoff", 3)), ("devisen", s.get("devisen", 1)),
              ("weitere", s.get("weitere", 10))]
    hinweise = []
    for gruppe, schwelle in regeln:
        for e in k.get(gruppe, []):
            if ok(e) and not e.get("veraltet") and abs(e["diff_pct"]) >= schwelle:
                hinweise.append({
                    "name": e["name"], "kategorie": KATEGORIE_TEXT.get(e["kategorie"], ""),
                    "diff_pct": e["diff_pct"], "schwelle": schwelle,
                    "text": f"{e['name']} {prozent_text(e['diff_pct'])} "
                            f"({KATEGORIE_TEXT.get(e['kategorie'], '')}, Schwelle ±{schwelle:g} %)",
                })
    vix = finde(k.get("weitere", []), "^VIX")
    if ok(vix) and vix["kurs"] >= 25:
        hinweise.append({"name": "VIX", "kategorie": "Indikator", "diff_pct": vix["diff_pct"],
                         "text": f"VIX auf erhöhtem Niveau ({zahl_ch(vix['kurs'], 1)}) – Märkte nervös"})
    hinweise.sort(key=lambda h: abs(h.get("diff_pct") or 0), reverse=True)
    return hinweise


# ===========================================================================
# 5) BEISPIELDATEN (zum Testen ohne Internet)
# ===========================================================================
BEISPIEL_KURSE = {
    "^SSMI": 12350, "^SSHI": 16800, "^GSPC": 6650, "^IXIC": 22400, "^DJI": 46800,
    "^GDAXI": 23900, "^STOXX50E": 5600, "NESN.SW": 78, "NOVN.SW": 98, "ROG.SW": 265,
    "UBSG.SW": 30, "ABBN.SW": 55, "ZURN.SW": 560, "CFR.SW": 160, "AAPL": 245, "MSFT": 510,
    "NVDA": 185, "AMZN": 230, "GOOGL": 250, "META": 720, "TSLA": 420, "GC=F": 3950,
    "SI=F": 48, "BZ=F": 66, "CL=F": 62, "USDCHF=X": 0.795, "EURCHF=X": 0.93,
    "EURUSD=X": 1.17, "^VIX": 17, "^TNX": 4.1, "BTC-USD": 98000, "ETH-USD": 3600,
}


def beispiel_kurse(cfg: dict) -> dict[str, list[dict]]:
    rnd = random.Random(42)
    heute = date.today()
    tage = [heute - timedelta(days=i) for i in range(40, -1, -1) if (heute - timedelta(days=i)).weekday() < 5]

    def serie(sym, vol):
        v = BEISPIEL_KURSE.get(sym, rnd.uniform(40, 400))
        punkte = []
        for t in tage:
            v *= 1 + rnd.gauss(0.0004, vol)
            punkte.append((t.isoformat(), v))
        return punkte

    vol = {"index": 0.009, "aktie_ch": 0.016, "aktie_us": 0.022, "rohstoff": 0.015,
           "devisen": 0.004, "weitere": 0.05, "krypto": 0.03}
    erg = {}
    for gruppe, kat in [("indizes", "index"), ("aktien_ch", "aktie_ch"), ("aktien_us", "aktie_us"),
                        ("rohstoffe", "rohstoff"), ("devisen", "devisen"), ("weitere", "weitere"),
                        ("krypto", "krypto")]:
        erg[gruppe] = [eintrag_aus_serie(i, kat, serie(i["symbol"], vol[kat]), "Beispieldaten")
                       for i in cfg.get(gruppe, [])]
    # Ein paar grosse Bewegungen einbauen, damit "Auffälligkeiten" etwas zeigen
    for gruppe, idx, faktor in [("aktien_us", 2, 1.064), ("aktien_ch", 2, 1.031), ("krypto", 0, 0.946)]:
        if len(erg[gruppe]) > idx:
            e = erg[gruppe][idx]
            e["kurs"] = runden(e["vortag"] * faktor)
            e["diff"] = runden(e["kurs"] - e["vortag"])
            e["diff_pct"] = round((faktor - 1) * 100, 3)
            e["verlauf"][-1] = e["kurs"]
    # Eine Position als "Quelle ausgefallen" markieren, um die Anzeige zu testen
    if erg["aktien_ch"]:
        e = erg["aktien_ch"][-1]
        e["veraltet"] = True
        e["hinweis"] = "Quelle nicht erreichbar – letzter bekannter Wert"
    return erg


def beispiel_news() -> list[dict]:
    jetzt = jetzt_utc()
    titel = [
        ("SNB belässt den Leitzins bei 0 Prozent", "NZZ Wirtschaft", ["SNB", "Leitzins"]),
        ("Fed signalisiert weitere Zinssenkung im Dezember", "CNBC", ["Fed", "Zins"]),
        ("Roche übertrifft Erwartungen mit neuem Medikament", "finews.ch", ["Roche"]),
        ("Inflation in der Eurozone sinkt auf 2,1 Prozent", "tagesschau Wirtschaft", ["Inflation"]),
        ("Nvidia-Aktie steigt nach Rekordumsatz deutlich", "MarketWatch", ["Nvidia"]),
        ("Franken bleibt gegenüber dem Euro stark", "SRF Wirtschaft", ["Franken"]),
        ("Bitcoin fällt unter wichtige Marke", "Yahoo Finance", ["Bitcoin"]),
        ("UBS baut weitere Stellen in der Schweiz ab", "cash.ch", ["UBS"]),
    ]
    return [{"titel": t, "link": "https://example.com/", "quelle": q,
             "zeit": (jetzt - timedelta(minutes=35 * i + 10)).isoformat(timespec="minutes"),
             "tags": tags, "score": 15 - i} for i, (t, q, tags) in enumerate(titel)]


def beispiel_kalender() -> list[dict]:
    h = date.today()
    return [
        {"datum": h.isoformat(), "zeit": "08:00", "titel": "KOF-Konjunkturbarometer", "land": "Schweiz",
         "wichtigkeit": "mittel", "prognose": "101.2", "vorher": "100.8", "typ": "konjunktur"},
        {"datum": h.isoformat(), "zeit": "14:30", "titel": "Inflation (KPI) ggü. Vorjahr", "land": "USA",
         "wichtigkeit": "hoch", "prognose": "2.9%", "vorher": "3.0%", "typ": "konjunktur"},
        {"datum": (h + timedelta(days=1)).isoformat(), "zeit": None, "titel": "Quartalszahlen Nvidia",
         "land": "USA", "wichtigkeit": "mittel", "typ": "zahlen"},
        {"datum": (h + timedelta(days=3)).isoformat(), "zeit": "09:30",
         "titel": "SNB geldpolitische Lagebeurteilung", "land": "Schweiz", "wichtigkeit": "hoch",
         "typ": "notenbank"},
    ]


# ===========================================================================
# HAUPTPROGRAMM
# ===========================================================================
def main() -> int:
    parser = argparse.ArgumentParser(description="Börsendaten holen und als JSON speichern")
    parser.add_argument("--beispieldaten", action="store_true", help="Testdaten ohne Internet erzeugen")
    parser.add_argument("--ausgabe", default=str(AUSGABE_DATEI), help="Pfad der JSON-Datei")
    args = parser.parse_args()

    with open(CONFIG_DATEI, encoding="utf-8") as f:
        cfg = yaml.safe_load(f)

    ausgabe = Path(args.ausgabe)
    vorher_json = lade_json(ausgabe)
    if vorher_json.get("beispieldaten") and not args.beispieldaten:
        vorher_json = {}   # Beispieldaten nie als "letzten bekannten Wert" verwenden
    # Vorherige Werte nach "kategorie:symbol" ablegen (für die Ersatz-Logik)
    vorher_map = {}
    for gruppe in ("indizes", "aktien_ch", "aktien_us", "krypto", "rohstoffe", "devisen", "weitere"):
        for e in vorher_json.get(gruppe, []) or []:
            vorher_map[f"{e.get('kategorie')}:{e.get('symbol')}"] = e

    tz = ZoneInfo(cfg.get("zeitzone", "Europe/Zurich"))
    jetzt = jetzt_utc()
    statistik: dict[str, int] = {}
    quellen: dict = {}

    if args.beispieldaten:
        log.info("Erzeuge BEISPIELDATEN (keine echten Kurse!)")
        kurse = beispiel_kurse(cfg)
        news, feed_status = beispiel_news(), [
            {"name": f["name"], "url": f["url"], "ok": True, "anzahl": 0, "fehler": None}
            for f in cfg.get("news", {}).get("feeds", [])]
        kalender = beispiel_kalender()
        quellen["kalender"] = "Beispieldaten"
        statistik["Beispieldaten"] = sum(len(v) for v in kurse.values())
    else:
        kurse = lade_kurse(cfg, vorher_map, statistik)
        log.info("Lade News …")
        news, feed_status = lade_news(cfg, vorher_json)
        log.info("Lade Wirtschaftskalender …")
        kalender = lade_kalender(cfg, vorher_json, quellen)

    lokal = jetzt.astimezone(tz)
    if os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch":
        lauf = "Manuelles Update"
    elif os.environ.get("GITHUB_EVENT_NAME") == "schedule":
        lauf = "Morgen-Update" if lokal.hour < 12 else "Abend-Update"
    else:
        lauf = "Update"

    frische = sum(1 for g in kurse.values() for e in g if e.get("kurs") is not None and not e.get("veraltet"))
    gesamt = sum(len(g) for g in kurse.values())

    zusammenfassung = erstelle_zusammenfassung(kurse, cfg, jetzt)
    if frische == 0 and vorher_json.get("zusammenfassung"):
        # Nichts Frisches erhalten: letzte gute Zusammenfassung behalten
        zusammenfassung = [z for z in vorher_json["zusammenfassung"] if not z.startswith("Hinweis:")]
        zusammenfassung.append("Hinweis: Die Datenquellen waren beim letzten Update nicht erreichbar – "
                               "dies ist der Stand der vorherigen Aktualisierung.")

    daten = {
        "version": 1,
        "erstellt": jetzt.isoformat(timespec="seconds"),
        "lauf": lauf,
        "beispieldaten": args.beispieldaten,
        "zeitzone": cfg.get("zeitzone", "Europe/Zurich"),
        "zusammenfassung": zusammenfassung,
        "auffaelligkeiten": erstelle_auffaelligkeiten(kurse, cfg),
        **kurse,
        "news": news,
        "kalender": kalender,
        "boersen": cfg.get("boersen", []),
        "quellen": {
            "kurse": statistik,
            "kurse_frisch": f"{frische} von {gesamt}",
            "feeds": feed_status,
            **quellen,
        },
    }

    # Sicher speichern: erst in eine temporäre Datei, dann umbenennen
    ausgabe.parent.mkdir(parents=True, exist_ok=True)
    tmp = ausgabe.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(daten, f, ensure_ascii=False, indent=1)
    os.replace(tmp, ausgabe)

    log.info("Gespeichert: %s", ausgabe)
    log.info("Kurse frisch: %d von %d | News: %d | Termine: %d", frische, gesamt, len(news), len(kalender))
    for satz in daten["zusammenfassung"]:
        log.info("  » %s", satz)
    if frische == 0 and not args.beispieldaten:
        # Sichtbare Warnung in GitHub Actions (die Seite zeigt die alten Werte weiter an)
        print("::warning::Keine einzige Kursquelle hat geantwortet – es werden die letzten bekannten Werte angezeigt.")
    elif frische < gesamt:
        print(f"::notice::{gesamt - frische} Kurse konnten nicht frisch geladen werden (letzter Wert wird angezeigt).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
