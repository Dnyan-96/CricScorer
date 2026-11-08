# CricScorer 🏏

**Professional Offline-First Cricket Scoring & Scorecard Management PWA**

## Updates in this release (v2.10):
- **⚡ Quick Match Mode (Random / Street Teams with Ad-hoc Players):**
  - **Match Creation Toggle:** Switch between **Full Squad Match** (standard pre-selected squads) and **Quick Match** (zero squad selection needed).
  - **On-the-Spot Player Enrollment:** Select or type Striker, Non-Striker, and Bowler directly on the live crease without prior registration.
  - **Smart Player Name Reuse:** Typing a player name automatically links to an existing profile if already saved in the database, preventing duplicates.
  - **Ad-hoc Wicket Dismissals:** Supports typing a brand-new incoming batter on the fly when wickets fall.
  - **Scoring Guard Rails:** Clear alerts guiding the scorer to assign active crease players before logging deliveries.
- **Modernized & Simplified Home Dashboard:**
  - Dynamic live match hero with instant "Resume Scoring ⚡" button, 3-tile quick actions, and clean overview metrics.
- **Player Statistics PDF Export:**
  - One-tap "📄 Export PDF" in the Statistics tab with career batting & bowling tables (100% offline via native `@media print`).
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
   git commit -m "CricScorer v2.10: Quick Match mode with on-the-spot player enrollment"
   git push origin main
   ```
3. Once deployed, open your GitHub Pages link in Chrome on Android.
