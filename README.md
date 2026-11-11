# CricScorer 🏏

**Professional Offline-First Cricket Scoring & Scorecard Management PWA**

## Updates in this release (v2.11):
- **Team-Wise & Match-Wise Statistics Filtering:**
  - Multi-filter toolbar in the Statistics tab: filter by **Format**, **Team**, and individual **Match Fixture**.
  - Dynamic **Fielding Records** tab tracking Catches, Run-Outs, and Stumpings credited to fielders.
  - Targeted CSV export and custom-titled PDF reports reflecting active filters (e.g. *Team: Royal Challengers* or *Match: Team A vs Team B*).
- **Live Scorecard & Dismissal Upgrades:**
  - **Fielder Attribution:** Dedicated field and `＋ Type Fielder Name...` option for Caught, Run-Out, and Stumped dismissals.
  - **Standard Cricket Notation:** Clean representations (`c [Fielder] b [Bowler]`, `c & b [Bowler]`, `run out ([Fielder])`, `st †[Fielder] b [Bowler]`).
  - **Delivery-Free Retired Hurt / Out:** Batter substitutions without burning legal deliveries or adding phantom balls.
  - **Enhanced Wide / No-Ball Presets:** Fast additional bye/run entry (`0`, `1`, `2`, `4`) with automatic strike rotation on odd runs.
- **⚡ Quick Match Mode:**
  - Ad-hoc match fixtures with on-the-spot player enrollment directly on the live crease.
- **Modernized & Simplified Home Dashboard:**
  - Dynamic live match hero with instant "Resume Scoring ⚡" button, 3-tile quick actions, and clean overview metrics.
- **Player Statistics PDF Export:**
  - Complete career batting & bowling tables generated offline via native `@media print`.
- **In-App Auto Backup Vault:**
  - Automatic background recovery snapshots into IndexedDB (`CricScorer_AutoBackup_Vault`) with one-tap restore in Settings.
- **Universal Alphabetical Sorting (A–Z):**
  - All player lists, match squads, and live crease dropdowns sorted alphabetically.
- **Card-Based Squad Selection UI:**
  - Interactive player tiles with cross-team conflict prevention, live search filter, and squad counters.
- **Independent Squad Pool:**
  - Central player registry without forced team associations.
- **Scorecard Contrast:**
  - Dynamic high-contrast numbers for both Light (`#0b3b2e`) and Dark (`#ffffff`) modes.
- **Screen Wake Lock & Haptics:**
  - Screen stay-awake during live matches and tactile vibration feedback.

## Deploy to GitHub Pages:
1. Extract all 7 files directly into the root folder of your GitHub repository.
2. Commit and push:
   ```bash
   git add .
   git commit -m "CricScorer v2.11: team and match stats filters, live scorecard dismissals, and fielder tracking"
   git push origin main
   ```
3. Once deployed, open your GitHub Pages link in Chrome on Android.
