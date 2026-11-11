# CricScorer 🏏

**Professional Offline-First Cricket Scoring & Scorecard Management PWA**

## Clean Rollback Build (v2.10 Stable):
- Reverted all experimental dismissal and multi-filter changes to restore full functionality.
- **⚡ Quick Match Mode:**
  - Ad-hoc match fixtures with on-the-spot player enrollment directly on the live crease without prior squad registration.
- **Modern Simplified Home Dashboard:**
  - Dynamic live match hero with live score updates, 3-tile quick actions (**Start Match**, **Add Player**, **Add Team**), and clean overview metrics.
- **Player Statistics PDF Export:**
  - One-tap "📄 Export PDF" in the Statistics tab with career batting & bowling tables (100% offline via native `@media print`).
- **In-App Auto Backup Vault:**
  - Automatic background recovery snapshots into IndexedDB (`CricScorer_AutoBackup_Vault`) with one-tap restore in Settings.
- **Universal Alphabetical Sorting (A–Z):**
  - Universal alphabetical sorting across player registry, match squads, and live crease dropdowns.
- **Card-Based Squad Selection UI:**
  - Interactive player tiles with cross-team conflict prevention (`(In Team A)` / `(In Team B)`), live search filter, and squad counters.
- **Independent Squad Pool:**
  - Central player registry without forced team associations.
- **Screen Wake Lock & Haptics:**
  - Screen stay-awake during live matches and tactile vibration feedback.

## Deploy to GitHub Pages:
1. Extract all 7 files directly into the root folder of your GitHub repository.
2. Commit and push:
   ```bash
   git add .
   git commit -m "Rollback to stable v2.10: restored working scoring, dashboard, and quick match"
   git push origin main
   ```
3. Once deployed, open your GitHub Pages link in Chrome on Android.
