# CricScorer 🏏

**Professional Offline-First Cricket Scoring & Scorecard Management PWA**

## Updates in this release (v2.12 - Critical Bugfix):
- **Startup Crash Fix:**
  - Resolved `ReferenceError: allPlayers is not defined` inside `renderDashboard()`.
  - Resolved `ReferenceError: playersMap is not defined` inside `viewDetailedScorecard()`.
  - Resolved string escaping syntax conflict on match list empty state.
- **Service Worker Cache Busted to `v2.12`:**
  - Forces mobile Chrome and PWAs to purge the faulty script immediately and fetch the clean release.
- **Team-Wise & Match-Wise Statistics Filtering:**
  - Multi-filter toolbar in the Statistics tab: filter by **Format**, **Team**, and individual **Match Fixture**.
  - Dynamic **Fielding Records** tab tracking Catches, Run-Outs, and Stumpings credited to fielders.
  - Targeted CSV export and custom-titled PDF reports reflecting active filters.
- **Live Scorecard & Dismissals:**
  - Fielder attribution on Caught, Run-Out, and Stumped dismissals with standard cricket notation.
  - Delivery-free Retired Hurt / Retired Out handling without ball or bowler consumption.
  - Granular Wide & No-Ball preset options with strike rotation.
- **⚡ Quick Match Mode:**
  - Ad-hoc match fixtures with on-the-spot player enrollment directly on the live crease.
- **Home Dashboard:**
  - Clean modernized dashboard with active match hero and 3-tile quick actions.
- **In-App Auto Backup Vault:**
  - Automatic background recovery snapshots into IndexedDB (`CricScorer_AutoBackup_Vault`).

## Deploy to GitHub Pages:
1. Extract all 7 files directly into the root folder of your GitHub repository.
2. Commit and push:
   ```bash
   git add .
   git commit -m "CricScorer v2.12: fix allPlayers & playersMap startup crash and bump cache"
   git push origin main
   ```
3. Once deployed, open your GitHub Pages link in Chrome on Android.
