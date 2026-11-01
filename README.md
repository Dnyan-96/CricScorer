# LocalCricket 1.0

An offline-first cricket scorecard and live scoring Progressive Web App. No account, server, or cloud database is used. Data is stored in the browser on the device using IndexedDB.

## Features
- Team and player create/edit/delete with player roles
- Match setup with overs, date, venue, toss and bat/bowl decision
- Playing XI selection for both teams
- Ball-by-ball scoring for 0–6, wides, no-balls, byes and leg-byes
- Wicket recording: bowled, caught, LBW, stumped, hit wicket, run out, retired hurt, obstructing the field
- Batter selection, incoming batter, manual strike swap and bowler selection
- Automatic legal-ball counting, over-end strike change, innings limits and all-out detection
- Batting and bowling summaries, extras breakdown, recent deliveries and match scorecard
- Undo last delivery and correction of the latest delivery
- Match history and result summary
- JSON backup export/import
- Installable PWA and offline cache

## Deploy from Android with GitHub Pages
1. Create a new public repository named `LocalCricket-Fresh` on GitHub.
2. Open the repository in Chrome and choose **Add file → Upload files**.
3. Upload all files in this folder (including `index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.webmanifest`, and `icon.svg`). Commit the upload.
4. In repository **Settings → Pages**, choose **Deploy from a branch**, branch `main`, folder `/ (root)`, then Save.
5. Wait for the Pages deployment to finish. Open `https://YOUR-GITHUB-USERNAME.github.io/LocalCricket-Fresh/` in Chrome.
6. In Chrome menu choose **Install app** or **Add to Home screen**.

## Important scoring notes
- A wide and no-ball add one penalty run plus the additional runs entered. They do not count as legal balls. Byes and leg-byes count as legal balls and are not charged to the bowler.
- The scorer asks for completed runs on extras so strike rotation can be recorded. For ordinary run scoring, batter runs are used for rotation.
- Bowler changes are allowed at the end of an over. Choose a bowler before the first delivery.
- A match result is calculated from the two innings totals. This is a practical scorekeeping baseline, not a certified Laws-of-Cricket umpiring system.

## Storage and backup
Data remains in the browser profile on the device. Export backups regularly and before clearing Chrome site data or changing devices. Import replaces the current local data.

## Testing
Run `node --check app.js` for JavaScript syntax validation. Test actual scoring and PWA installation in Chrome on the target Android device before using it for an official match. This build has not been independently certified against every MCC playing condition or tournament-specific rule.
