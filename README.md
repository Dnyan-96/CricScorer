# CricScorer 🏏

**Professional Offline-First Cricket Scoring & Scorecard Management PWA**

## Updates in this release (v2.13):
- **Team-Wise & Match-Wise Statistics Filtering:**
  - Three synchronized filters in the Statistics tab: **Format**, **Team**, and individual **Match Fixture**.
  - Dynamic **Fielding Records** tab tracking Catches, Run-Outs, and Stumpings credited to fielders.
  - Targeted CSV export and custom-titled PDF reports reflecting active filters (e.g. *Team: Royal Challengers* or *Match: Team A vs Team B*).
- **Live Scorecard & Dismissal Upgrades:**
  - **Fielder Attribution:** Fielder dropdown and inline `＋ Type Fielder Name...` option for Caught, Run-Out, and Stumped dismissals.
  - **Standard Cricket Notation:** Clean representations (`c [Fielder] b [Bowler]`, `c & b [Bowler]`, `run out ([Fielder])`, `st †[Fielder] b [Bowler]`).
  - **Delivery-Free Retired Hurt / Out:** Batter substitutions at the crease without consuming legal deliveries or charging the bowler.
  - **Enhanced Wide / No-Ball Presets:** Fast additional bye/run entry (`0`, `1`, `2`, `4`) with automatic strike rotation on odd runs.
- **⚡ Quick Match Mode:**
  - Ad-hoc match fixtures with on-the-spot player enrollment directly on the live crease.
- **Modernized Home Dashboard & Auto Backup Vault:**
  - Clean dashboard with active match hero, 3-tile quick actions, and automatic background IndexedDB snapshots.

## Deploy to GitHub Pages:
1. Extract all 7 files directly into the root folder of your GitHub repository.
2. Commit and push:
   ```bash
   git add .
   git commit -m "CricScorer v2.13: team/match stats filters, fielder tracking, and delivery-free retired out"
   git push origin main
   ```
3. Once deployed, open your GitHub Pages link in Chrome on Android.
