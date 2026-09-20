# ⚽ Teammanager

Team-App für Jugendmannschaften: Termine, Zu-/Absagen, Trainingsplanung, Teambildung und Turniere – für Trainer, Eltern und Spieler. PWA: funktioniert auch offline und lässt sich auf dem Smartphone installieren.

## Features

- 🗓 **Termine** – Trainings, Spieltage und Trainertreffen in Liste und Kalender, Trainingszeiten (Serien), SOS-Notfallplan
- ✅ **Anmeldung** – Eltern und Spieler sagen zu, ab oder „unsicher"; Trainer sehen pro Termin, wer kommt (mit Statusfiltern)
- 👥 **Rollen** – Admin, Trainer, Eltern, Spieler; Eltern und Spieler sehen nur Termine und Zu-/Absagen
- 🏟 **Mehrere Teams** – Teams anlegen, beitreten, wechseln; Einladung per Link oder Code
- 📚 Übungsbibliothek, 📅 Trainingsplanung, 🔀 Teambildung, 🏆 Turniere, 💰 Kasse, 📋 To-Dos
- 📤 Export (JSON-Backup, CSV) & Import

## Setup

### 1. Abhängigkeiten installieren

```bash
npm install
```

### 2. Repository-Name

In `vite.config.js` muss `REPO_NAME` dem Namen des GitHub-Repositories entsprechen (aktuell `Teammanager`). Er bestimmt die Adresse der App.

### 3. Lokal testen

```bash
npm run dev
```

→ App läuft auf http://localhost:5173

### 4. Auf GitHub deployen

**Einmalig:** In deinem GitHub Repository unter `Settings → Pages → Source` auf **„GitHub Actions"** umstellen.

Danach genügt ein Push auf `main`. GitHub Actions baut und deployt die App automatisch.
→ Verfügbar unter: `https://DEIN-USERNAME.github.io/Teammanager/`

### 5. Als App installieren (PWA)

**Android (Chrome):** „App installieren" bzw. Menü → „Zum Startbildschirm hinzufügen"

**iOS (Safari):** Teilen-Button → „Zum Home-Bildschirm" → Hinzufügen

Einen geänderten App-Namen übernimmt das Gerät nur bei einer Neuinstallation.

## Daten & Sicherheit

- Anmeldung und Daten laufen über **Firebase** (Authentication + Firestore). Die Zugriffsregeln stehen in `firestore.rules` und müssen in der Firebase Console veröffentlicht werden.
- Die App hält zusätzlich einen lokalen Zwischenspeicher im Browser (IndexedDB) für den Offline-Betrieb.
- Sensible Daten (Spielerstärken, Kontakte, Kasse, Trainingsinhalte) sind für Eltern und Spieler durch die Regeln gesperrt. Sie sehen nur reduzierte Daten (Namen und Termine).
- Backups: Einstellungen → „Vollständiges Backup" exportieren.

## Icons ersetzen

Die Icons (`public/icon-192.png`, `public/icon-512.png`, `public/apple-touch-icon.png`) lassen sich durch eigene ersetzen, z. B. ein Vereinslogo, in den gleichen Größen.

## Technologie

- React 18 + Vite
- Firebase (Authentication, Firestore)
- Dexie.js (IndexedDB, lokaler Zwischenspeicher)
- lucide-react (Icons)
- vite-plugin-pwa (PWA/Offline)
- GitHub Actions (automatisches Deployment)
