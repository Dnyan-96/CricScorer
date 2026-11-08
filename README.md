# CricScorer 🏏

**Professional Offline-First Cricket Scoring & Scorecard Management PWA**

## Updates in this release (v2.7):
- **In-App Auto Backup Vault:**
  - Automatically captures recovery snapshots into local IndexedDB storage (`CricScorer_AutoBackup_Vault`).
  - Triggers in the background on match saves, completed matches, delivery tracking, and squad updates.
  - One-tap "Restore Snapshot" button directly in Settings.
  - Manual JSON Export, File Restore, and Clear Data options remain completely unchanged.
- **Alphabetical Sorting (A–Z):**
  - Player registry, match squad selection, live crease dropdowns, and dismissal modals sorted alphabetically.
- **Card-Based Squad Selection UI:**
  - Conflict prevention tiles (`(In Team A)` / `(In Team B)`), live search filtering, and squad counters.
- **Independent Squad Pool:**
  - Register players without forced team associations; dynamically assign playing XIs on match day.
- **Scorecard Contrast:**
  - Dynamic high-contrast digits for both Light (`#0b3b2e`) and Dark (`#ffffff`) modes.
- **Screen Wake Lock & Haptics:**
  - Screen stay-awake during live matches and tactile vibration feedback.

## Deploy to GitHub Pages:
1. Extract all 7 files directly into the root folder of your GitHub repository.
2. Commit and push:
   ```bash
   git add .
   git commit -m "CricScorer v2.7: in-app local auto backup vault with one-tap restore"
   git push origin main
   ```
3. Once deployed, open your GitHub Pages link in Chrome on Android.
