# 📈 Börsen-Übersicht (PWA)

Persönliche Börsen-Übersicht für iPhone und iPad. Sie aktualisiert sich jeden Morgen
(ca. 07:00) und jeden Abend (ca. 22:30, Schweizer Zeit) automatisch, ist komplett
**kostenlos** und braucht **keine API-Schlüssel**.

**Inhalt (4 Bereiche, unten bzw. auf dem iPad oben umschaltbar):**
- **Übersicht:** Aktie des Tages (Steckbrief + Kennzahlen-Check), Finanzbegriff des Tages (mit Lexikon), Börsenstatus, Tagesüberblick in Textform, Auffälligkeiten, Fear & Greed (Aktien: CNN,
  Krypto: alternative.me), Indizes mit Mini-Charts,
  Top & Flop Schweiz/USA, Termine heute/morgen, Top-News
- **Aktien:** 12 Sektoren mit je 5–10 grossen Titeln (inkl. Bitcoin- und Quanten-Aktien) im Vergleich,
  Gewinner/Verlierer pro Sektor, US-Sektoren (S&P 500), alle Aktien sortiert. Filter: Alle / Schweiz / USA / Übrige
- **Märkte:** Indizes, ETFs/Fonds, Krypto, Rohstoffe, Devisen, VIX und US-Zinsen
- **Kalender:** Monatsansicht mit allen Terminen: Quartalszahlen (mit Analysten-Schätzungen),
  Dividenden, Notenbanken, Konjunkturdaten, eigene Events/Präsentationen, Optionsverfall, Börsenfeiertage
- **Detailansicht:** Jede Aktie antippen → Kursverlauf, Steckbrief, Gewinn der letzten Jahre,
  KGV, PEG, KBV, Margen, Eigenkapitalrendite, Dividende, Verschuldung, Analysten-Kursziele (mit Ampel und Erklärung)
- **News:** Schlagzeilen aus RSS-Feeds (sortierbar: Wichtigste/Neueste, Filter: Schweiz/International), Wirtschaftskalender, Datenquellen-Status

**Zeitraum-Umschalter** oben: **1T · 1W · 1M · 3M · YTD · 1J · 3J · 5J** (1 Tag, 1 Woche, 1 Monat, 3 Monate,
seit Jahresbeginn, 1, 3 und 5 Jahre). Er gilt für Kurse, Mini-Charts, Top & Flop und Sektoren.
Die App merkt sich Tab, Zeitraum und Region.

> Keine Anlageberatung. Daten ohne Gewähr, teilweise verzögert.

---

## 🗂️ Aufbau des Projekts

```
config.yaml                  ← HIER änderst du Aktien, Feeds, Schwellen, Termine
steckbriefe.yaml             ← deutsche Kurzporträts der Aktien (Aktie des Tages)
requirements.txt             ← benötigte Python-Bibliotheken
scripts/
  fetch_data.py              ← holt alle Daten und schreibt docs/data/markets.json
  check_time.py              ← Sommer-/Winterzeit-Prüfung für den Zeitplan
  make_icons.py              ← erzeugt die App-Icons (nur einmal nötig)
docs/                        ← die Webseite (wird auf GitHub Pages veröffentlicht)
  index.html                 ← Grundgerüst der Seite
  style.css                  ← Aussehen (hell/dunkel, iPhone/iPad)
  app.js                     ← liest markets.json und baut die Seite auf
  kennzahlen.js              ← Aktie des Tages, Detailansicht, Finanz-Lexikon
  kalender.js                ← Kalender-Ansicht
  sw.js                      ← Service Worker (Offline-Betrieb)
  manifest.json              ← App-Einstellungen für den Home-Bildschirm
  icons/                     ← App-Icons
  data/markets.json          ← Kurse, News, Termine (automatisch erzeugt)
  data/fundamentals.json     ← Kennzahlen aller Aktien (1x täglich automatisch erneuert)
.github/workflows/update.yml ← Zeitplan der automatischen Aktualisierung
```

**So funktioniert es:**
1. GitHub Actions startet zweimal täglich das Python-Skript `scripts/fetch_data.py`.
2. Das Skript holt die Daten aus Gratis-Quellen und speichert sie in `docs/data/markets.json`.
3. Danach wird der Ordner `docs/` auf GitHub Pages veröffentlicht.
4. Die App auf dem iPhone/iPad liest nur diese JSON-Datei.

**Datenquellen und Ersatzquellen:**

| Bereich | Hauptquelle | Ersatz, wenn sie ausfällt |
|---|---|---|
| Indizes, Aktien, Rohstoffe | Yahoo Finance (yfinance) | stooq.com (wo hinterlegt), danach letzter bekannter Wert |
| Devisen | Yahoo Finance | EZB-Kurse (frankfurter.app), danach letzter bekannter Wert |
| Krypto | CoinGecko | Yahoo Finance, danach letzter bekannter Wert |
| News | RSS-Feeds (siehe `config.yaml`) | defekte Feeds werden übersprungen |
| Kalender | ForexFactory-Wochenkalender, Quartalszahlen via yfinance, eigene Termine | letzte bekannte Termine |

Fällt eine Quelle aus, zeigt die App den letzten bekannten Wert mit einem gelben
⚠-Hinweis. Die Seite geht dabei nie ganz kaputt.

---

## 🚀 Einrichtung Schritt für Schritt

Der Code liegt bereits in deinem GitHub-Repository **Maurusehrler/Maurus** auf dem Branch `main`.
(Falls du später ein neues Konto/Repo brauchst: siehe Anhang ganz unten.)

### Schritt 1: `main` als Standard-Branch festlegen
Zeitgesteuerte Abläufe laufen bei GitHub nur auf dem Standard-Branch.
1. Öffne https://github.com/Maurusehrler/Maurus und melde dich an.
2. Klicke oben auf **Settings** (Zahnrad).
3. Links **General** → Abschnitt **Default branch**.
4. Steht dort nicht `main`: auf das Symbol mit den zwei Pfeilen klicken → `main` wählen → **Update** → bestätigen.

### Schritt 2: Repository öffentlich machen
GitHub Pages ist im Gratis-Konto nur für öffentliche Repositories verfügbar.
1. **Settings** → **General** → ganz nach unten zur **Danger Zone**.
2. **Change visibility** → **Change to public** → bestätigen.
   (Im Code gibt es keine Passwörter. Sichtbar ist nur deine Aktienliste.)

### Schritt 3: GitHub Pages einschalten
1. **Settings** → links **Pages**.
2. Unter **Build and deployment** → **Source**: **GitHub Actions** auswählen.
3. Fertig. Speichern ist nicht nötig.

### Schritt 4: Actions erlauben und ersten Lauf starten
1. Oben auf den Reiter **Actions** klicken.
2. Erscheint eine Meldung wie „Workflows aren't being run…“, auf **I understand my workflows, go ahead and enable them** klicken.
3. **Settings** → **Actions** → **General** → ganz unten bei **Workflow permissions** muss
   **Read and write permissions** gewählt sein → **Save**.
4. Zurück zu **Actions** → links **Börsendaten aktualisieren** → rechts **Run workflow** → grüner Knopf **Run workflow**.
5. Nach 2–4 Minuten erscheint ein grüner Haken ✅. Im Job **veroeffentlichen** steht die Adresse deiner App, z.B.
   **https://maurusehrler.github.io/Maurus/**

### Schritt 5: App auf iPhone und iPad installieren
1. Öffne **Safari** (wichtig: Safari, nicht Chrome) und gib die Adresse aus Schritt 4 ein.
2. Tippe auf das **Teilen-Symbol** (Quadrat mit Pfeil nach oben). Auf dem iPhone ist es unten, auf dem iPad oben rechts.
3. Etwas nach unten scrollen → **Zum Home-Bildschirm**.
4. Name „Börse“ lassen → **Hinzufügen**.
5. Die App erscheint mit Icon auf dem Home-Bildschirm und startet ohne Browserleiste.

**Aktualisieren in der App:** oben auf **Neu laden** tippen oder die Seite ganz oben nach unten ziehen.
Die Daten selbst werden nur 2x täglich auf GitHub erneuert (oder wenn du den Workflow manuell startest).

---

## ✏️ Aktien hinzufügen oder entfernen

Alles läuft über die Datei **`config.yaml`**. Du kannst sie direkt im Browser bearbeiten:

1. Auf GitHub die Datei `config.yaml` öffnen → oben rechts auf das **Stift-Symbol** ✏️ klicken.
2. **Aktie hinzufügen:** Im Abschnitt `aktien:` beim passenden Sektor eine Zeile im gleichen Format ergänzen, z.B.:
   ```yaml
     "Industrie":
       - { symbol: "SGSN.SW", name: "SGS" }
   ```
   Das Symbol findest du auf https://finance.yahoo.com. Schweizer Aktien enden auf **`.SW`**,
   US-Aktien haben kein Anhängsel (z.B. `NFLX`), deutsche enden auf `.DE`, japanische auf `.T`.
   **Neuer Sektor:** einfach eine neue Überschrift in Anführungszeichen mit Doppelpunkt anlegen
   (gleich eingerückt wie die anderen Sektoren) und darunter die Aktien auflisten.
3. **Aktie entfernen:** die Zeile löschen oder ein `#` an den Anfang setzen.
4. Unten auf **Commit changes…** → **Commit changes** klicken.
5. Die Aktualisierung startet automatisch. Nach 2–4 Minuten ist die Änderung in der App sichtbar.

**Steckbrief ergänzen:** In `steckbriefe.yaml` unter dem Symbol der Aktie `was`, `chancen`, `risiken`
und optional `fakt` eintragen (gleiches Format wie die anderen). Ohne Steckbrief zeigt die App die
englische Firmenbeschreibung von Yahoo.

**Eigene Termine/Präsentationen** (z.B. Apple-Keynote, Investorentag, Generalversammlung): in `config.yaml`
unter `kalender:` → `eigene_termine:` eine Zeile ergänzen, z.B.
`- { datum: "2027-04-15", titel: "Generalversammlung Nestlé", typ: "event", land: "Schweiz" }`.

**ETF oder Fonds hinzufügen:** im Abschnitt `etfs:` eine Zeile mit der ISIN ergänzen, z.B.
`- { isin: "IE00B5BMR087", name: "iShares Core S&P 500", boerse: [".SW", ".L", ".DE"] }`.
Das Skript sucht das passende Yahoo-Symbol selbst (bevorzugt an den Börsen unter `boerse`).

⚠️ Wichtig bei YAML: nur **Leerzeichen** zum Einrücken verwenden (keine Tabs) und das Format
`- { symbol: "...", name: "..." }` genau beibehalten.

In `config.yaml` kannst du ausserdem:
- **Schwellen** für Auffälligkeiten ändern (`schwellen:`, auch pro Sektor, z.B. Bitcoin ±10 %)
- **News-Feeds** hinzufügen oder entfernen (`news: feeds:`)
- **Stichwörter** für die News-Gewichtung anpassen (`stichwoerter:`)
- **Eigene Termine** eintragen, z.B. Notenbank-Sitzungen (`eigene_termine:`)
- **US-Sektoren** ändern (`sektoren_us:`, Sektor-ETFs von SPDR)
- **Börsen-Feiertage** pflegen (`boersen:`). Bitte einmal pro Jahr ergänzen.

**Uhrzeiten ändern:** in `scripts/check_time.py` die `ZIELZEITEN` anpassen und in
`.github/workflows/update.yml` die passenden zwei UTC-Zeiten pro Zielzeit eintragen
(Winter = Schweizer Zeit − 1 Std., Sommer = Schweizer Zeit − 2 Std.).

**Aussehen geändert (HTML/CSS/JS)?** Dann in `docs/sw.js` die Zeile `const VERSION = "v1";`
auf `"v2"` usw. erhöhen, damit iPhone/iPad die neue Version laden.

---

## 🛠️ Wenn die Aktualisierung nicht funktioniert

1. **In der App nachsehen:** Oben steht „Daten vom …“. Ist es älter als 16 Stunden, erscheint ein gelber Hinweis.
   Ganz unten unter **Datenquellen & Status** siehst du, welche Quellen beim letzten Lauf funktioniert haben.
2. **Auf GitHub nachsehen:** Reiter **Actions** → letzter Lauf von „Börsendaten aktualisieren“.
   - ✅ grün = alles gut
   - ❌ rot = Fehler. Auf den Lauf klicken → auf den roten Job klicken → die rote Zeile zeigt den Grund.
   - Ein gelbes ⚠ „Keine einzige Kursquelle hat geantwortet“ bedeutet: Yahoo war gerade nicht erreichbar.
     Das löst sich meist beim nächsten Lauf von selbst.
3. **Manuell neu starten:** Actions → „Börsendaten aktualisieren“ → **Run workflow**.
4. **Häufige Ursachen:**
   | Problem | Lösung |
   |---|---|
   | Fehler direkt nach einer Änderung an `config.yaml` | Tippfehler in der Datei (meist Einrückung oder fehlendes `"`). Letzte Änderung prüfen oder rückgängig machen. |
   | Job „veroeffentlichen“ rot: „Pages not enabled“ / „Not Found“ | Schritt 2 und 3 oben erneut prüfen (Repo öffentlich? Source = GitHub Actions?). |
   | „Permission denied“ / Push fehlgeschlagen | Settings → Actions → General → **Read and write permissions**. |
   | Es läuft gar nichts mehr automatisch | GitHub pausiert Zeitpläne nach 60 Tagen ohne Aktivität. Unter Actions erscheint dann ein Knopf **Enable workflow**. Einmal klicken. |
   | Einzelne Aktie zeigt immer „⚠ keine Daten“ | Symbol in `config.yaml` falsch. Auf finance.yahoo.com prüfen. |
   | Ein News-Feed zeigt ❌ | Die Webseite hat ihren Feed geändert oder blockiert ihn. Zeile in `config.yaml` entfernen oder Adresse ersetzen. |
   | App zeigt alte Version | App ganz schliessen und neu öffnen. Notfalls vom Home-Bildschirm löschen und neu hinzufügen. |
5. Hinweis: GitHub startet zeitgesteuerte Läufe manchmal 5–60 Minuten verspätet. Das ist normal.

---

## 💻 Lokal testen (optional, für Neugierige)

Voraussetzung: Python 3.10 oder neuer.

```bash
pip install -r requirements.txt
python scripts/fetch_data.py                  # echte Daten holen
python scripts/fetch_data.py --beispieldaten  # Testdaten ohne Internet
cd docs && python -m http.server 8000         # danach im Browser: http://localhost:8000
```

---

## 📎 Anhang: neues GitHub-Konto und Projekt hochladen (nur falls nötig)

1. Auf https://github.com/signup ein kostenloses Konto erstellen (E-Mail, Passwort, Benutzername) und die E-Mail bestätigen.
2. Oben rechts **+** → **New repository** → Name z.B. `boerse` → **Public** → **Create repository**.
3. Auf der leeren Repo-Seite auf **uploading an existing file** klicken.
4. Alle Projektdateien und Ordner per Drag & Drop hineinziehen (auch den Ordner `.github`;
   auf dem Mac werden Ordner mit Punkt im Finder mit **Cmd + Shift + .** sichtbar) → **Commit changes**.
5. Danach mit **Schritt 3** oben weitermachen. Die App-Adresse lautet dann
   `https://<benutzername>.github.io/<repo-name>/`.
