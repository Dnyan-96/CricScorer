# CricScorer 🏏

**Professional Offline-First Cricket Scoring & Scorecard Management PWA**

## Updates in this release (v2.19 Pro Suite):
- **Complete Cricket Dismissal & Delivery Edge Cases:**
  - Record **Completed Runs (`0`–`3`)**, **Delivery Type (`Legal`, `Wide +1`, `No-Ball +1`)**, and **Batters Crossed** directly inside the Wicket Modal.
  - **Retired Hurt Return:** Batters marked Retired Hurt can return to bat later in the innings.
  - **Auto All-Out & Overs-Complete Detection + Innings Declaration:** Prompts automatically when all wickets fall or scheduled overs complete, plus a **Declare** option for Test matches.
  - **Super Over Tie-Breaker:** Prompts to start a 1-Over Super Over when Innings 1 and Innings 2 end tied.
- **Visual Analytics, Live Partnership & Win Probability:**
  - **SVG Manhattan & Worm Charts:** Runs-per-over bar chart (with red wicket markers) and cumulative run progression graph rendered offline inside the Full Scorecard.
  - **Live Partnership Tracker & Bowler Quota Cap Warning:** Active partnership strip below the crease table and `⚠️ Quota Reached` alerts.
  - **Chase Win Probability Meter:** Dynamic 2nd-innings probability bar factoring runs needed, balls left, and wickets in hand.
  - **Player of the Match (MVP) Auto-Calculator:** Weighted MVP points calculation with a **🏆 Player of the Match** banner on scorecards.
- **Tournament Grouping, Ball Log Editor & WhatsApp Sharing:**
  - **Tournament / Series Grouping:** Optional series name in Match Setup and Series filter in the Stats tab.
  - **Over-by-Over Ball Log Editor (`📝 Edit Log`):** Edit runs or delete any delivery in the current innings with instant scorecard recalculation.
  - **One-Tap WhatsApp / Web Share Summary (`📲 Share`):** Formatted text scorecard sharing via native share sheet or clipboard.

## Deploy to GitHub Pages:
1. Extract all 7 files directly into the root folder of your GitHub repository.
2. Commit and push:
   ```bash
   git add .
   git commit -m "CricScorer v2.19 Pro Suite: full cricket edge cases, charts, MVP, ball log editor, and sharing"
   git push origin main
   ```

## Updates in v2.19 (Home Page UI Upgrade Only):
- **Stadium Welcome Banner:** Clean welcome banner (`Welcome back!`) with subtle floodlight & batter silhouette artwork in CricScorer's existing dark/light theme colors.
- **Featured `LIVE MATCH IN PROGRESS` Card:** Pulsing live dot, format pill (`T20`), SVG team shields, centered score readout, 5-column telemetry grid (`CRR`, `RRR`, `Target`, `Runs Req.`, `Balls Rem.`), and full-width **`▶ Resume Scoring ⚡`** button.
- **4-Tile Quick Actions & 4-Column Summary Metrics:** Quick cards for **Start Match**, **Add Player**, **Add Team**, and **Match History**, plus counters for **Total Matches**, **Teams**, **Players**, and **Completed**.
- **Recent Matches & Top Performers Strip:** Live match badge with **`▶ Resume`** button and a 3-card spotlight for top run-scorers and wicket-takers.
- **Live Scorer Console Preserved:** Kept the Live Scorer layout and functionality completely untouched.
