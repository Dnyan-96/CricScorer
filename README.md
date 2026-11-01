# LocalCricket — Fresh GitHub Pages project

A static, installable cricket team and match manager. It uses IndexedDB in the browser; there is no backend, account, or cloud database.

## Files to upload
Upload the six files in this folder directly to the **root** of a new GitHub repository:
- `index.html`
- `styles.css`
- `app.js`
- `manifest.webmanifest`
- `sw.js`
- `icon.svg`

## Publish with GitHub Pages (Android-friendly)
1. Create a new public repository, for example `LocalCricket-Fresh`.
2. Upload the six files above to the repository root (not inside another folder).
3. Open **Settings → Pages**.
4. Under **Build and deployment**, select **Deploy from a branch**.
5. Select branch `main` and folder `/ (root)`, then Save.
6. Wait for the Pages deployment to finish. Open the published URL in Chrome on Android.
7. In Chrome, open the three-dot menu and choose **Add to Home screen** or **Install app**.

## Important data note
Match data is stored only in the browser on the device that entered it. Use the app's Backup & restore page to download a JSON backup regularly. Clearing browser site data or changing to a different site URL can make locally stored data unavailable.

## Current features
- Create and manage teams and players.
- Create fixtures and match records.
- Live ball entry with batter, non-striker, bowler, runs, extras and dismissal selection.
- Automatic score, wickets, legal-ball count, overs and run rate.
- Manual strike swap and undo last delivery.
- Basic batting and bowling figures and scorecard view.
- Local JSON backup and restore.

This is a fresh static web package. Test a sample match and backup/restore before using it for official scoring. Cricket edge cases (for example, complex run-out/no-ball combinations and detailed bowling figures) should be validated against your scoring rules.
