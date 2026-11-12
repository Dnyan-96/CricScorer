# CricScorer 🏏

**Professional Offline-First Cricket Scoring & Scorecard Management PWA**

## Updates in this release (v2.14):
- **Modern Touch-Chip Pop-Up Modals:**
  - Replaced browser `prompt()` pop-ups for **WD**, **NB**, **BYE**, **LB**, and **Add Player On-The-Fly** with sleek native modals featuring one-tap run tiles (`+0`, `+1`, `+2`, `+3`, `+4`, `+6`), live total-run previews, and No-Ball run attribution toggles (Batter vs Byes).
- **Broadcast-Style Scorecard Template:**
  - Added mid-match **📋 Scorecard** quick access inside the Live Scorer.
  - Added **Toss Summary**, itemized **Extras Breakdown** (`wd`, `nb`, `b`, `lb`), **Innings Total & Run Rate**, **Did Not Bat (DNB)** roster separation, **Fall of Wickets (FoW)** progression, and expanded **Bowling Figures** (`O | M | R | W | WD | NB | ECON`) with maiden over tracking.
- **Team-Wise & Match-Wise Statistics Filtering:**
  - Three synchronized filters in the Statistics tab (**Format**, **Team**, **Match**) with targeted CSV & PDF exports.
- **Live Scorecard Dismissals & Fielder Attribution:**
  - Fielder selection and inline `＋ Type Fielder Name...` for Caught, Run-Out, and Stumped dismissals, plus delivery-free Retired Hurt / Out handling.

## Deploy to GitHub Pages:
1. Extract all 7 files directly into the root folder of your GitHub repository.
2. Commit and push:
   ```bash
   git add .
   git commit -m "CricScorer v2.14: modern extras modals and broadcast scorecard template"
   git push origin main
   ```
