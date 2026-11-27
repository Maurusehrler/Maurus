# -*- coding: utf-8 -*-
"""
Makro-Daten: Zinsen, Zinskurve, Inflation, Arbeitslosigkeit, Wachstum, Saisonalität
===================================================================================

Quellen (gratis, ohne Schlüssel):
  - FRED (Federal Reserve Bank of St. Louis): CSV-Download pro Zeitreihe
  - SNB-Datenportal: SNB-Leitzins
  - Yahoo Finance (yfinance): lange Monatsreihen für die Saisonalität

Für jede Grösse sind mehrere Zeitreihen hinterlegt – die erste, die
funktioniert, wird genommen. Fällt alles aus, bleibt der letzte Stand.
"""
from __future__ import annotations

import io
import logging
from datetime import date, timedelta

import requests

log = logging.getLogger("boerse")
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15"}
FRED = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={id}&cosd={start}"

# Zinskurve USA: Laufzeit -> FRED-Reihe
ZINSKURVE = [("1M", "DGS1MO"), ("3M", "DGS3MO"), ("6M", "DGS6MO"), ("1J", "DGS1"), ("2J", "DGS2"),
             ("5J", "DGS5"), ("10J", "DGS10"), ("30J", "DGS30")]

# Kennzahl -> Liste von (FRED-Reihe, Umrechnung). "yoy" = Veränderung zum Vorjahr in %
REIHEN = {
    "leitzins_fed": {"name": "Fed (USA)", "einheit": "%", "kandidaten": [("DFEDTARU", "wert")]},
    "leitzins_ezb": {"name": "EZB (Einlagesatz)", "einheit": "%", "kandidaten": [("ECBDFR", "wert")]},
    "leitzins_snb": {"name": "SNB (Schweiz)", "einheit": "%", "kandidaten": [("IRSTCI01CHM156N", "wert")]},
    "rendite_us10": {"name": "USA 10 Jahre", "einheit": "%", "kandidaten": [("DGS10", "wert")]},
    "rendite_ch10": {"name": "Schweiz 10 Jahre", "einheit": "%", "kandidaten": [("IRLTLT01CHM156N", "wert")]},
    "rendite_de10": {"name": "Deutschland 10 Jahre", "einheit": "%", "kandidaten": [("IRLTLT01DEM156N", "wert")]},
    "spread_10_2": {"name": "US-Zinsdifferenz 10J − 2J", "einheit": "%-Pkt.", "kandidaten": [("T10Y2Y", "wert")]},
    "inflation_ch": {"name": "Schweiz", "einheit": "%", "kandidaten": [("CHECPIALLMINMEI", "yoy"), ("CPALTT01CHM659N", "wert"), ("CPALTT01CHM657N", "wert")]},
    "inflation_us": {"name": "USA", "einheit": "%", "kandidaten": [("CPIAUCSL", "yoy")]},
    "inflation_ez": {"name": "Eurozone", "einheit": "%", "kandidaten": [("CP0000EZ19M086NEST", "yoy")]},
    "arbeitslos_ch": {"name": "Schweiz", "einheit": "%", "kandidaten": [("LRUNTTTTCHQ156S", "wert"), ("LRHUTTTTCHM156S", "wert")]},
    "arbeitslos_us": {"name": "USA", "einheit": "%", "kandidaten": [("UNRATE", "wert")]},
    "arbeitslos_ez": {"name": "Eurozone", "einheit": "%", "kandidaten": [("LRHUTTTTEZM156S", "wert")]},
    "bip_ch": {"name": "Schweiz", "einheit": "% ggü. Vorjahr", "kandidaten": [("CLVMNACSAB1GQCH", "yoy")]},
    "bip_us": {"name": "USA", "einheit": "% ggü. Vorjahr", "kandidaten": [("GDPC1", "yoy")]},
    "bip_ez": {"name": "Eurozone", "einheit": "% ggü. Vorjahr", "kandidaten": [("CLVMNACSCAB1GQEA19", "yoy")]},
}


def fred_reihe(reihe: str, jahre: int = 7) -> list[tuple[str, float]]:
    start = (date.today() - timedelta(days=365 * jahre)).isoformat()
    r = requests.get(FRED.format(id=reihe, start=start), headers=UA, timeout=30)
    r.raise_for_status()
    punkte = []
    for zeile in r.text.strip().splitlines()[1:]:
        teile = zeile.split(",")
        if len(teile) >= 2 and teile[1] not in ("", "."):
            try:
                punkte.append((teile[0], float(teile[1])))
            except ValueError:
                pass
    if len(punkte) < 2:
        raise ValueError("zu wenige Werte")
    return punkte


def _vorjahr(punkte: list[tuple[str, float]]) -> list[tuple[str, float]]:
    """Veränderung zum gleichen Zeitpunkt im Vorjahr in Prozent."""
    werte = dict(punkte)
    ergebnis = []
    for tag, wert in punkte:
        vj = f"{int(tag[:4]) - 1}{tag[4:]}"
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


def snb_leitzins() -> list[tuple[str, float]]:
    """SNB-Leitzins direkt vom SNB-Datenportal (Würfel 'snbgwdzid')."""
    r = requests.get("https://data.snb.ch/api/cube/snbgwdzid/data/csv/de", headers=UA, timeout=30)
    r.raise_for_status()
    punkte = []
    for zeile in r.text.splitlines():
        teile = [t.strip().strip('"') for t in zeile.split(";")]
        if len(teile) >= 3 and teile[1] == "LZ" and teile[2] not in ("", "Value"):
            try:
                punkte.append((teile[0][:10], float(teile[2])))
            except ValueError:
                pass
    if len(punkte) < 2:
        raise ValueError("Leitzins nicht gefunden")
    grenze = (date.today() - timedelta(days=365 * 7)).isoformat()
    return [p for p in punkte if p[0] >= grenze]


def lade_makro(alt: dict, quellen: dict) -> dict:
    ergebnis, ok, fehl = {"reihen": {}, "zinskurve": None}, 0, []
    alt_reihen = (alt or {}).get("reihen", {})
    for schluessel, info in REIHEN.items():
        punkte, quelle = None, None
        if schluessel == "leitzins_snb":
            try:
                punkte, quelle = snb_leitzins(), "SNB-Datenportal"
            except Exception as e:  # noqa: BLE001
                log.info("  SNB-Leitzins direkt: %s", e)
        for reihe, art in ([] if punkte else info["kandidaten"]):
            try:
                p = fred_reihe(reihe, 8 if art == "yoy" else 7)
                punkte = _vorjahr(p) if art == "yoy" else p
                if len(punkte) >= 2:
                    quelle = f"FRED {reihe}"
                    break
            except Exception as e:  # noqa: BLE001
                log.info("  FRED %s: %s", reihe, str(e)[:60])
        if punkte:
            grenze = (date.today() - timedelta(days=365 * 6)).isoformat()
            punkte = _ausduennen([p for p in punkte if p[0] >= grenze])
            ergebnis["reihen"][schluessel] = {
                "name": info["name"], "einheit": info["einheit"], "quelle": quelle,
                "daten": [p[0] for p in punkte], "werte": [round(p[1], 3) for p in punkte],
                "aktuell": round(punkte[-1][1], 2), "datum": punkte[-1][0],
            }
            ok += 1
        elif schluessel in alt_reihen:
            ergebnis["reihen"][schluessel] = {**alt_reihen[schluessel], "veraltet": True}
            fehl.append(schluessel)
        else:
            fehl.append(schluessel)

    # Zinskurve: heute, vor 1 Monat, vor 1 Jahr
    try:
        kurve = {"laufzeiten": [], "heute": [], "monat": [], "jahr": []}
        for laufzeit, reihe in ZINSKURVE:
            p = fred_reihe(reihe, 2)
            letzte = p[-1]
            def wert_vor(tage):
                ziel = (date.fromisoformat(letzte[0]) - timedelta(days=tage)).isoformat()
                kandidaten = [w for d, w in p if d <= ziel]
                return round(kandidaten[-1], 3) if kandidaten else None
            kurve["laufzeiten"].append(laufzeit)
            kurve["heute"].append(round(letzte[1], 3))
            kurve["monat"].append(wert_vor(30))
            kurve["jahr"].append(wert_vor(365))
            kurve["datum"] = letzte[0]
        ergebnis["zinskurve"] = kurve
    except Exception as e:  # noqa: BLE001
        log.info("  Zinskurve: %s", e)
        ergebnis["zinskurve"] = (alt or {}).get("zinskurve")
    quellen["makro"] = f"OK ({ok} von {len(REIHEN)} Reihen)" + (f", fehlend: {', '.join(fehl)}" if fehl else "")
    log.info("  Makro: %s", quellen["makro"])
    return ergebnis


def lade_saisonalitaet(alt: dict, quellen: dict) -> dict:
    """Durchschnittliche Monatsrendite von SMI, S&P 500 und DAX (so lange Daten verfügbar, max. 30 Jahre)."""
    try:
        import yfinance as yf
        indizes = {"^SSMI": "SMI", "^GSPC": "S&P 500", "^GDAXI": "DAX"}
        df = yf.download(list(indizes), period="max", interval="1mo", auto_adjust=False,
                         progress=False, group_by="ticker")
        ergebnis = {}
        for sym, name in indizes.items():
            serie = df[sym]["Close"].dropna()
            serie = serie[serie.index >= serie.index.max() - __import__("pandas").DateOffset(years=30)]
            renditen = serie.pct_change().dropna() * 100
            monate = []
            for m in range(1, 13):
                werte = renditen[renditen.index.month == m]
                # Jede Monatszeile von yfinance enthält den Schlusskurs am Monatsende
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
