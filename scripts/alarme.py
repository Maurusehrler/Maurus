#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Kursalarme (läuft alle 30 Minuten während der Börsenzeiten)
==========================================================

Prüft die Alarme aus config.yaml (Abschnitt "alarme") und schickt eine
Push-Nachricht, wenn eine Bedingung erfüllt ist:
    ueber: 100        -> Kurs steigt über 100
    unter: 80         -> Kurs fällt unter 80
    tag_prozent: 5    -> Kurs bewegt sich heute um mehr als ±5 %
Jeder Alarm meldet sich höchstens einmal pro Tag (gemerkt in
docs/data/alarme_status.json).
"""
from __future__ import annotations

import json
import logging
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
from benachrichtigung import sende  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
STATUS = ROOT / "docs" / "data" / "alarme_status.json"
logging.basicConfig(level=logging.INFO, format="%(levelname)-7s %(message)s")
log = logging.getLogger("boerse")
logging.getLogger("yfinance").setLevel(logging.CRITICAL)


def zahl(w: float) -> str:
    return f"{w:,.2f}".replace(",", "'")


def main() -> int:
    cfg = yaml.safe_load(open(ROOT / "config.yaml", encoding="utf-8"))
    alarme = cfg.get("alarme") or []
    if not alarme:
        log.info("Keine Alarme in config.yaml eingetragen.")
        return 0
    heute = datetime.now(ZoneInfo("Europe/Zurich")).strftime("%Y-%m-%d")
    try:
        status = json.load(open(STATUS, encoding="utf-8"))
    except Exception:  # noqa: BLE001
        status = {}
    status = {k: v for k, v in status.items() if v == heute}    # nur heutige merken

    import yfinance as yf
    symbole = sorted({a["symbol"] for a in alarme})
    df = yf.download(symbole, period="5d", interval="1d", group_by="ticker", auto_adjust=False, progress=False)
    mehrstufig = getattr(df.columns, "nlevels", 1) > 1
    geaendert = False
    for a in alarme:
        try:
            serie = (df[a["symbol"]] if mehrstufig else df)["Close"].dropna()
            kurs, vortag = float(serie.iloc[-1]), float(serie.iloc[-2])
        except Exception:  # noqa: BLE001
            log.info("  %s: keine Kurse", a["symbol"])
            continue
        name = a.get("name", a["symbol"])
        pct = (kurs / vortag - 1) * 100
        meldungen = []
        if "ueber" in a and kurs > float(a["ueber"]):
            meldungen.append(("ueber", f"{name} ist über {zahl(a['ueber'])} gestiegen: jetzt {zahl(kurs)} ({pct:+.1f} %)"))
        if "unter" in a and kurs < float(a["unter"]):
            meldungen.append(("unter", f"{name} ist unter {zahl(a['unter'])} gefallen: jetzt {zahl(kurs)} ({pct:+.1f} %)"))
        if "tag_prozent" in a and abs(pct) >= float(a["tag_prozent"]):
            meldungen.append(("tag", f"{name} bewegt sich heute stark: {pct:+.1f} % auf {zahl(kurs)}"))
        for art, text in meldungen:
            schluessel = f"{a['symbol']}:{art}"
            if schluessel in status:
                continue
            if sende(f"🔔 Kursalarm: {name}", text, tags="bell", prioritaet=4):
                status[schluessel] = heute
                geaendert = True
            log.info("  %s", text)
    if geaendert:
        STATUS.parent.mkdir(parents=True, exist_ok=True)
        json.dump(status, open(STATUS, "w", encoding="utf-8"), indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
