#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Zeitprüfung für GitHub Actions
==============================

Problem: GitHub startet zeitgesteuerte Abläufe ("cron") immer in UTC-Zeit.
Die Schweiz hat aber im Winter UTC+1 und im Sommer UTC+2.

Lösung: Der Workflow ist für JEDE gewünschte Zeit zweimal eingetragen
(einmal für Sommer-, einmal für Winterzeit). Dieses Skript prüft, ob die
eingetragene UTC-Zeit heute in Schweizer Zeit genau einer Zielzeit
entspricht. Nur dann wird die Aktualisierung ausgeführt, der andere
Lauf beendet sich sofort.

Beispiel 07:00 Schweizer Zeit:
    cron "0 5 * * *" (05:00 UTC) = 07:00 im Sommer  -> ausführen
                                 = 06:00 im Winter  -> überspringen
    cron "0 6 * * *" (06:00 UTC) = 08:00 im Sommer  -> überspringen
                                 = 07:00 im Winter  -> ausführen

Aufruf (im Workflow):
    python scripts/check_time.py "<event_name>" "<cron-ausdruck>"
Ergebnis: schreibt "ausfuehren=true/false" in $GITHUB_OUTPUT
"""
import os
import sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

# Gewünschte Zeiten in Schweizer Zeit (Stunde, Minute)
ZIELZEITEN = [(7, 0), (22, 30)]
ZEITZONE = ZoneInfo("Europe/Zurich")


def soll_laufen(event: str, cron: str, jetzt: datetime | None = None) -> bool:
    # Manueller Start oder Code-Änderung: immer ausführen
    if event != "schedule" or not cron.strip():
        return True
    minute, stunde = cron.split()[:2]
    jetzt = jetzt or datetime.now(timezone.utc)
    # Geplante UTC-Zeit von heute -> in Schweizer Zeit umrechnen.
    # (GitHub startet manchmal verspätet; deshalb rechnen wir mit der
    #  GEPLANTEN Zeit und nicht mit der tatsächlichen Startzeit.)
    geplant = jetzt.replace(hour=int(stunde), minute=int(minute), second=0, microsecond=0)
    lokal = geplant.astimezone(ZEITZONE)
    return (lokal.hour, lokal.minute) in ZIELZEITEN


if __name__ == "__main__":
    event = sys.argv[1] if len(sys.argv) > 1 else ""
    cron = sys.argv[2] if len(sys.argv) > 2 else ""
    ergebnis = soll_laufen(event, cron)
    print(f"Ereignis: {event or '-'} | Cron: {cron or '-'} | Ausführen: {'JA' if ergebnis else 'NEIN'}")
    ausgabe = os.environ.get("GITHUB_OUTPUT")
    if ausgabe:
        with open(ausgabe, "a", encoding="utf-8") as f:
            f.write(f"ausfuehren={'true' if ergebnis else 'false'}\n")
