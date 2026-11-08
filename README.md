# CricScorer 🏏

**Professional Offline-First Cricket Scoring & Scorecard Management PWA**

## Updates in this release (v2.8):
- **Player Statistics PDF Export:**
  - One-tap "📄 Export PDF" button in the Statistics tab.
  - Automatically structures a clean cricket report with career Batting (Inn, Runs, HS, Avg, SR, 50s, 100s, 4s, 6s) and Bowling (Overs, Runs, Wkts, Econ, Avg, SR) tables.
  - 100% offline using native browser Print-to-PDF (`@media print`) without external cloud or npm libraries.
- **In-App Auto Backup Vault:**
  - Automatic background recovery snapshots in local IndexedDB (`CricScorer_AutoBackup_Vault`).
  - One-tap "Restore Snapshot" button in Settings.
- **Alphabetical Sorting (A–Z):**
  - Player registry, match squad selection, live crease dropdowns, and dismissal modals sorted alphabetically.
- **Card-Based Squad Selection UI:**
  - Interactive player tiles with cross-team conflict prevention (`(In Team A)` / `(In Team B)`), live search filtering, and squad counters.
- **Independent Squad Pool:**
  - Register players without forced team associations; dynamically pick playing squads during match creation.
- **Scorecard Contrast:**
  - Dynamic high-contrast numbers for both Light (`#0b3b2e`) and Dark (`#ffffff`) modes.
- **Screen Wake Lock & Haptics:**
  - Screen stay-awake during live matches and tactile vibration feedback.

## Deploy to GitHub Pages:
1. Extract all 7 files directly into the root folder of your GitHub repository.
2. Commit and push:
   ```bash
   git add .
   git commit -m "CricScorer v2.8: player statistics PDF export template"
   git push origin main
   ```
3. Once deployed, open your GitHub Pages link in Chrome on Android.
