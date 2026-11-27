# -*- coding: utf-8 -*-
"""
Push-Nachrichten aufs iPhone/iPad über ntfy (gratis, ohne Konto)
================================================================

So funktioniert es:
  1. App "ntfy" aus dem App Store installieren.
  2. In der App auf "+" tippen und ein geheimes Thema abonnieren,
     z.B. "boerse-maurus-8f3k2q9" (lang und zufällig = niemand errät es).
  3. Auf GitHub unter Settings → Secrets and variables → Actions →
     "New repository secret": Name NTFY_TOPIC, Wert = dein Thema.
Ohne NTFY_TOPIC werden einfach keine Nachrichten verschickt.
"""
from __future__ import annotations

import logging
import os

import requests

log = logging.getLogger("boerse")
APP_URL = os.environ.get("APP_URL", "https://maurusehrler.github.io/Maurus/")


def sende(titel: str, text: str, tags: str = "chart_with_upwards_trend", prioritaet: int = 3) -> bool:
    """Schickt eine Nachricht an das ntfy-Thema aus dem GitHub-Secret NTFY_TOPIC."""
    thema = os.environ.get("NTFY_TOPIC", "").strip()
    if not thema:
        log.info("  Push: kein NTFY_TOPIC eingerichtet – Nachricht nicht gesendet")
        return False
    try:
        r = requests.post(
            "https://ntfy.sh/",
            json={"topic": thema, "title": titel[:120], "message": text[:3500], "tags": tags.split(","),
                  "priority": prioritaet, "click": APP_URL},
            timeout=20,
        )
        r.raise_for_status()
        log.info("  Push gesendet: %s", titel)
        return True
    except Exception as e:  # noqa: BLE001
        log.warning("  Push fehlgeschlagen: %s", e)
        return False
