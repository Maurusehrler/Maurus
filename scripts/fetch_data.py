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
FUNDAMENTAL_DATEI = ROOT / "docs" / "data" / "fundamentals.json"
STECKBRIEF_DATEI = ROOT / "steckbriefe.yaml"
FUNDAMENTAL_MAX_ALTER_STD = 20    # Fundamentaldaten höchstens 1x pro Tag neu holen

# Viele Webseiten blockieren Anfragen ohne "Browser-Kennung".
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.0 Safari/605.1.15"
)
VERLAUF_PUNKTE = 270       # ca. 1 Jahr Handelstage (für Charts und Zeiträume 1W…1J)
# Zeiträume für den Umschalter in der App (Kürzel -> Kalendertage zurück)
ZEITRAEUME = {"1W": 7, "1M": 30, "3M": 91, "1J": 365, "3J": 1096, "5J": 1827}
LANGE_ZEITRAEUME = ("3J", "5J")   # Mini-Charts dafür aus Wochenwerten (spart Platz)
WOCHEN_PUNKTE = 270              # gut 5 Jahre Wochenschlusskurse

logging.basicConfig(level=logging.INFO, format="%(levelname)-7s %(message)s")
log = logging.getLogger("boerse")
# yfinance ist sehr gesprächig – nur echte Fehler anzeigen
logging.getLogger("yfinance").setLevel(logging.CRITICAL)

# Kategorie-Namen für Texte
KATEGORIE_TEXT = {
    "index": "Index", "aktie": "Aktie", "etf": "ETF",
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
        df = yf.download(symbole, period="6y", interval="1d", group_by="ticker",
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
                df = yf.Ticker(symbol).history(period="6y", interval="1d", auto_adjust=False)
            else:
                df = yf.download(symbol, period="6y", interval="1d", auto_adjust=False,
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
        for z in zeilen[1:][-1900:]:
            teile = z.split(",")
            punkte.append((teile[0], float(teile[4])))   # Datum, Schlusskurs
        return punkte if len(punkte) >= 2 else None
    except Exception:  # noqa: BLE001
        return None


def frankfurter(basis: str, ziel: str) -> list[tuple[str, float]] | None:
    """Ersatzquelle für Devisen: offizielle EZB-Referenzkurse."""
    start = (date.today() - timedelta(days=400)).isoformat()
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
            try:   # Verlauf des letzten Jahres (eine Anfrage pro Coin)
                time.sleep(1.5)  # freundlich zum Gratis-Limit
                chart = http_get(
                    f"https://api.coingecko.com/api/v3/coins/{m['id']}/market_chart",
                    params={"vs_currency": "usd", "days": "400", "interval": "daily"},
                    headers={"Accept": "application/json"}, versuche=2,
                ).json()
                verlauf = []
                for ms, wert in chart["prices"]:
                    tag = datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%d")
                    if verlauf and verlauf[-1][0] == tag:
                        verlauf[-1] = (tag, float(wert))   # pro Tag nur ein Wert
                    else:
                        verlauf.append((tag, float(wert)))
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


def wochenwerte(punkte: list[tuple[str, float]]) -> list[tuple[str, float]]:
    """Reduziert Tageskurse auf einen Wert pro Woche (letzter Kurs der Woche)."""
    wochen: dict[tuple[int, int], tuple[str, float]] = {}
    for tag, wert in punkte:
        jahr, woche, _ = date.fromisoformat(tag).isocalendar()
        wochen[(jahr, woche)] = (tag, wert)
    return [wochen[k] for k in sorted(wochen)]


def zeitraeume(punkte: list[tuple[str, float]], wochen: list[tuple[str, float]]) -> tuple[dict, dict, dict]:
    """Berechnet die Veränderung in % für 1W, 1M, 3M, YTD, 1J, 3J, 5J.

    Rückgabe:
      perf   = {"1W": 1.2, "1M": -3.4, ...}  Veränderung in Prozent
      tage   = {"1W": 6, "1M": 22, ...}      wie viele der letzten Tageswerte zum
                                             Zeitraum gehören (für die Mini-Charts)
      tage_w = {"3J": 157, "5J": 261}        dasselbe für die Wochenwerte
    Ist die Kursreihe zu kurz, fehlt der Zeitraum einfach.
    """
    letzter_tag = date.fromisoformat(punkte[-1][0])
    stichtage = {k: letzter_tag - timedelta(days=v) for k, v in ZEITRAEUME.items()}
    stichtage["YTD"] = date(letzter_tag.year - 1, 12, 31)     # Jahresschluss Vorjahr
    perf, tage, tage_w = {}, {}, {}

    def index_vor(reihe, stichtag):
        """Position des letzten Kurses am oder vor dem Stichtag."""
        return next((i for i in range(len(reihe) - 1, -1, -1)
                     if date.fromisoformat(reihe[i][0]) <= stichtag), None)

    for kuerzel, stichtag in stichtage.items():
        idx = index_vor(punkte, stichtag)
        if idx is None or punkte[idx][1] == 0:
            continue
        perf[kuerzel] = round((punkte[-1][1] / punkte[idx][1] - 1) * 100, 3)
        if kuerzel in LANGE_ZEITRAEUME:
            iw = index_vor(wochen, stichtag)
            if iw is not None:
                tage_w[kuerzel] = min(len(wochen) - iw, WOCHEN_PUNKTE)
        else:
            tage[kuerzel] = min(len(punkte) - idx, VERLAUF_PUNKTE)
    return perf, tage, tage_w


def eintrag_aus_serie(item: dict, kategorie: str, punkte: list[tuple[str, float]],
                      quelle: str) -> dict:
    """Baut aus einer Kursreihe einen Eintrag mit Stand, Veränderung und Verlauf."""
    werte = [v for _, v in punkte]
    kurs, vortag = werte[-1], werte[-2]
    diff = kurs - vortag
    wochen = wochenwerte(punkte)
    perf, tage, tage_w = zeitraeume(punkte, wochen)
    return {
        **basis_eintrag(item, kategorie),
        "kurs": runden(kurs),
        "vortag": runden(vortag),
        "diff": runden(diff),
        "diff_pct": round(diff / vortag * 100, 3) if vortag else 0.0,
        "datum": punkte[-1][0],
        "verlauf": [runden(v) for v in werte[-VERLAUF_PUNKTE:]],
        "verlauf_w": [runden(v) for _, v in wochen[-WOCHEN_PUNKTE:]],
        "perf": perf,
        "tage": tage,
        "tage_w": tage_w,
        "quelle": quelle,
        "stand": jetzt_utc().isoformat(timespec="seconds"),
        "veraltet": False,
    }


# Land anhand der Symbol-Endung erkennen (ohne Endung = USA)
LAND_ENDUNG = {".SW": "CH", ".DE": "DE", ".F": "DE", ".T": "JP", ".L": "UK", ".PA": "FR",
               ".AS": "NL", ".MI": "IT", ".HK": "HK", ".TO": "CA"}


def land_von(symbol: str) -> str:
    for endung, land in LAND_ENDUNG.items():
        if symbol.upper().endswith(endung):
            return land
    return "US"


def aktien_liste(cfg: dict) -> list[dict]:
    """Macht aus der Sektor-Liste in config.yaml eine flache Liste (mit Sektor und Land)."""
    liste = []
    for sektor, titel in (cfg.get("aktien") or {}).items():
        for item in titel or []:
            liste.append({**item, "sektor": sektor, "land": land_von(item["symbol"])})
    return liste


def eindeutig(liste: list[dict]) -> list[dict]:
    """Jedes Symbol nur einmal (eine Aktie kann in mehreren Sektoren stehen)."""
    gesehen, ergebnis = set(), []
    for e in liste:
        if e["symbol"] not in gesehen:
            gesehen.add(e["symbol"])
            ergebnis.append(e)
    return ergebnis


def loese_isin(item: dict) -> dict:
    """Sucht zu einer ISIN das Yahoo-Symbol (bevorzugt an den Börsen aus config.yaml)."""
    if item.get("symbol"):
        return item
    isin = item.get("isin", "")
    try:
        import yfinance as yf
        treffer = [q.get("symbol") for q in (yf.Search(isin, max_results=15).quotes or []) if q.get("symbol")]
        log.info("  ISIN %s -> gefunden: %s", isin, ", ".join(treffer) or "nichts")
        for endung in item.get("boerse", []):
            for sym in treffer:
                if sym.upper().endswith(endung.upper()):
                    print(f"::notice::ISIN {isin} = Symbol {sym} (kann in config.yaml als symbol eingetragen werden)")
                    return {**item, "symbol": sym}
        if treffer:
            return {**item, "symbol": treffer[0]}
    except Exception as e:  # noqa: BLE001
        log.warning("  ISIN-Suche für %s fehlgeschlagen: %s", isin, e)
    return {**item, "symbol": isin}      # nicht gefunden -> erscheint als "keine Daten"


def offizieller_name(item: dict) -> dict:
    """Holt bei Yahoo den offiziellen Produktnamen, wenn in config.yaml name: "auto" steht."""
    if item.get("name") not in (None, "", "auto"):
        return item
    try:
        import yfinance as yf
        info = yf.Ticker(item["symbol"]).info or {}
        name = info.get("longName") or info.get("shortName")
        if name:
            log.info("  Name für %s: %s", item["symbol"], name)
            return {**item, "name": name}
    except Exception as e:  # noqa: BLE001
        log.info("  Name für %s nicht gefunden: %s", item.get("symbol"), e)
    return {**item, "name": item.get("isin") or item["symbol"]}


def basis_eintrag(item: dict, kategorie: str) -> dict:
    e = {"symbol": item["symbol"], "name": item["name"], "kategorie": kategorie}
    for feld in ("region", "einheit", "sektor", "land", "isin"):
        if feld in item:
            e[feld] = item[feld]
    return e


def ersatz_aus_vorherigem(item: dict, kategorie: str, vorher: dict) -> dict:
    """Letzten bekannten Wert übernehmen (oder leeren Eintrag, falls es keinen gibt)."""
    alt = vorher.get(f"{kategorie}:{item['symbol']}")
    if alt and alt.get("kurs") is not None and alt.get("quelle") != "Beispieldaten":
        e = dict(alt)
        e.update(basis_eintrag(item, kategorie))   # Sektor/Land aus der aktuellen config
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
        ("aktien", "aktie", aktien_liste(cfg)),
        ("etfs", "etf", [offizieller_name(loese_isin(i)) for i in cfg.get("etfs", []) or []]),
        ("rohstoffe", "rohstoff", cfg.get("rohstoffe", [])),
        ("devisen", "devisen", cfg.get("devisen", [])),
        ("weitere", "weitere", cfg.get("weitere", [])),
        ("sektoren_us", "sektor", cfg.get("sektoren_us", [])),
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
        reihe_yahoo = reihen.get(item["symbol"])
        if d and (d["verlauf"] or reihe_yahoo):
            # Verlauf von CoinGecko (sonst Yahoo), aktueller Kurs + 24h-Veränderung von CoinGecko
            # Yahoo hat die längere Historie (bis 5 Jahre); CoinGecko nur als Ersatz
            reihe = reihe_yahoo if reihe_yahoo and len(reihe_yahoo) > 400 else (d["verlauf"] or reihe_yahoo)
            e = eintrag_aus_serie(item, "krypto", reihe, "CoinGecko")
            e.update({"kurs": runden(d["kurs"]), "diff": runden(d["diff"]),
                      "diff_pct": round(d["diff_pct"], 3), "zeitraum": "24 Std."})
        elif reihe_yahoo:
            e = eintrag_aus_serie(item, "krypto", reihe_yahoo, "Yahoo Finance")
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
    aktien_namen = {item["name"] for item in aktien_liste(cfg)}
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
                                "zeit": zeit, "bonus": float(feed.get("bonus", 0)),
                                "region": feed.get("region", "INT")})
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

    news = [{"titel": a["titel"], "link": a["link"], "quelle": a["quelle"], "region": a["region"],
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


def ff_termine(url: str, kcfg: dict, tz, heute: date) -> list[dict]:
    """Konjunkturtermine aus dem ForexFactory-Wochenkalender (gratis JSON)."""
    daten = http_get(url, timeout=20, versuche=2).json()
    waehrungen = set(kcfg.get("waehrungen", ["CHF", "USD", "EUR"]))
    wichtig = set(kcfg.get("wichtigkeit", ["High"]))
    termine = []
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
    return termine


def verfallstage(heute: date, bis: date) -> list[dict]:
    """Optionsverfall: jeder 3. Freitag im Monat; März/Juni/Sept./Dez. = grosser Verfall."""
    termine = []
    jahr, monat = heute.year, heute.month
    while date(jahr, monat, 1) <= bis:
        erster = date(jahr, monat, 1)
        freitag = erster + timedelta(days=(4 - erster.weekday()) % 7 + 14)   # 3. Freitag
        if heute <= freitag <= bis:
            gross = monat in (3, 6, 9, 12)
            termine.append({"datum": freitag.isoformat(), "zeit": None,
                            "titel": "Grosser Verfall (Hexensabbat)" if gross else "Optionsverfall",
                            "land": "", "wichtigkeit": "mittel" if gross else "tief", "typ": "verfall"})
        monat += 1
        if monat > 12:
            jahr, monat = jahr + 1, 1
    return termine


def termine_aus_fundamentaldaten(fundamental: dict, heute: date, bis: date) -> list[dict]:
    """Quartalszahlen (mit Schätzungen) und Dividendentermine aller Aktien."""
    termine = []
    laender = {"CH": "Schweiz", "US": "USA"}
    for symbol, f in (fundamental.get("aktien") or {}).items():
        t = f.get("termine") or {}
        name, land = f.get("name", symbol), laender.get(f.get("land"), f.get("land", ""))
        if t.get("zahlen") and heute.isoformat() <= t["zahlen"] <= bis.isoformat():
            details = []
            if t.get("eps_schaetzung") is not None:
                details.append(f"Erwarteter Gewinn/Aktie {zahl_ch(t['eps_schaetzung'])} {f.get('bilanz_waehrung') or ''}".strip())
            if t.get("umsatz_schaetzung"):
                details.append(f"Umsatz ca. {zahl_ch(t['umsatz_schaetzung'] / 1e9, 1)} Mrd.")
            termine.append({"datum": t["zahlen"], "zeit": None, "titel": f"Quartalszahlen {name}",
                            "land": land, "wichtigkeit": "mittel", "typ": "zahlen", "symbol": symbol,
                            "prognose": " · ".join(details) or None})
        if t.get("ex_div") and heute.isoformat() <= t["ex_div"] <= bis.isoformat():
            betrag = f" ({zahl_ch(f['div_satz'])} {f.get('waehrung') or ''} pro Jahr)" if f.get("div_satz") else ""
            termine.append({"datum": t["ex_div"], "zeit": None, "titel": f"Ex-Dividende {name}{betrag}",
                            "land": land, "wichtigkeit": "tief", "typ": "dividende", "symbol": symbol})
        if t.get("div_zahltag") and heute.isoformat() <= t["div_zahltag"] <= bis.isoformat():
            termine.append({"datum": t["div_zahltag"], "zeit": None, "titel": f"Dividenden-Zahltag {name}",
                            "land": land, "wichtigkeit": "tief", "typ": "dividende", "symbol": symbol})
    return termine


def lade_kalender(cfg: dict, vorher: dict, quellen: dict, fundamental: dict) -> list[dict]:
    """Alle wichtigen Termine: Konjunktur, Notenbanken, Zahlen, Dividenden, Verfall, Feiertage."""
    kcfg = cfg.get("kalender", {})
    tz = ZoneInfo(cfg.get("zeitzone", "Europe/Zurich"))
    heute = datetime.now(tz).date()
    bis = heute + timedelta(days=kcfg.get("horizont_tage", 90))
    termine: list[dict] = []

    # --- a) Konjunkturdaten (diese + nächste Woche, ForexFactory) -------------
    ok_wochen = 0
    for url in ("https://nfs.faireconomy.media/ff_calendar_thisweek.json",
                "https://nfs.faireconomy.media/ff_calendar_nextweek.json"):
        try:
            termine.extend(ff_termine(url, kcfg, tz, heute))
            ok_wochen += 1
        except Exception as e:  # noqa: BLE001
            log.info("Wirtschaftskalender %s: %s", url.rsplit("_", 1)[-1], str(e)[:80])
    if ok_wochen:
        quellen["kalender"] = f"OK (ForexFactory, {ok_wochen} Woche(n))"
    else:
        quellen["kalender"] = "Fehler – zeige letzte bekannte Termine"
        termine.extend(t for t in vorher.get("kalender", [])
                       if t.get("typ") == "konjunktur" and t.get("datum", "") >= heute.isoformat())

    # --- b) eigene, fixe Termine aus config.yaml (Notenbanken, Events …) ------
    for t in kcfg.get("eigene_termine", []) or []:
        try:
            d = date.fromisoformat(str(t["datum"]))
        except Exception:  # noqa: BLE001
            continue
        if heute <= d <= bis:
            termine.append({"datum": d.isoformat(), "zeit": t.get("zeit"), "titel": t["titel"],
                            "land": t.get("land", ""), "wichtigkeit": t.get("wichtigkeit", "hoch"),
                            "typ": t.get("typ", "notenbank")})

    # --- c) Quartalszahlen + Dividenden aus den Fundamentaldaten --------------
    zahlen = termine_aus_fundamentaldaten(fundamental, heute, bis)
    termine.extend(zahlen)
    quellen["quartalszahlen"] = f"OK ({sum(t['typ'] == 'zahlen' for t in zahlen)} Zahlen-Termine, " \
                                f"{sum(t['typ'] == 'dividende' for t in zahlen)} Dividenden-Termine)"

    # --- d) Optionsverfall und Börsenfeiertage --------------------------------
    termine.extend(verfallstage(heute, bis))
    for b in cfg.get("boersen", []):
        for tag in b.get("feiertage", []):
            if heute.isoformat() <= tag <= bis.isoformat():
                termine.append({"datum": tag, "zeit": None, "titel": f"Börse geschlossen: {b['name']}",
                                "land": b.get("region", ""), "wichtigkeit": "tief", "typ": "feiertag"})

    termine.sort(key=lambda t: (t["datum"], t.get("zeit") or "99:99", t["titel"]))
    return termine


# ===========================================================================
# 3a) FUNDAMENTALDATEN (KGV, Gewinne, Margen, Dividende, Analysten …)
# ===========================================================================
def zahl_oder_none(v, faktor: float = 1.0, stellen: int = 2):
    """Wandelt Yahoo-Werte sicher in Zahlen um (NaN/Text -> None)."""
    try:
        if v is None:
            return None
        f = float(v) * faktor
        if f != f or f in (float("inf"), float("-inf")):   # NaN / unendlich
            return None
        return round(f, stellen)
    except Exception:  # noqa: BLE001
        return None


def zeile_aus_tabelle(df, namen: list[str]) -> dict[str, float]:
    """Holt aus einer Yahoo-Finanztabelle (z.B. Erfolgsrechnung) eine Zeile als {Jahr: Wert}."""
    if df is None or getattr(df, "empty", True):
        return {}
    for name in namen:
        if name in df.index:
            werte = {}
            for spalte, wert in df.loc[name].items():
                w = zahl_oder_none(wert, stellen=4)
                if w is not None:
                    werte[str(getattr(spalte, "year", spalte))] = w
            if werte:
                return werte
    return {}


def datum_text(v) -> str | None:
    """Datum aus Yahoo (Zeitstempel, date oder Text) -> 'JJJJ-MM-TT'."""
    try:
        if v is None:
            return None
        if isinstance(v, (int, float)):
            return datetime.fromtimestamp(v, timezone.utc).strftime("%Y-%m-%d")
        if isinstance(v, (date, datetime)):
            return v.strftime("%Y-%m-%d")
        return str(v)[:10]
    except Exception:  # noqa: BLE001
        return None


def fundamental_eine_aktie(symbol: str) -> dict:
    """Alle Kennzahlen zu einer Aktie (4 Anfragen bei Yahoo)."""
    import yfinance as yf
    t = yf.Ticker(symbol)
    info = t.info or {}
    if not info or len(info) < 5:
        raise ValueError("keine Daten")
    kurs = info.get("currentPrice") or info.get("regularMarketPrice") or info.get("previousClose")
    div_satz = info.get("dividendRate") or info.get("trailingAnnualDividendRate")
    k = {
        "waehrung": info.get("currency"),
        "bilanz_waehrung": info.get("financialCurrency"),
        "kurs": zahl_oder_none(kurs),
        "marktkap": zahl_oder_none(info.get("marketCap"), stellen=0),
        "kgv": zahl_oder_none(info.get("trailingPE")),
        "kgv_fwd": zahl_oder_none(info.get("forwardPE")),
        "peg": zahl_oder_none(info.get("trailingPegRatio") or info.get("pegRatio")),
        "kbv": zahl_oder_none(info.get("priceToBook")),
        "kuv": zahl_oder_none(info.get("priceToSalesTrailing12Months")),
        "ev_ebitda": zahl_oder_none(info.get("enterpriseToEbitda")),
        "eps": zahl_oder_none(info.get("trailingEps")),
        "eps_fwd": zahl_oder_none(info.get("forwardEps")),
        "div_satz": zahl_oder_none(div_satz),
        "div_rendite": zahl_oder_none(div_satz / kurs * 100) if div_satz and kurs else None,
        "ausschuettung": zahl_oder_none(info.get("payoutRatio"), 100, 1),
        "marge_brutto": zahl_oder_none(info.get("grossMargins"), 100, 1),
        "marge_op": zahl_oder_none(info.get("operatingMargins"), 100, 1),
        "marge_netto": zahl_oder_none(info.get("profitMargins"), 100, 1),
        "roe": zahl_oder_none(info.get("returnOnEquity"), 100, 1),
        "roa": zahl_oder_none(info.get("returnOnAssets"), 100, 1),
        "verschuldung": zahl_oder_none(info.get("debtToEquity"), stellen=1),
        "liquiditaet": zahl_oder_none(info.get("currentRatio")),
        "umsatz_wachstum": zahl_oder_none(info.get("revenueGrowth"), 100, 1),
        "gewinn_wachstum": zahl_oder_none(info.get("earningsGrowth"), 100, 1),
        "beta": zahl_oder_none(info.get("beta")),
        "hoch52": zahl_oder_none(info.get("fiftyTwoWeekHigh")),
        "tief52": zahl_oder_none(info.get("fiftyTwoWeekLow")),
        "kursziel": zahl_oder_none(info.get("targetMeanPrice")),
        "kursziel_hoch": zahl_oder_none(info.get("targetHighPrice")),
        "kursziel_tief": zahl_oder_none(info.get("targetLowPrice")),
        "empfehlung": info.get("recommendationKey"),
        "analysten": info.get("numberOfAnalystOpinions"),
        "umsatz": zahl_oder_none(info.get("totalRevenue"), stellen=0),
        "gewinn": zahl_oder_none(info.get("netIncomeToCommon"), stellen=0),
        "fcf": zahl_oder_none(info.get("freeCashflow"), stellen=0),
        "mitarbeiter": info.get("fullTimeEmployees"),
        "branche": info.get("industry"),
        "sitz": info.get("country"),
        "website": info.get("website"),
        "ex_div": datum_text(info.get("exDividendDate")),
    }
    # Erfolgsrechnung + Geldflussrechnung (Jahreswerte, meist 4 Jahre)
    jahre = {}
    try:
        er = t.income_stmt
        for feld, namen in (("umsatz", ["Total Revenue", "Operating Revenue"]),
                            ("ebit", ["Operating Income", "EBIT"]),
                            ("gewinn", ["Net Income Common Stockholders", "Net Income"]),
                            ("eps", ["Diluted EPS", "Basic EPS"])):
            for jahr, wert in zeile_aus_tabelle(er, namen).items():
                jahre.setdefault(jahr, {})[feld] = wert
    except Exception:  # noqa: BLE001
        pass
    try:
        for jahr, wert in zeile_aus_tabelle(t.cashflow, ["Free Cash Flow"]).items():
            jahre.setdefault(jahr, {})["fcf"] = wert
    except Exception:  # noqa: BLE001
        pass
    k["jahre"] = [{"jahr": j, **jahre[j]} for j in sorted(jahre)][-5:]
    # Termine (nächste Zahlen inkl. Schätzungen, Dividende)
    termine = {}
    try:
        kal = t.calendar or {}
        ed = kal.get("Earnings Date") or []
        ed = ed if isinstance(ed, list) else [ed]
        termine = {
            "zahlen": datum_text(ed[0]) if ed else None,
            "eps_schaetzung": zahl_oder_none(kal.get("Earnings Average")),
            "umsatz_schaetzung": zahl_oder_none(kal.get("Revenue Average"), stellen=0),
            "ex_div": datum_text(kal.get("Ex-Dividend Date")) or k["ex_div"],
            "div_zahltag": datum_text(kal.get("Dividend Date")),
        }
    except Exception:  # noqa: BLE001
        termine = {"ex_div": k["ex_div"]}
    k["termine"] = termine
    beschreibung = (info.get("longBusinessSummary") or "").strip()
    if len(beschreibung) > 700:
        beschreibung = beschreibung[:700].rsplit(". ", 1)[0] + "."
    k["beschreibung_en"] = beschreibung or None
    return k


def lade_steckbriefe() -> dict:
    """Deutsche Kurzporträts aus steckbriefe.yaml (von Hand gepflegt)."""
    try:
        with open(STECKBRIEF_DATEI, encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    except Exception as e:  # noqa: BLE001
        log.warning("steckbriefe.yaml nicht lesbar: %s", e)
        return {}


def lade_fundamentaldaten(cfg: dict, pfad: Path, erzwingen: bool = False) -> dict:
    """Holt die Fundamentaldaten aller Aktien – höchstens einmal pro Tag.

    Fällt eine Aktie aus, bleibt ihr letzter bekannter Stand erhalten.
    """
    alt = lade_json(pfad)
    steckbriefe = lade_steckbriefe()
    aktien = eindeutig(aktien_liste(cfg))
    alter_std = 999.0
    if alt.get("erstellt"):
        try:
            alter_std = (jetzt_utc() - datetime.fromisoformat(alt["erstellt"])).total_seconds() / 3600
        except Exception:  # noqa: BLE001
            pass
    fehlend = [a for a in aktien if a["symbol"] not in (alt.get("aktien") or {})]
    if not erzwingen and alter_std < FUNDAMENTAL_MAX_ALTER_STD and not fehlend:
        log.info("Fundamentaldaten sind aktuell (%.1f Std. alt) – kein Neuladen nötig", alter_std)
        daten = alt
        zu_holen = []
    else:
        daten = {"aktien": dict(alt.get("aktien") or {})}
        # Alles neu holen, wenn veraltet – sonst nur neu hinzugekommene Aktien
        zu_holen = aktien if (erzwingen or alter_std >= FUNDAMENTAL_MAX_ALTER_STD) else fehlend
        log.info("Hole Fundamentaldaten für %d Aktien …", len(zu_holen))

    def eine(item):
        for versuch in range(2):
            try:
                return item, fundamental_eine_aktie(item["symbol"]), None
            except Exception as e:  # noqa: BLE001
                fehler = str(e)[:100]
                time.sleep(3 * (versuch + 1))
        return item, None, fehler

    ok_anzahl = 0
    with ThreadPoolExecutor(max_workers=4) as pool:
        for item, k, fehler in pool.map(eine, zu_holen):
            if k:
                k["stand"] = jetzt_utc().isoformat(timespec="seconds")
                daten["aktien"][item["symbol"]] = k
                ok_anzahl += 1
            else:
                log.info("  Fundamentaldaten %s fehlgeschlagen: %s", item["symbol"], fehler)
                if item["symbol"] in daten["aktien"]:
                    daten["aktien"][item["symbol"]]["veraltet"] = True
    if zu_holen:
        daten["erstellt"] = jetzt_utc().isoformat(timespec="seconds")
        log.info("  -> %d von %d erhalten", ok_anzahl, len(zu_holen))
        daten["status"] = f"{ok_anzahl} von {len(zu_holen)} beim letzten Abruf"

    # Name, Sektor, Land und deutsche Steckbriefe immer aus der aktuellen config
    for item in aktien:
        eintrag = daten["aktien"].setdefault(item["symbol"], {})
        eintrag.update({"name": item["name"], "sektor": item["sektor"], "land": item["land"]})
        if item["symbol"] in steckbriefe:
            eintrag["steckbrief"] = steckbriefe[item["symbol"]]
    # Aktien, die nicht mehr in der config stehen, entfernen
    gueltig = {a["symbol"] for a in aktien}
    daten["aktien"] = {s: v for s, v in daten["aktien"].items() if s in gueltig}
    return daten


# ===========================================================================
# 3b) STIMMUNG: Fear & Greed Index (Angst & Gier)
# ===========================================================================
def stimmung_text(wert: float) -> str:
    """0–100 in Worte fassen (gleiche Grenzen wie CNN)."""
    if wert < 25:
        return "Extreme Angst"
    if wert < 45:
        return "Angst"
    if wert <= 55:
        return "Neutral"
    if wert < 75:
        return "Gier"
    return "Extreme Gier"


def stimmung_eintrag(wert, vortag, woche, monat, jahr, verlauf, quelle) -> dict:
    return {
        "wert": round(float(wert), 1), "text": stimmung_text(float(wert)),
        "vortag": None if vortag is None else round(float(vortag), 1),
        "woche": None if woche is None else round(float(woche), 1),
        "monat": None if monat is None else round(float(monat), 1),
        "jahr": None if jahr is None else round(float(jahr), 1),
        "verlauf": [round(float(v), 1) for v in verlauf][-365:],
        "quelle": quelle, "stand": jetzt_utc().isoformat(timespec="seconds"), "veraltet": False,
    }


def fear_greed_aktien() -> dict:
    """CNN Fear & Greed Index (US-Aktienmarkt). Inoffizielle, aber frei zugängliche Schnittstelle."""
    start = (date.today() - timedelta(days=370)).isoformat()
    daten = http_get(
        f"https://production.dataviz.cnn.io/index/fearandgreed/graphdata/{start}",
        headers={"Accept": "application/json", "Referer": "https://edition.cnn.com/",
                 "Origin": "https://edition.cnn.com"}, versuche=2,
    ).json()
    fg = daten["fear_and_greed"]
    verlauf = [p["y"] for p in daten.get("fear_and_greed_historical", {}).get("data", [])]
    return stimmung_eintrag(fg["score"], fg.get("previous_close"), fg.get("previous_1_week"),
                            fg.get("previous_1_month"), fg.get("previous_1_year"), verlauf, "CNN")


def fear_greed_krypto() -> dict:
    """Crypto Fear & Greed Index von alternative.me (gratis, ohne Schlüssel)."""
    daten = http_get("https://api.alternative.me/fng/?limit=400", versuche=2).json()["data"]
    werte = [float(d["value"]) for d in daten]           # neuester Wert zuerst

    def vor(tage):
        return werte[tage] if len(werte) > tage else None
    return stimmung_eintrag(werte[0], vor(1), vor(7), vor(30), vor(365),
                            list(reversed(werte)), "alternative.me")


def lade_stimmung(vorher: dict, quellen: dict) -> dict:
    ergebnis = {}
    for schluessel, funktion in (("aktien", fear_greed_aktien), ("krypto", fear_greed_krypto)):
        try:
            ergebnis[schluessel] = funktion()
            quellen[f"fear_greed_{schluessel}"] = f"OK ({ergebnis[schluessel]['quelle']})"
        except Exception as e:  # noqa: BLE001
            log.warning("Fear & Greed (%s) nicht erreichbar: %s", schluessel, e)
            quellen[f"fear_greed_{schluessel}"] = f"Fehler: {str(e)[:80]}"
            alt = (vorher.get("stimmung") or {}).get(schluessel)
            if alt:
                ergebnis[schluessel] = {**alt, "veraltet": True}
    return ergebnis


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
    frisch = [a for a in eindeutig(k["aktien"]) if ok(a) and not a.get("veraltet")]
    ch = sorted([a for a in frisch if a.get("land") == "CH"], key=lambda a: a["diff_pct"])
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
    us = sorted([a for a in frisch if a.get("land") == "US"], key=lambda a: a["diff_pct"])
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
    regeln = [("indizes", s.get("index", 2)), ("aktien", s.get("aktie", 5)),
              ("etfs", s.get("index", 2)), ("krypto", s.get("krypto", 5)),
              ("rohstoffe", s.get("rohstoff", 3)), ("devisen", s.get("devisen", 1)),
              ("weitere", s.get("weitere", 10))]
    sektor_schwellen = s.get("sektoren") or {}
    hinweise = []
    for gruppe, standard in regeln:
        for e in eindeutig(k.get(gruppe, [])):
            # Schwankungsfreudige Sektoren (z.B. Bitcoin, Quanten) haben eigene Schwellen
            schwelle = sektor_schwellen.get(e.get("sektor"), standard)
            if ok(e) and not e.get("veraltet") and abs(e["diff_pct"]) >= schwelle:
                hinweise.append({
                    "name": e["name"], "kategorie": KATEGORIE_TEXT.get(e["kategorie"], ""),
                    "diff_pct": e["diff_pct"], "schwelle": schwelle,
                    "text": f"{e['name']} {prozent_text(e['diff_pct'])} · "
                            f"{e.get('sektor') or KATEGORIE_TEXT.get(e['kategorie'], '')}",
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
    tage = [heute - timedelta(days=i) for i in range(1900, -1, -1) if (heute - timedelta(days=i)).weekday() < 5]

    def serie(sym, vol):
        v = BEISPIEL_KURSE.get(sym, rnd.uniform(40, 400))
        punkte = []
        for t in tage:
            v *= 1 + rnd.gauss(0.0004, vol)
            punkte.append((t.isoformat(), v))
        return punkte

    vol = {"index": 0.009, "aktie": 0.02, "etf": 0.009, "rohstoff": 0.015,
           "devisen": 0.004, "weitere": 0.05, "krypto": 0.03, "sektor": 0.011}
    erg = {}
    listen = {**cfg, "aktien": aktien_liste(cfg),
              "etfs": [{**i, "symbol": i.get("symbol") or i["isin"]} for i in cfg.get("etfs", []) or []]}
    for gruppe, kat in [("indizes", "index"), ("aktien", "aktie"), ("etfs", "etf"),
                        ("rohstoffe", "rohstoff"), ("devisen", "devisen"), ("weitere", "weitere"),
                        ("krypto", "krypto"), ("sektoren_us", "sektor")]:
        erg[gruppe] = [eintrag_aus_serie(i, kat, serie(i["symbol"], vol[kat]), "Beispieldaten")
                       for i in listen.get(gruppe, [])]
    # Ein paar grosse Bewegungen einbauen, damit "Auffälligkeiten" etwas zeigen
    for gruppe, idx, faktor in [("aktien", 2, 1.064), ("aktien", 40, 1.031), ("krypto", 0, 0.946)]:
        if len(erg[gruppe]) > idx:
            e = erg[gruppe][idx]
            e["kurs"] = runden(e["vortag"] * faktor)
            e["diff"] = runden(e["kurs"] - e["vortag"])
            e["diff_pct"] = round((faktor - 1) * 100, 3)
            e["verlauf"][-1] = e["kurs"]
            e["perf"] = {k: round(v + (faktor - 1) * 100, 3) for k, v in e["perf"].items()}
            e["verlauf_w"][-1] = e["kurs"]
    # Eine Position als "Quelle ausgefallen" markieren, um die Anzeige zu testen
    if erg["aktien"]:
        e = erg["aktien"][-1]
        e["veraltet"] = True
        e["hinweis"] = "Quelle nicht erreichbar – letzter bekannter Wert"
    return erg


def beispiel_fundamentaldaten(cfg: dict) -> dict:
    """Erfundene, aber plausible Kennzahlen – nur zum Testen der Anzeige."""
    rnd = random.Random(3)
    steckbriefe = lade_steckbriefe()
    aktien = {}
    for i, item in enumerate(eindeutig(aktien_liste(cfg))):
        umsatz = rnd.uniform(5e9, 300e9)
        jahre, gewinn = [], umsatz * rnd.uniform(0.03, 0.25)
        for j in range(2021, 2026):
            umsatz *= rnd.uniform(0.95, 1.15)
            gewinn *= rnd.uniform(0.8, 1.25)
            jahre.append({"jahr": str(j), "umsatz": umsatz, "gewinn": gewinn if i % 9 else -gewinn / 3,
                          "ebit": gewinn * 1.3, "eps": gewinn / 1e9, "fcf": gewinn * 0.9})
        kurs = rnd.uniform(20, 600)
        aktien[item["symbol"]] = {
            "name": item["name"], "sektor": item["sektor"], "land": item["land"],
            "waehrung": "CHF" if item["land"] == "CH" else "USD", "bilanz_waehrung": "USD", "kurs": kurs,
            "marktkap": rnd.uniform(5e9, 3e12), "kgv": rnd.choice([None, rnd.uniform(8, 60)]),
            "kgv_fwd": rnd.uniform(8, 40), "peg": rnd.uniform(0.5, 3), "kbv": rnd.uniform(0.8, 12),
            "kuv": rnd.uniform(0.5, 15), "ev_ebitda": rnd.uniform(6, 35), "eps": rnd.uniform(-2, 20),
            "eps_fwd": rnd.uniform(1, 22), "div_satz": kurs * 0.025, "div_rendite": rnd.uniform(0, 5),
            "ausschuettung": rnd.uniform(0, 110), "marge_brutto": rnd.uniform(20, 75),
            "marge_op": rnd.uniform(-5, 40), "marge_netto": rnd.uniform(-10, 35), "roe": rnd.uniform(-5, 45),
            "roa": rnd.uniform(1, 20), "verschuldung": rnd.uniform(10, 250), "liquiditaet": rnd.uniform(0.6, 3),
            "umsatz_wachstum": rnd.uniform(-10, 30), "gewinn_wachstum": rnd.uniform(-40, 60),
            "beta": rnd.uniform(0.4, 2.5), "hoch52": kurs * 1.25, "tief52": kurs * 0.7,
            "kursziel": kurs * rnd.uniform(0.85, 1.35), "kursziel_hoch": kurs * 1.6, "kursziel_tief": kurs * 0.7,
            "empfehlung": rnd.choice(["strong_buy", "buy", "hold", "underperform"]), "analysten": rnd.randint(3, 45),
            "umsatz": umsatz, "gewinn": gewinn, "fcf": gewinn * 0.9, "mitarbeiter": rnd.randint(500, 300000),
            "branche": "Beispiel-Branche", "sitz": "Switzerland", "website": "https://example.com",
            "jahre": jahre,
            "termine": {"zahlen": (date.today() + timedelta(days=rnd.randint(1, 80))).isoformat(),
                        "eps_schaetzung": rnd.uniform(0.5, 5), "umsatz_schaetzung": umsatz / 4,
                        "ex_div": (date.today() + timedelta(days=rnd.randint(1, 90))).isoformat() if i % 3 == 0 else None},
            "beschreibung_en": "Example company description from Yahoo Finance (English).",
            "stand": jetzt_utc().isoformat(timespec="seconds"),
        }
        if item["symbol"] in steckbriefe:
            aktien[item["symbol"]]["steckbrief"] = steckbriefe[item["symbol"]]
    return {"erstellt": jetzt_utc().isoformat(timespec="seconds"), "status": "Beispieldaten", "aktien": aktien}


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
             "region": "CH" if q in ("NZZ Wirtschaft", "finews.ch", "SRF Wirtschaft", "cash.ch") else "INT",
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
    parser.add_argument("--fundamental", action="store_true", help="Fundamentaldaten sofort neu holen")
    args = parser.parse_args()

    with open(CONFIG_DATEI, encoding="utf-8") as f:
        cfg = yaml.safe_load(f)

    ausgabe = Path(args.ausgabe)
    fund_pfad = ausgabe.parent / "fundamentals.json"
    vorher_json = lade_json(ausgabe)
    if vorher_json.get("beispieldaten") and not args.beispieldaten:
        vorher_json = {}   # Beispieldaten nie als "letzten bekannten Wert" verwenden
    # Vorherige Werte nach "kategorie:symbol" ablegen (für die Ersatz-Logik)
    vorher_map = {}
    for gruppe in ("indizes", "aktien", "etfs", "krypto", "rohstoffe", "devisen", "weitere",
                   "sektoren_us"):
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
        fundamental = beispiel_fundamentaldaten(cfg)
        kalender = beispiel_kalender() + termine_aus_fundamentaldaten(
            fundamental, date.today(), date.today() + timedelta(days=90)) + verfallstage(
            date.today(), date.today() + timedelta(days=90))
        kalender.sort(key=lambda t: (t["datum"], t.get("zeit") or "99:99"))
        rnd = random.Random(7)
        stimmung = {
            "aktien": stimmung_eintrag(38, 41, 52, 61, 70, [rnd.uniform(20, 80) for _ in range(250)], "Beispieldaten"),
            "krypto": stimmung_eintrag(22, 25, 34, 55, 60, [rnd.uniform(10, 90) for _ in range(365)], "Beispieldaten"),
        }
        quellen["kalender"] = "Beispieldaten"
        statistik["Beispieldaten"] = sum(len(v) for v in kurse.values())
    else:
        kurse = lade_kurse(cfg, vorher_map, statistik)
        log.info("Lade News …")
        news, feed_status = lade_news(cfg, vorher_json)
        log.info("Lade Fundamentaldaten …")
        fundamental = lade_fundamentaldaten(cfg, fund_pfad, erzwingen=args.fundamental)
        quellen["fundamentaldaten"] = fundamental.get("status", "aus Zwischenspeicher")
        log.info("Lade Kalender …")
        kalender = lade_kalender(cfg, vorher_json, quellen, fundamental)
        log.info("Lade Fear & Greed …")
        stimmung = lade_stimmung(vorher_json, quellen)

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
        "stimmung": stimmung,
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
        json.dump(daten, f, ensure_ascii=False, separators=(",", ":"))  # kompakt = schneller
    os.replace(tmp, ausgabe)
    # Fundamentaldaten in eigene Datei (wird von der App erst bei Bedarf geladen)
    tmp_f = fund_pfad.with_suffix(".tmp")
    with open(tmp_f, "w", encoding="utf-8") as f:
        json.dump(fundamental, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp_f, fund_pfad)

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
