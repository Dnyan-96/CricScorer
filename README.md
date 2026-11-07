# CricScorer 🏏

**Professional Offline-First Cricket Scoring & Scorecard Management PWA**

## Updates in this release (v2.5):
- **Modern Squad Selection Cards:**
  - Responsive, card-based selection tiles for choosing players during Match Creation.
  - Automatic cross-team conflict prevention: selecting a player in Team A automatically disables them in Team B with an "(In Team A)" indicator.
  - Live search filter (`Filter players by name or role...`) to quickly locate players.
  - Real-time squad counter badges with instant "All" and "Clear" shortcut buttons.
- **Independent Squad Pool:** Register players without team constraints. Assign players dynamically to teams for each fixture.
- **Scorecard Numbers Visibility:** High-contrast scorecard digits in Light mode (deep green `#0b3b2e`) and Dark mode (clean white `#ffffff`).
- **Backup & Restore inside Settings:** Direct access to JSON Export, Restore, and Reset from the Settings menu.
- **Screen Wake Lock & Haptics:** Screen stay-awake during live matches and tactile feedback on touches, boundaries, and wickets.
- **Modern Minimal Icon:** High-visibility cricket ball vector icon (`icon.svg`).

## Deploy to GitHub Pages:
1. Extract all 7 files directly into the root folder of your GitHub repository.
2. Commit and push:
   ```bash
   git add .
   git commit -m "CricScorer v2.5: modern squad selection tiles, conflict prevention, search filter"
   git push origin main
   ```
3. Once deployed, open your GitHub Pages link in Chrome on Android.
