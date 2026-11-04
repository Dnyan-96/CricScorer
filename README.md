# CricScorer 2.0 🏏

**Professional Offline-First Cricket Scoring & Scorecard Management PWA**

Production-grade upgrade from v1 (`LocalCricket`) to v2.0, preserving all existing user teams, players, and match records while delivering a complete mobile scoring engine.

---

## ⚡ Core Features in v2.0

1. **Safe Database Migration:**
   - Automatically migrates existing records from `LocalCricketDB` v1 to v2.
   - Zero data loss: Preserves all historical teams, players, and fixtures.
2. **Deterministic Cricket Scoring Engine:**
   - 100% decoupled from the UI.
   - Real-time event sourcing replay for batting strike rates, bowling economies, maidens, and fall of wickets.
   - Handles all **12 dismissal types** (Bowled, Caught, LBW, Stumped, Run Out, Hit Wicket, Retired Hurt, etc.).
   - Accurate extras accounting (Wides, No-Balls, Byes, Leg-Byes, Penalty runs).
   - Automatic striker rotation on odd runs, over completions, and wickets.
3. **9 Complete Navigation Sections:**
   - **Dashboard:** Live match alerts, stat cards, top run scorers, top wicket takers.
   - **Live Scorer:** One-hand ergonomic mobile keypad (0-6, extras, dismissals, swap strike, change bowler, undo).
   - **Create Match:** T20, T10, ODI, Test, and Custom match configurations with Playing Squad selectors.
   - **Teams:** Roster directory, home grounds, and player counts.
   - **Players:** Complete player registry with batting & bowling styles.
   - **Match History:** Full search, filter, and detailed modal scorecards.
   - **Statistics:** Career leaderboards (Batting, Bowling, Fielding) with CSV export.
   - **Settings:** Dark/Light theme toggle, default match format, and IndexedDB storage inspector.
   - **Backup & Restore:** Full versioned JSON backup and restoration.

---

## 🚀 How to Deploy on GitHub Pages from Android

1. Open your GitHub account on your mobile browser (or computer) and go to your repository.
2. Upload the files:
   - `index.html`
   - `styles.css`
   - `app.js`
   - `manifest.webmanifest`
   - `sw.js`
   - `icon.svg`
3. Go to **Settings** → **Pages**.
4. Under **Branch**, select `main` and root folder `/`, then click **Save**.
5. Once deployed, open the live link in **Google Chrome** on Android.
6. Tap the Chrome three-dot menu (⋮) → **Install app** or **Add to Home screen**.
