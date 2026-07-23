# ⚽ Jugend Coach

Trainings-App für G-Jugend (U7) Fußball-Trainer. PWA – funktioniert auch offline und kann auf dem Smartphone installiert werden.

## Features

- 📚 Übungsbibliothek (Aufbau, Material, Skizzen, Tags, Bewertung)
- 👥 Spieler- & Trainerverwaltung mit Stärkenbewertung (4 Stufen)
- 📅 Trainingsplanung & Verlauf (Anwesenheit, verwendete Übungen)
- 🔀 Teambildung (ausgeglichen, durchmischt, Herausforderung, zufällig)
- 📤 Export (JSON Backup, CSV Spieler) & Import
- 📱 PWA – auf Android & iOS installierbar

## Setup

### 1. Abhängigkeiten installieren

```bash
npm install
```

### 2. Repository-Name anpassen

In `vite.config.js` den `REPO_NAME` auf deinen GitHub Repository-Namen setzen:

```js
const REPO_NAME = "gjugend-coach"; // ← deinen Repository-Namen hier eintragen
```

### 3. Lokal testen

```bash
npm run dev
```

→ App läuft auf http://localhost:5173

### 4. Auf GitHub deployen

**Einmalig:** In deinem GitHub Repository unter  
`Settings → Pages → Source` auf **"GitHub Actions"** umstellen.

Dann einfach pushen:

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/DEIN-USERNAME/gjugend-coach.git
git push -u origin main
```

GitHub Actions baut und deployt die App automatisch.  
→ Verfügbar unter: `https://DEIN-USERNAME.github.io/gjugend-coach/`

### 5. Als App installieren (PWA)

**Android (Chrome):**  
Chrome zeigt automatisch „App installieren" an, oder über Menü → "Zum Startbildschirm hinzufügen"

**iOS (Safari):**  
Teilen-Button → "Zum Home-Bildschirm" → Hinzufügen

## Icons ersetzen

Die mitgelieferten Icons (`public/icon-192.png`, `public/icon-512.png`) sind Platzhalter.  
Ersetze sie mit eigenen Icons (z.B. ein Vereinslogo) in den gleichen Größen.

## Daten

Alle Daten werden **lokal auf dem Gerät** gespeichert (IndexedDB).  
Kein Server, keine Cloud, keine Kosten.

Für Backups und Gerätewechsel: Einstellungen → "Vollständiges Backup" exportieren.

## Technologie

- React 18 + Vite
- Dexie.js (IndexedDB)
- lucide-react (Icons)
- vite-plugin-pwa (PWA/Offline)
- GitHub Actions (automatisches Deployment)

## Version

`1.0.0` – Build 1 (Bibliothek, Team, Training, Export/Import)  
Build 2 in Planung: Claude KI-Integration, Turnierplanung
