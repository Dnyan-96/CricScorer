# CricScorer 🏏

**Professional Offline-First Cricket Scoring & Scorecard Management PWA**

## Updates in this release (v2.9):
- **Modernized & Simplified Home Dashboard:**
  - **Dynamic Match Hero:** Automatically detects live matches in progress and displays current batting score, overs, and an instant "Resume Scoring ⚡" button.
  - **Match Center Welcome Card:** Shows a clean action banner when no match is live.
  - **3-Tile Quick Action Grid:** Direct touch shortcuts for **Start Match**, **Add Player**, and **Add Team**.
  - **Clean Metrics Strip:** Streamlined 3-pill overview (Total Matches, Teams, Squad Players).
  - **Modern Matchday Cards:** Card-based list for recent matches with status badges, date, overs, and results.
- **Player Statistics PDF Export:**
  - One-tap "📄 Export PDF" in the Statistics tab with complete batting & bowling career records.
  - 100% offline using native browser Print-to-PDF (`@media print`).
- **In-App Auto Backup Vault:**
  - Automatic background recovery snapshots into IndexedDB (`CricScorer_AutoBackup_Vault`).
  - One-tap "Restore Snapshot" button directly in Settings.
- **Alphabetical Sorting (A–Z):**
  - Universal alphabetical sorting across player registry, match squads, and live crease dropdowns.
- **Card-Based Squad Selection UI:**
  - Interactive player cards with cross-team conflict prevention, live search filter, and squad counters.
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
   git commit -m "CricScorer v2.9: modern simplified dashboard with dynamic live hero and quick-action tiles"
   git push origin main
   ```
3. Once deployed, open your GitHub Pages link in Chrome on Android.
