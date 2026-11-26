# CricScorer 🏏

**Professional Offline-First Cricket Scoring & Scorecard Management PWA**

## Updates in this release (v2.38 Pro Suite):
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
   git commit -m "CricScorer v2.38 Pro Suite: full cricket edge cases, charts, MVP, ball log editor, and sharing"
   git push origin main
   ```

## Updates in v2.38 (Home Page UI Upgrade Only):
- **Stadium Welcome Banner:** Clean welcome banner (`Welcome back!`) with subtle floodlight & batter silhouette artwork in CricScorer's existing dark/light theme colors.
- **Featured `LIVE MATCH IN PROGRESS` Card:** Pulsing live dot, format pill (`T20`), SVG team shields, centered score readout, 5-column telemetry grid (`CRR`, `RRR`, `Target`, `Runs Req.`, `Balls Rem.`), and full-width **`▶ Resume Scoring ⚡`** button.
- **4-Tile Quick Actions & 4-Column Summary Metrics:** Quick cards for **Start Match**, **Add Player**, **Add Team**, and **Match History**, plus counters for **Total Matches**, **Teams**, **Players**, and **Completed**.
- **Recent Matches & Top Performers Strip:** Live match badge with **`▶ Resume`** button and a 3-card spotlight for top run-scorers and wicket-takers.
- **Live Scorer Console Preserved:** Kept the Live Scorer layout and functionality completely untouched.

## Updates in v2.38 (Broadcast Scorer Header + Stadium Home UI):
- **Updated Scorer Live Score Header Card:** Features match format & innings label, pulsing `LIVE` badge, SVG team shields (`Batting XI` vs `Bowling XI`), bold centered score readout, 5-column telemetry strip (`CRR`, `RRR`, `Target`, `Runs Req.`, `Balls Rem.`), Powerplay/phase bar, and Chase Win Probability meter.
- **Preserved Existing Scorer Layout:** Kept Live Match Pulse & Commentary, Crease & Bowler dropdowns, Batting/Bowling tables, Partnership bar, Recent Deliveries, and Touch Keypad untouched.
- **Includes Stadium Home Page UI:** Features the Welcome back banner, featured Live Match card, 4-tile Quick Actions, 4-column Summary Metrics, Recent Matches, and Top Performers spotlight.

## Updates in v2.38 (Custom Brand Emblem, Opening Splash Animation & Branded Home Header Card):
- **Opening Splash Animation (`#appSplashOverlay`):** Full-screen dark slate & emerald-bordered launch screen featuring the custom CricScorer emblem (emerald **C** arc + white speed-trail cricket ball) animating into view with a smooth 1.5s transition (or instant tap-to-enter).
- **Branded Home Logo Header Card & Top Navbar Badge:** Replaced the generic emoji icon with the custom vector CricScorer emblem inside both the top navigation bar and the Home Page welcome header card.
- **Updated PWA App Icon (`icon.svg`):** Updated the installable app icon to match the new green-and-white CricScorer emblem.

## Updates in v2.38 (Finalized UI & Interactive Telemetry Header):
- **Clean Top Navigation Bar:** Removed header tagline for clean breathing room, added interactive Parabolic Seam-Ball Trajectory & Boundary Pulse canvas, and replaced emoji theme button with custom SVG Sun/Moon icon.
- **Refined Home Welcome Header Card:** Removed repetitive foreground emblem box while anchoring the translucent animated CricScorer emblem watermark on the left side behind the text alongside right-side stadium floodlights and rotating radar rings.

## Updates in v2.38 (Light Theme Animation Visibility & One-Time Session Splash):
- **High-Contrast Light Theme Animations:** Upgraded the top navigation trajectory canvas (crimson-red leather cricket ball with white seam, deep emerald trajectory arc, and forest-green pitch radar rings) and the Home Welcome Card (mint-emerald stadium backdrop with deep emerald emblem watermark) so all animations remain crisp in Light Mode.
- **One-Time Per-Session Splash Screen:** Added `sessionStorage` tracking (`cricscorer_splash_shown`) so the 1.55s opening launch animation plays only when opening the app for the first time in a session and does not replay on page refreshes.

## Updates in v2.38 (Persistent Tab State Across Refresh & Scorer Extras Restoration):
- **Persistent Active Tab Across Refreshes:** Saved the active view in `sessionStorage` (`cricscorer_active_tab`) and URL hash (`#<tabId>`), restoring the active tab immediately on page reload—including automatically reloading the active `Live` match from IndexedDB when refreshing on the **Scorer** tab.
- **Restored Extras Telemetry in Scorer Header:** Added the **Extras** column to the 6-column Scorer telemetry grid alongside an itemized `(wd, nb, b, lb)` breakdown badge in the phase strip.

## Updates in v2.38 (Extras Breakdown Property Fix):
- **Fixed `undefined` Extras Labels:** Mapped the Scorer Header extras breakdown badge to `CricketEngine.calculateInnings` property keys (`stats.extras.wide`, `stats.extras.noBall`, `stats.extras.bye`, `stats.extras.legBye`, and optional `stats.extras.penalty`).

## Updates in v2.38 (Broadcast On-Screen Event Animations & Scorecard Milestone Badges):
- **Non-Blocking Broadcast Event Animations (`#broadcastFxStage`):** Added full-screen non-blocking celebration stingers with particle bursts for **FOUR (+4)**, **SIX (+6)**, **50 Half-Century**, **100 Century**, and **All 12 Wicket Dismissal Types** (with custom animated SVG graphics for Bowled/Run Out/Stumped/Hit Wicket, LBW 3-red-dot ball tracker, and Caught/Caught & Bowled).
- **Scorecard Milestone & Dismissal Badges:** Added `50★` and `100👑` milestone badges to both the Live Crease batting table and Full Match Scorecard, along with styled dismissal pills.
- **Header `✨ FX: ON/OFF` Toggle:** Added a one-tap toggle in the top navigation bar (saved in `localStorage`) so scorers can mute or enable celebration overlays anytime.

## Updates in v2.38 (Tournament Mode, Points Table & Team/Bowler Broadcast Animations):
- **Home Screen Tournament Mode & Leagues Hub (`#tournaments`):** Create Single Round-Robin, Double Round-Robin, or Knockout tournaments, select or quick-add competing teams, auto-generate fixture schedules, track live **Points Table & Net Run Rate (NRR)**, and launch any scheduled fixture directly into the **Live Scorer** with automatic result syncing.
- **Team Score Milestone Animations (`50`, `100`, `150`, `200`, `250+`):** Automatically fires a broadcast milestone stinger with current run rate whenever the batting side crosses every 50-run milestone.
- **Bowler 5-Wicket Haul (`5W`) & Team All Out Animations:** Celebrates a bowler's 5th wicket with spell figures and unlocks a **`5W🔥`** badge on the bowling scorecard, plus a dramatic **ALL OUT** stinger when the final wicket falls.

## Updates in v2.38 (Supabase Auth, User Profile Setup & Public Live Match Center):
- **Cloud Login & First-Time Profile Setup (`index.html`, `app.js`):** Connected your Supabase project (`fdsvwotdhmvudkwuuceb.supabase.co`) with **1-Tap Google Sign-In**, **Email & Password**, **Magic Link**, and an automatic **Public Profile Setup** modal (Display Name, Role, City/Club) while preserving 100% offline Guest Mode.
- **Offline-First Background Sync:** Every ball continues saving instantaneously to IndexedDB first, then syncs matches, teams, and tournaments to Supabase in the background whenever online.
- **🌍 Public Live Match Center & Real-Time Spectator Links (`#watch=<matchId>`):** Added a shared **Public Live Match Center** on the Home Dashboard plus a **`📤 Share Live`** button in the Scorer header so players and fans can watch ball-by-ball updates live without logging in.

## Updates in v2.38 (1080×1080 HTML5 Canvas Match Posters & Public Tournament Hub Links):
- **1080×1080 Match Summary & MVP Poster Generator (`app.js`, `styles.css`):** Generates high-resolution PNG social graphics with team shields, final scores, result banner, Top Batter, Top Bowler, and Player of the Match (MVP) in both **Stadium Dark** and **Sunlit Emerald** themes, with 1-tap PNG download and WhatsApp Web Share API support.
- **Public Shareable Tournament Hub (`#tournament=<id>`):** Added **`📤 Share Hub`** inside the Tournament view and a read-only `#watch-tournament` spectator view synced via Supabase Realtime so everyone in a tournament group can follow live Points Table, NRR, and fixtures.

## Updates in v2.38 (Orange/Purple Cap Leaderboards, Knockout Seeding, Sync Retry Queue, Live Presence & 24/7 Keep-Alive):
- **Tournament Cap Leaderboards (`🧢 Orange Cap`, `🟣 Purple Cap`, `🌟 MVP`):** Aggregates batting runs, bowling wickets, and impact points across all matches in a tournament (available in both the Organizer Tournament Hub and Public `#tournament=<id>` Hub).
- **1-Click Top-4 Knockout Seeding & Grand Final Generator:** Automatically pairs `#1 vs #4` and `#2 vs #3` into Semi-Finals and advances the winners to the **Grand Final**.
- **Top-Bar Sync Status Pill & IndexedDB Retry Queue (`#syncStatusPill`):** Displays `🟢 Synced`, `🟡 Queued`, or `⚪ Local` and persists offline match updates in IndexedDB until connectivity returns.
- **Live Spectator Presence & Floating Cheers (`#watch=<matchId>`):** Shows live viewer count (`👁️ X watching live`) via Supabase Realtime Presence and lets fans tap floating emoji cheers (`👏`, `🔥`, `🏏`, `💯`).
- **Free 24/7 Keep-Alive Workflow (`.github/workflows/supabase-keepalive.yml`):** Pings your Supabase public `matches` endpoint every 5 days via GitHub Actions so your free backend never pauses.

## Updates in v2.38 (Mobile Top Navigation Bar Responsive Fix):
- **Zero Brand Overlap on Small Viewports (`styles.css`):** Protected `.brand-cluster` with `flex-shrink: 0` and compact mobile scaling (`30px` emblem + `16px` wordmark) so `CricScorer` never collides with the sync status badge.
- **Single-Line Header Pills (`index.html`, `app.js`, `styles.css`):** Enforced `white-space: nowrap` on `.sync-status-pill`, `.cloud-auth-pill`, and `.fx-toggle-btn`, hiding the `: ON/OFF` suffix under `390px` so `✨ FX` stays crisp on a single line alongside a `66px–76px` ellipsized account pill.
- **True Circular Theme Toggle (`styles.css`):** Locked `.theme-svg-btn` to `31×31px` (`34×34px` desktop) with `flex-shrink: 0` and `aspect-ratio: 1 / 1` so the Moon/Sun icon button remains circular across all screen widths.

## Updates in v2.38 (5-Slot Broadcast Floating Bottom Dock & More Hub Drawer):
- **5-Slot Mobile Bottom Navigation Dock (`index.html`, `styles.css`):** Replaced the cramped 9-button horizontal bar with 5 ergonomic thumb targets: **`🏠 Home`**, **`⚡ Scorer`** (with a live pulsing red match beacon dot), a raised center **`＋ New`** action button, **`🏆 Leagues`**, and **`☰ More`**.
- **Slide-Up `☰ More` Hub Drawer (`#moreNavSheet`):** Organizes **`🛡️ Teams`**, **`👤 Players`**, **`📜 History`**, **`📈 Stats`**, **`⚙️ Settings`**, and **`☁️ Cloud Sync`** into a 3×2 tactile bottom sheet with automatic active state highlighting (`app.js`).

## Updates in v2.38 (2nd-Innings Chase Bar, Over Runs Tally, Live Ticker Shimmer & Desktop Split View):
- **2nd-Innings Chase & RRR Progress Bar (`app.js`, `styles.css`):** Displays `Need X runs in Y balls · RRR` with a dynamic pressure-colored progress bar inside the Live Scorer hero card.
- **Current Over Tally & Color-Coded Ball Strip (`app.js`, `styles.css`):** Adds a `This Over: X runs` badge alongside distinct dot-ball (`·`), boundary (`4`/`6`), extra, and wicket (`W`) pills.
- **Horizontal Snap-Scroll Public Live Ticker & Skeleton Shimmer (`index.html`, `styles.css`, `app.js`):** Renders public cloud matches in a smooth horizontal snap-scrolling ticker with stadium skeleton shimmer cards while loading.
- **Desktop & Wide-Screen Split-View Layout (`styles.css`, `app.js`):** Arranges the Live Scorer into a two-column split layout (`≥960px`) with a centered floating bottom dock.

## Updates in v2.38 (Co-Scorer Handover PIN, DLS Overs Revision, 8-Zone Wagon Wheel & Free PWA/Android APK Install):
- **Co-Scorer 4-Digit Handover PIN (`app.js`, `styles.css`):** Generates a 4-digit match PIN (`🔑 Handover PIN`) so a teammate on the field can claim live scoring control on their own phone without sharing account credentials.
- **DLS / Rain-Curtailed Overs & Target Revision (`app.js`):** Allows adjusting total match overs mid-innings (`🌧️ DLS / Revise Overs`) with automatic pro-rata target calculation or custom target override.
- **8-Zone Boundary Wagon Wheel (`app.js`, `styles.css`):** Optional toggle (`🎯 Shot Wheel: ON/OFF`) that tags boundary shot zones (`4`s and `6`s) and plots an interactive circular ground wagon wheel inside the Detailed Scorecard.
- **Smart PWA Install Banner & Free Android APK Guide (`index.html`, `app.js`):** Captures `beforeinstallprompt` for 1-tap home-screen installation and provides a $0 PWABuilder Android `.apk` packaging guide in Settings.

## Updates in v2.38 (Radial SVG Cricket Ground Wagon Wheel & High-Contrast Match-Day Tools):
- **Circular Radial 8-Sector SVG Ground Wagon Wheel Picker (`app.js`, `styles.css`):** Replaced the rectangular button box with a true circular stadium SVG divided into 8 clickable pizza-slice ground sectors (`Long-Off`, `Cover`, `Point`, `Third Man`, `Fine Leg`, `Square Leg`, `Mid-Wicket`, `Long-On`) around a central pitch strip with live ray preview and `Skip Zone` support.
- **High-Contrast `🛠️ Match-Day Tools` 3-Tile Control Bar (`app.js`, `styles.css`):** Placed 3 prominent, self-explanatory tiles (`🔑 Share PIN`, `🌧️ DLS / Overs`, and `🎯 Shot Wheel`) directly below the Live Scorer hero card so first-time scorers immediately see and understand every match-day control.

## Updates in v2.38 (Custom Ground Rules CRUD, Automatic Free Hit, Transparent YouTube/OBS Overlay & Player Career Profiles):
- **Custom Gully / Box Ground Rules Manager (`app.js`, `styles.css`):** Add, edit, delete, and toggle custom local ground rules (`Last Man Stands`, `Box Roof / Back-Wall Bonus`, `Wicket Run Penalty`, or custom bonus/penalty run actions) with live quick-trigger buttons inside the Live Scorer.
- **Automatic Free Hit Banner & Dismissal Enforcement (`app.js`, `styles.css`):** Automatically displays a glowing `🔥 FREE HIT ACTIVE` banner after any No-Ball (`NB`) and restricts dismissals on the next ball to Run Out / Stumped / Hit Ball Twice.
- **Transparent YouTube / OBS Live Stream Overlay (`#overlay=<matchId>`):** Provides a transparent lower-third TV scoreboard bug (`📺 OBS Overlay`) synced in real time via Supabase for OBS Studio and PRISM Live Studio streams.
- **Player Career Milestones, Duplicate Merge & 1080×1080 Career Card (`index.html`, `app.js`):** Displays career totals and milestone pills (`500+ Runs`, `1,000+ Runs Club`, `25+ Wickets`), merges duplicate player records (`🔀 Merge`), and generates downloadable 1080×1080 PNG player career cards (`🪪 Card`).

## Updates in v2.38 (Pre-Match 3D Coin Toss, Pitch Conditions Card & Match-Day Player RSVP / Playing XI):
- **Interactive 3D Coin Toss & Pitch Conditions (`index.html`, `app.js`, `styles.css`):** Adds `🪙 Flip 3D Coin Toss` (`HEADS / TAILS` spin animation) and a Ground & Pitch Conditions selector (`Flat Batting Track`, `Dew Factor`, `Green Top`, `Slow / Spin Track`, `Turf / Box Arena`) on the Create Match screen, displaying a live toss & pitch banner inside the Scorer hero.
- **Match-Day Player RSVP & WhatsApp Playing XI Generator (`#rsvp-hub` / `#rsvp=<teamId>`):** Lets captains track `IN / MAYBE / OUT` attendance, tag Captain `(C)` and Keeper `(WK)`, copy a formatted WhatsApp Playing XI message (`💬 Copy XI`), and download a `1080×1080` Playing XI Lineup Card PNG (`🪪 XI Card`).

## Updates in v2.38 (Bright / Light Theme High-Contrast Wagon Wheel Fix):
- **Daylight Stadium Turf & Sector Labels (`app.js`, `styles.css`):** Updated both the 8-sector radial Shot Wheel picker and the Scorecard Wagon Wheel summary to detect `data-theme="light"`, rendering high-contrast daylight greens (`#dcfce7` / `#bbf7d0`), crisp dark slate sector labels (`#0f172a`) with white halo outlines, and distinct boundary ray colors (`#0284c7` for 4s and `#059669` for 6s).
