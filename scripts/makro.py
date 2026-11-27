# -*- coding: utf-8 -*-
"""
Makro-Daten: Zinsen, Zinskurve, Inflation, Arbeitslosigkeit, Wachstum, Saisonalität
===================================================================================

Quellen (alle gratis, ohne Schlüssel, offizielle Stellen):
  - SNB-Datenportal (data.snb.ch): SNB-Leitzins, Schweizer Renditen/Teuerung
  - EZB-Datenportal (data-api.ecb.europa.eu): EZB-Zins, Inflation, Arbeitslosigkeit, Renditen
  - New York Fed (markets.newyorkfed.org): US-Leitzins (Effective Fed Funds Rate)
  - US Bureau of Labor Statistics (api.bls.gov): US-Inflation, US-Arbeitslosigkeit
  - Yahoo Finance: US-Staatsanleihen-Renditen (Zinskurve), lange Monatsreihen (Saisonalität)
  - FRED (St. Louis Fed): nur als Ersatz – von GitHub aus oft nicht erreichbar

Für jede Grösse sind mehrere Quellen hinterlegt – die erste, die funktioniert,
wird genommen. Fällt alles aus, bleibt der letzte bekannte Stand.
"""
from __future__ import annotations

import csv
import io
import logging
from datetime import date, timedelta

import requests

log = logging.getLogger("boerse")
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15"}
JAHRE = 7
_fred_kaputt = False      # nach dem ersten Fehlschlag FRED nicht mehr versuchen (spart Minuten)


def _start() -> str:
    return (date.today() - timedelta(days=365 * JAHRE)).isoformat()


# --------------------------------------------------------------------------
# Einzelne Quellen
# --------------------------------------------------------------------------
def ezb(serie: str) -> list[tuple[str, float]]:
    """EZB-Datenportal, z.B. 'FM/D.U2.EUR.4F.KR.DFR.LEV' (Einlagesatz)."""
    fluss, schluessel = serie.split("/", 1)
    url = (f"https://data-api.ecb.europa.eu/service/data/{fluss}/{schluessel}"
           f"?format=csvdata&startPeriod={_start()[:7]}")
    r = requests.get(url, headers=UA, timeout=30)
    r.raise_for_status()
    punkte = []
    for z in csv.DictReader(io.StringIO(r.text)):
        try:
            tag = z["TIME_PERIOD"]
            tag = tag + "-01" if len(tag) == 7 else tag              # Monatswerte -> Monatsanfang
            if len(tag) == 7 + 3 and "Q" in tag:                      # Quartal "2025-Q3"
                jahr, q = tag.split("-Q")
                tag = f"{jahr}-{int(q) * 3 - 2:02d}-01"
            punkte.append((tag, float(z["OBS_VALUE"])))
        except (KeyError, ValueError):
            pass
    if len(punkte) < 2:
        raise ValueError("zu wenige Werte")
    return sorted(punkte)


def nyfed_effr() -> list[tuple[str, float]]:
    """Effektiver US-Leitzins (Fed Funds) von der New York Fed."""
    r = requests.get("https://markets.newyorkfed.org/api/rates/unsecured/effr/last/1800.json", headers=UA, timeout=30)
    r.raise_for_status()
    punkte = [(x["effectiveDate"], float(x["percentRate"])) for x in r.json().get("refRates", [])]
    if len(punkte) < 2:
        raise ValueError("zu wenige Werte")
    return sorted(punkte)


def bls(serie: str) -> list[tuple[str, float]]:
    """US-Statistikamt (BLS), z.B. CUUR0000SA0 (Konsumentenpreise), LNS14000000 (Arbeitslosenquote)."""
    jahr = date.today().year
    r = requests.post("https://api.bls.gov/publicAPI/v1/timeseries/data/",
                      json={"seriesid": [serie], "startyear": str(jahr - 8), "endyear": str(jahr)},
                      headers=UA, timeout=30)
    r.raise_for_status()
    daten = r.json()
    if daten.get("status") != "REQUEST_SUCCEEDED":
        raise ValueError(str(daten.get("message"))[:80])
    punkte = []
    for x in daten["Results"]["series"][0]["data"]:
        if x["period"].startswith("M") and x["period"] != "M13":
            try:
                punkte.append((f"{x['year']}-{x['period'][1:]}-01", float(x["value"])))
            except ValueError:
                pass
    if len(punkte) < 2:
        raise ValueError("zu wenige Werte")
    return sorted(punkte)


def snb(wuerfel: str, dimension: str) -> list[tuple[str, float]]:
    """SNB-Datenportal: Würfel (z.B. 'snbgwdzid') und Wert der ersten Dimension (z.B. 'LZ')."""
    r = requests.get(f"https://data.snb.ch/api/cube/{wuerfel}/data/csv/de", headers=UA, timeout=30)
    r.raise_for_status()
    punkte, gefunden = [], set()
    for zeile in r.text.splitlines():
        teile = [t.strip().strip('"') for t in zeile.split(";")]
        if len(teile) < 3 or teile[-1] in ("", "Value"):
            continue
        dims = teile[1:-1]
        gefunden.add("/".join(dims))
        if dimension in dims or "/".join(dims) == dimension:
            try:
                tag = teile[0]
                tag = tag + "-01" if len(tag) == 7 else tag[:10]
                punkte.append((tag, float(teile[-1])))
            except ValueError:
                pass
    if len(punkte) < 2:
        raise ValueError(f"'{dimension}' nicht gefunden; vorhanden: {', '.join(sorted(gefunden))[:150]}")
    return sorted(p for p in punkte if p[0] >= _start())


def yahoo(symbol: str) -> list[tuple[str, float]]:
    """Wöchentliche Werte von Yahoo (z.B. ^TNX = Rendite 10-jähriger US-Staatsanleihen)."""
    import yfinance as yf
    df = yf.Ticker(symbol).history(period=f"{JAHRE}y", interval="1wk", auto_adjust=False)
    punkte = [(i.strftime("%Y-%m-%d"), float(v)) for i, v in df["Close"].dropna().items()]
    if len(punkte) < 2:
        raise ValueError("keine Daten")
    return punkte


def fred(reihe: str) -> list[tuple[str, float]]:
    """FRED (nur Ersatz). Nach dem ersten Fehlschlag wird FRED für diesen Lauf übersprungen."""
    global _fred_kaputt
    if _fred_kaputt:
        raise ValueError("FRED nicht erreichbar (übersprungen)")
    try:
        r = requests.get(f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={reihe}&cosd={_start()}",
                         headers=UA, timeout=10)
        r.raise_for_status()
    except Exception:
        _fred_kaputt = True
        raise
    punkte = []
    for zeile in r.text.strip().splitlines()[1:]:
        t = zeile.split(",")
        if len(t) >= 2 and t[1] not in ("", "."):
            punkte.append((t[0], float(t[1])))
    if len(punkte) < 2:
        raise ValueError("zu wenige Werte")
    return punkte


# --------------------------------------------------------------------------
# Was angezeigt wird: Kennzahl -> Liste von (Quelle, Parameter, Umrechnung)
#   "yoy" = Veränderung zum Vorjahr in Prozent berechnen
# --------------------------------------------------------------------------
REIHEN = {
    "leitzins_snb": {"name": "SNB (Schweiz)", "einheit": "%", "kandidaten": [(snb, ("snbgwdzid", "LZ"), "wert")]},
    "leitzins_ezb": {"name": "EZB (Einlagesatz)", "einheit": "%", "kandidaten": [(ezb, ("FM/D.U2.EUR.4F.KR.DFR.LEV",), "wert"), (fred, ("ECBDFR",), "wert")]},
    "leitzins_fed": {"name": "Fed (USA)", "einheit": "%", "kandidaten": [(nyfed_effr, (), "wert"), (fred, ("DFEDTARU",), "wert")]},
    "rendite_ch10": {"name": "Schweiz 10 Jahre", "einheit": "%", "kandidaten": [(snb, ("rendoblim", "10J"), "wert"), (fred, ("IRLTLT01CHM156N",), "wert")]},
    "rendite_ez10": {"name": "Eurozone (AAA) 10 Jahre", "einheit": "%", "kandidaten": [(ezb, ("YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y",), "wert")]},
    "rendite_us10": {"name": "USA 10 Jahre", "einheit": "%", "kandidaten": [(yahoo, ("^TNX",), "wert"), (fred, ("DGS10",), "wert")]},
    "inflation_ch": {"name": "Schweiz", "einheit": "%", "kandidaten": [(snb, ("plkopr", "VVP"), "wert"), (fred, ("CPALTT01CHM659N",), "wert")]},
    "inflation_ez": {"name": "Eurozone", "einheit": "%", "kandidaten": [(ezb, ("ICP/M.U2.N.000000.4.ANR",), "wert"), (fred, ("CP0000EZ19M086NEST",), "yoy")]},
    "inflation_us": {"name": "USA", "einheit": "%", "kandidaten": [(bls, ("CUUR0000SA0",), "yoy"), (fred, ("CPIAUCSL",), "yoy")]},
    "arbeitslos_ez": {"name": "Eurozone", "einheit": "%", "kandidaten": [(ezb, ("LFSI/M.I9.S.UNEHRT.TOTAL0.15_74.T",), "wert"), (fred, ("LRHUTTTTEZM156S",), "wert")]},
    "arbeitslos_us": {"name": "USA", "einheit": "%", "kandidaten": [(bls, ("LNS14000000",), "wert"), (fred, ("UNRATE",), "wert")]},
    "arbeitslos_ch": {"name": "Schweiz", "einheit": "%", "kandidaten": [(fred, ("LRUNTTTTCHQ156S",), "wert")]},
    "bip_ez": {"name": "Eurozone", "einheit": "% ggü. Vorjahr", "kandidaten": [(ezb, ("MNA/Q.Y.I9.W2.S1.S1.B.B1GQ._Z._Z._Z.EUR.LR.GY",), "wert"), (fred, ("CLVMNACSCAB1GQEA19",), "yoy")]},
    "bip_ch": {"name": "Schweiz", "einheit": "% ggü. Vorjahr", "kandidaten": [(fred, ("CLVMNACSAB1GQCH",), "yoy")]},
    "bip_us": {"name": "USA", "einheit": "% ggü. Vorjahr", "kandidaten": [(fred, ("GDPC1",), "yoy")]},
}

# US-Zinskurve aus Yahoo (Rendite in %): Laufzeit -> Symbol
ZINSKURVE = [("3M", "^IRX"), ("5J", "^FVX"), ("10J", "^TNX"), ("30J", "^TYX")]


def _vorjahr(punkte: list[tuple[str, float]]) -> list[tuple[str, float]]:
    """Veränderung zum gleichen Monat im Vorjahr in Prozent."""
    werte = {p[0][:7]: p[1] for p in punkte}
    ergebnis = []
    for tag, wert in punkte:
        vj = f"{int(tag[:4]) - 1}{tag[4:7]}"
        if vj in werte and werte[vj]:
            ergebnis.append((tag, round((wert / werte[vj] - 1) * 100, 2)))
    return ergebnis


def _ausduennen(punkte: list[tuple[str, float]], max_punkte: int = 130) -> list[tuple[str, float]]:
    """Tägliche Reihen auf höchstens ~130 Punkte reduzieren (für kleine Charts)."""
    if len(punkte) <= max_punkte:
        return punkte
    schritt = len(punkte) / max_punkte
    auswahl = [punkte[int(i * schritt)] for i in range(max_punkte)]
    if auswahl[-1] != punkte[-1]:
        auswahl.append(punkte[-1])
    return auswahl


def lade_makro(alt: dict, quellen: dict) -> dict:
    ergebnis, ok, fehl = {"reihen": {}, "zinskurve": None}, 0, []
    alt_reihen = (alt or {}).get("reihen", {})
    grenze = (date.today() - timedelta(days=365 * 6)).isoformat()
    for schluessel, info in REIHEN.items():
        punkte, quelle = None, None
        for funktion, parameter, art in info["kandidaten"]:
            try:
                p = funktion(*parameter)
                p = _vorjahr(p) if art == "yoy" else p
                p = [x for x in p if x[0] >= grenze]
                if len(p) >= 2:
                    punkte, quelle = p, f"{funktion.__name__.upper()} {' '.join(parameter)}".strip()
                    break
            except Exception as e:  # noqa: BLE001
                log.info("  Makro %s via %s: %s", schluessel, funktion.__name__, str(e)[:160])
        if punkte:
            punkte = _ausduennen(punkte)
            ergebnis["reihen"][schluessel] = {
                "name": info["name"], "einheit": info["einheit"], "quelle": quelle,
                "daten": [p[0] for p in punkte], "werte": [round(p[1], 3) for p in punkte],
                "aktuell": round(punkte[-1][1], 2), "datum": punkte[-1][0],
            }
            ok += 1
        else:
            fehl.append(schluessel)
            if schluessel in alt_reihen:
                ergebnis["reihen"][schluessel] = {**alt_reihen[schluessel], "veraltet": True}

    # US-Zinskurve + Rezessions-Signal (10 Jahre minus 3 Monate)
    try:
        reihen = {laufzeit: yahoo(sym) for laufzeit, sym in ZINSKURVE}
        def wert_vor(p, tage):
            ziel = (date.fromisoformat(p[-1][0]) - timedelta(days=tage)).isoformat()
            k = [w for d, w in p if d <= ziel]
            return round(k[-1], 3) if k else None
        ergebnis["zinskurve"] = {
            "laufzeiten": [l for l, _ in ZINSKURVE],
            "heute": [round(reihen[l][-1][1], 3) for l, _ in ZINSKURVE],
            "monat": [wert_vor(reihen[l], 30) for l, _ in ZINSKURVE],
            "jahr": [wert_vor(reihen[l], 365) for l, _ in ZINSKURVE],
            "datum": reihen["10J"][-1][0],
        }
        kurz = dict(reihen["3M"])
        spread = [(d, round(w - kurz[d], 3)) for d, w in reihen["10J"] if d in kurz and d >= grenze]
        if len(spread) >= 2:
            spread = _ausduennen(spread)
            ergebnis["reihen"]["spread_10_3m"] = {
                "name": "US-Zinsdifferenz 10J − 3M", "einheit": "%-Pkt.", "quelle": "Yahoo ^TNX − ^IRX",
                "daten": [p[0] for p in spread], "werte": [p[1] for p in spread],
                "aktuell": spread[-1][1], "datum": spread[-1][0]}
            ok += 1
    except Exception as e:  # noqa: BLE001
        log.info("  Zinskurve: %s", e)
        ergebnis["zinskurve"] = (alt or {}).get("zinskurve")
        if "spread_10_3m" in alt_reihen:
            ergebnis["reihen"]["spread_10_3m"] = {**alt_reihen["spread_10_3m"], "veraltet": True}
    quellen["makro"] = f"OK ({ok} Reihen)" + (f", fehlend: {', '.join(fehl)}" if fehl else "")
    log.info("  Makro: %s", quellen["makro"])
    return ergebnis


def lade_saisonalitaet(alt: dict, quellen: dict) -> dict:
    """Durchschnittliche Monatsrendite von SMI, S&P 500 und DAX (so lange Daten verfügbar, max. 30 Jahre)."""
    try:
        import pandas as pd
        import yfinance as yf
        indizes = {"^SSMI": "SMI", "^GSPC": "S&P 500", "^GDAXI": "DAX"}
        df = yf.download(list(indizes), period="max", interval="1mo", auto_adjust=False,
                         progress=False, group_by="ticker")
        ergebnis = {}
        for sym, name in indizes.items():
            serie = df[sym]["Close"].dropna()
            serie = serie[serie.index >= serie.index.max() - pd.DateOffset(years=30)]
            renditen = serie.pct_change().dropna() * 100
            monate = []
            for m in range(1, 13):
                # Jede Monatszeile von yfinance enthält den Schlusskurs am Monatsende
                werte = renditen[renditen.index.month == m]
                monate.append({
                    "monat": m,
                    "schnitt": round(float(werte.mean()), 2) if len(werte) else None,
                    "median": round(float(werte.median()), 2) if len(werte) else None,
                    "positiv": round(float((werte > 0).mean() * 100), 0) if len(werte) else None,
                    "jahre": int(len(werte)),
                })
            dieses_jahr = {int(i.month): round(float(v), 2) for i, v in renditen.items() if i.year == date.today().year}
            ergebnis[name] = {"monate": monate, "dieses_jahr": dieses_jahr,
                              "von": int(serie.index.min().year), "bis": int(serie.index.max().year)}
        quellen["saison"] = "OK (Yahoo Finance, Monatsdaten)"
        return ergebnis
    except Exception as e:  # noqa: BLE001
        log.warning("Saisonalität nicht geladen: %s", e)
        quellen["saison"] = f"Fehler: {str(e)[:60]}"
        return alt or {}
