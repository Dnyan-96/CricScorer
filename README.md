# CricScorer 🏏

**Professional Offline-First Cricket Scoring & Scorecard Management PWA**

## Updates in this release (v2.6):
- **Alphabetical Player Sorting (A–Z):**
  - **Player Registry:** Sorted alphabetically from A to Z.
  - **Match Squad Selection:** Team A and Team B card selection tiles listed alphabetically.
  - **Live Scoreboard Dropdowns:** Striker, Non-Striker, and Bowler selectors sorted alphabetically.
  - **In-Game Modals:** Incoming batter selection and Change Bowler modal lists sorted alphabetically.
- **Card-Based Squad Selection UI:**
  - Responsive player tiles with cross-team conflict prevention (`(In Team A)` / `(In Team B)`).
  - Real-time search filter and quick "All" / "Clear" squad actions.
- **Independent Squad Pool:** Register players without being locked into a team.
- **Scorecard Contrast Fix:** High-contrast scorecard digits in Light mode (deep green `#0b3b2e`) and Dark mode (clean white `#ffffff`).
- **Backup & Restore in Settings:** Direct access to JSON Export, Restore, and Clear Data in the Settings menu.
- **Screen Wake Lock & Haptics:** Screen stay-awake during scoring and tactile feedback on touches, boundaries, and wickets.
- **Minimal Icon:** Clean vector cricket ball icon (`icon.svg`).

## Deploy to GitHub Pages:
1. Extract all 7 files directly into the root folder of your GitHub repository.
2. Commit and push:
   ```bash
   git add .
   git commit -m "CricScorer v2.6: alphabetical player sorting across registry, squads, and live dropdowns"
   git push origin main
   ```
3. Once deployed, open your GitHub Pages link in Chrome on Android.
