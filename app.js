/**
 * CricScorer 2.0 - Core Application & Native IndexedDB Engine
 * 100% Native IndexedDB | Zero External DB Dependencies | Safe v1->v2 Migration
 */

const DB_NAME = 'LocalCricketDB';
const DB_VERSION = 2; // Upgraded version for CricScorer 2.0

let db = null;
let activeMatch = null;
let currentStatsTab = 'batting';

// ==========================================
// 1. DATABASE INITIALIZATION & MIGRATIONS
// ==========================================

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const dbInstance = event.target.result;
      const oldVersion = event.oldVersion;
      const tx = event.target.transaction;
      console.log(`[DB] Upgrading schema from v${oldVersion} to v${DB_VERSION}`);

      // Store 1: teams
      if (!dbInstance.objectStoreNames.contains('teams')) {
        const teamStore = dbInstance.createObjectStore('teams', { keyPath: 'id' });
        teamStore.createIndex('name', 'name', { unique: false });
        teamStore.createIndex('created', 'created', { unique: false });
      }

      // Store 2: players
      if (!dbInstance.objectStoreNames.contains('players')) {
        const playerStore = dbInstance.createObjectStore('players', { keyPath: 'id' });
        playerStore.createIndex('teamId', 'teamId', { unique: false });
        playerStore.createIndex('name', 'name', { unique: false });
      }

      // Store 3: matches
      if (!dbInstance.objectStoreNames.contains('matches')) {
        const matchStore = dbInstance.createObjectStore('matches', { keyPath: 'id' });
        matchStore.createIndex('status', 'status', { unique: false });
        matchStore.createIndex('created', 'created', { unique: false });
      }

      // Store 4: deliveries (Event-sourcing stream for v2.0)
      if (!dbInstance.objectStoreNames.contains('deliveries')) {
        const delivStore = dbInstance.createObjectStore('deliveries', { keyPath: 'id' });
        delivStore.createIndex('matchId', 'matchId', { unique: false });
        delivStore.createIndex('inningsIndex', 'inningsIndex', { unique: false });
      }

      // Store 5: settings
      if (!dbInstance.objectStoreNames.contains('settings')) {
        dbInstance.createObjectStore('settings', { keyPath: 'key' });
      }

      // Store 6: auditLogs
      if (!dbInstance.objectStoreNames.contains('auditLogs')) {
        const auditStore = dbInstance.createObjectStore('auditLogs', { keyPath: 'id' });
        auditStore.createIndex('matchId', 'matchId', { unique: false });
        auditStore.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };

    request.onsuccess = (event) => {
      db = event.target.result;
      console.log('[DB] LocalCricketDB v2 connection open.');
      resolve(db);
    };

    request.onerror = (event) => {
      console.error('[DB Error]', event.target.error);
      reject(event.target.error);
    };

    request.onblocked = () => {
      alert('Database upgrade blocked. Please close any other open tabs running CricScorer.');
    };
  });
}

// Low-level DB Helpers
function dbGetAll(storeName) {
  return new Promise((res, rej) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  });
}

function dbPut(storeName, item) {
  return new Promise((res, rej) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(item);
    tx.oncomplete = () => res(item);
    tx.onerror = () => rej(tx.error);
  });
}

function dbDelete(storeName, id) {
  return new Promise((res, rej) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(id);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

function generateId() {
  return (typeof crypto !== 'undefined' && crypto.randomUUID) 
    ? crypto.randomUUID() 
    : 'cs_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
}

function showToast(msg) {
  const el = document.getElementById('toastNotification');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2400);
}

function escapeHTML(str = '') {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ==========================================
// 2. CRICKET SCORING CALCULATION ENGINE
// ==========================================

// ==========================================
// DISMISSAL NOTATION FORMATTER
// ==========================================

function formatDismissalText(btr, bowlersMap = {}, fieldersMap = {}) {
  if (!btr || !btr.isOut) return 'not out';

  const blrName = btr.dismissalBowlerId ? (bowlersMap[btr.dismissalBowlerId] || 'Bowler') : '';
  const fdrName = btr.dismissalFielderId ? (fieldersMap[btr.dismissalFielderId] || 'Fielder') : '';

  switch (btr.dismissal) {
    case 'bowled':
      return `b ${blrName}`;
    case 'caught':
      return (fdrName && fdrName !== blrName) ? `c ${fdrName} b ${blrName}` : `c & b ${blrName}`;
    case 'caughtAndBowled':
      return `c & b ${blrName}`;
    case 'lbw':
      return `lbw b ${blrName}`;
    case 'stumped':
      return fdrName ? `st †${fdrName} b ${blrName}` : `st b ${blrName}`;
    case 'runOut':
      return fdrName ? `run out (${fdrName})` : 'run out';
    case 'hitWicket':
      return `hit wicket b ${blrName}`;
    case 'retiredHurt':
      return 'retired not out';
    case 'retiredOut':
      return 'retired out';
    case 'obstructingTheField':
      return 'obstructing the field';
    case 'hitBallTwice':
      return 'hit ball twice';
    case 'timedOut':
      return 'timed out';
    default:
      return btr.dismissal || 'out';
  }
}

class CricketEngine {
  /**
   * Replays all deliveries in an innings to compute batting, bowling, fall of wickets, extras, and total.
   */
  static calculateInnings(innings, squadList = [], bowlingSquadList = []) {
    const batters = {};
    const bowlers = {};
    const fallOfWickets = [];
    const extras = { wide: 0, noBall: 0, bye: 0, legBye: 0, penalty: 0, total: 0 };
    
    // Seed squads
    squadList.forEach(p => {
      batters[p.id] = { id: p.id, name: p.name, runs: 0, balls: 0, fours: 0, sixes: 0, isOut: false, dismissal: 'not out', dismissalInfo: null };
    });
    bowlingSquadList.forEach(p => {
      bowlers[p.id] = { id: p.id, name: p.name, legalBalls: 0, runsConceded: 0, wickets: 0, maidens: 0, wides: 0, noBalls: 0 };
    });

    let totalRuns = innings.base?.runs || 0;
    let totalWickets = innings.base?.wickets || 0;
    let legalDeliveries = innings.base?.legal || 0;

    const balls = innings.balls || [];

    balls.forEach((ball, idx) => {
      const strikerId = ball.batterId;
      const nonStrikerId = ball.nonStrikerId;
      const bowlerId = ball.bowlerId;

      if (!batters[strikerId]) {
        batters[strikerId] = { id: strikerId, name: ball.strikerName || 'Batter', runs: 0, balls: 0, fours: 0, sixes: 0, isOut: false, dismissal: 'not out' };
      }
      if (nonStrikerId && !batters[nonStrikerId]) {
        batters[nonStrikerId] = { id: nonStrikerId, name: ball.nonStrikerName || 'Non-Striker', runs: 0, balls: 0, fours: 0, sixes: 0, isOut: false, dismissal: 'not out' };
      }
      if (bowlerId && !bowlers[bowlerId]) {
        bowlers[bowlerId] = { id: bowlerId, name: ball.bowlerName || 'Bowler', legalBalls: 0, runsConceded: 0, wickets: 0, maidens: 0, wides: 0, noBalls: 0 };
      }

      const btr = batters[strikerId];
      const blr = bowlerId ? bowlers[bowlerId] : null;

      const isWide = ball.extraType === 'wide';
      const isNoBall = ball.extraType === 'noBall';
      const isBye = ball.extraType === 'bye';
      const isLegBye = ball.extraType === 'legBye';
      const isPenalty = ball.extraType === 'penalty';
      const isLegal = !isWide && !isNoBall && !isPenalty;

      // Batting stats
      if (!isWide && !isPenalty) {
        btr.balls += 1;
      }
      btr.runs += (ball.batRuns || 0);
      if (ball.batRuns === 4) btr.fours += 1;
      if (ball.batRuns === 6) btr.sixes += 1;

      // Bowler stats
      if (blr && isLegal) {
        blr.legalBalls += 1;
        legalDeliveries += 1;
      }

      // Extras Accounting
      const extraCount = ball.extraTotal || (ball.extraRuns + (isWide || isNoBall ? 1 : 0)) || 0;
      if (isWide) { extras.wide += extraCount; if (blr) blr.wides += 1; }
      if (isNoBall) { extras.noBall += extraCount; if (blr) blr.noBalls += 1; }
      if (isBye) extras.bye += extraCount;
      if (isLegBye) extras.legBye += extraCount;
      if (isPenalty) extras.penalty += extraCount;
      extras.total += extraCount;

      // Bowler Conceded Runs: bat runs + wide runs + noBall runs (byes/legbyes/penalty NOT charged to bowler)
      if (blr) {
        if (isWide || isNoBall) {
          blr.runsConceded += (ball.batRuns + extraCount);
        } else if (!isBye && !isLegBye && !isPenalty) {
          blr.runsConceded += ball.batRuns;
        }
      }

      // Team total
      const deliveryTotal = (ball.batRuns || 0) + extraCount;
      totalRuns += deliveryTotal;

      // If a previously retired-hurt batter resumes batting on a later delivery, clear retiredHurt flag
      if (btr && btr.isRetiredHurt) {
        btr.isRetiredHurt = false;
        btr.dismissal = 'not out';
      }
      if (nonStrikerId && batters[nonStrikerId] && batters[nonStrikerId].isRetiredHurt) {
        batters[nonStrikerId].isRetiredHurt = false;
        batters[nonStrikerId].dismissal = 'not out';
      }

      // Wickets & Dismissals (including Retired Hurt / Out)
      if (ball.wicket && ball.dismissal !== 'none') {
        const outPlayerId = ball.wicketPlayerId || strikerId;
        const outPlayer = batters[outPlayerId] || btr;
        const isRetHurt = (ball.dismissal === 'retiredHurt');
        outPlayer.isOut = !isRetHurt;
        outPlayer.isRetiredHurt = isRetHurt;
        outPlayer.dismissal = ball.dismissal;
        outPlayer.dismissalInfo = ball.dismissalDetails || null;
        outPlayer.dismissalBowlerId = bowlerId;
        outPlayer.dismissalFielderId = ball.dismissalDetails?.fielderId || null;

        if (!isRetHurt) {
          totalWickets += 1;

          const bowlerCredited = ['bowled', 'caught', 'caughtAndBowled', 'lbw', 'stumped', 'hitWicket'];
          if (blr && bowlerCredited.includes(ball.dismissal)) {
            blr.wickets += 1;
          }

          fallOfWickets.push({
            wicketNum: totalWickets,
            score: totalRuns,
            overs: `${Math.floor(legalDeliveries / 6)}.${legalDeliveries % 6}`,
            playerId: outPlayerId,
            playerName: outPlayer.name,
            dismissal: ball.dismissal
          });
        }
      }
    });

    // Compute Maiden Overs (6 legal deliveries in an over with 0 bowler-conceded runs)
    const bowlerOverMap = {};
    balls.forEach(ball => {
      if (!ball.bowlerId) return;
      const isWide = ball.extraType === 'wide';
      const isNoBall = ball.extraType === 'noBall';
      const isBye = ball.extraType === 'bye';
      const isLegBye = ball.extraType === 'legBye';
      const isPenalty = ball.extraType === 'penalty';
      const isLegal = !isWide && !isNoBall && !isPenalty;
      const extraCount = ball.extraTotal || (ball.extraRuns + (isWide || isNoBall ? 1 : 0)) || 0;

      if (!bowlerOverMap[ball.bowlerId]) {
        bowlerOverMap[ball.bowlerId] = { legalInCurrentOver: 0, runsInCurrentOver: 0, maidens: 0 };
      }
      const tracker = bowlerOverMap[ball.bowlerId];

      // Runs charged to bowler (byes/leg-byes/penalties do NOT spoil a maiden)
      if (isWide || isNoBall) {
        tracker.runsInCurrentOver += (ball.batRuns || 0) + extraCount;
      } else if (!isBye && !isLegBye && !isPenalty) {
        tracker.runsInCurrentOver += (ball.batRuns || 0);
      }

      if (isLegal) {
        tracker.legalInCurrentOver += 1;
        if (tracker.legalInCurrentOver === 6) {
          if (tracker.runsInCurrentOver === 0) {
            tracker.maidens += 1;
          }
          tracker.legalInCurrentOver = 0;
          tracker.runsInCurrentOver = 0;
        }
      }
    });

    Object.entries(bowlerOverMap).forEach(([bId, data]) => {
      if (bowlers[bId]) {
        bowlers[bId].maidens = data.maidens;
      }
    });

    // Compute Strike Rates
    Object.values(batters).forEach(b => {
      b.strikeRate = b.balls > 0 ? ((b.runs / b.balls) * 100).toFixed(1) : '0.0';
    });

    // Compute Bowling overs & economy
    Object.values(bowlers).forEach(b => {
      const fullOvers = Math.floor(b.legalBalls / 6);
      const remBalls = b.legalBalls % 6;
      b.oversFormatted = `${fullOvers}.${remBalls}`;
      const overDecimal = fullOvers + (remBalls / 6);
      b.economy = overDecimal > 0 ? (b.runsConceded / overDecimal).toFixed(2) : '0.00';
    });

    // Over-by-over summary & active Partnership
    const overHistory = [];
    let curOverRuns = 0;
    let curOverWickets = 0;
    let curLegalCount = 0;
    let runningTotal = innings.base?.runs || 0;

    let partRuns = 0;
    let partBalls = 0;
    const partContrib = {};

    balls.forEach(ball => {
      const isWide = ball.extraType === 'wide';
      const isNoBall = ball.extraType === 'noBall';
      const isPenalty = ball.extraType === 'penalty';
      const isLegal = !isWide && !isNoBall && !isPenalty;
      const extraCount = ball.extraTotal || (ball.extraRuns + (isWide || isNoBall ? 1 : 0)) || 0;
      const delivRuns = (ball.batRuns || 0) + extraCount;

      runningTotal += delivRuns;
      curOverRuns += delivRuns;

      partRuns += delivRuns;
      if (!isWide && !isPenalty) partBalls += 1;
      if (ball.batterId) {
        if (!partContrib[ball.batterId]) partContrib[ball.batterId] = { runs: 0, balls: 0 };
        partContrib[ball.batterId].runs += (ball.batRuns || 0);
        if (!isWide && !isPenalty) partContrib[ball.batterId].balls += 1;
      }

      if (ball.wicket && ball.dismissal !== 'none' && ball.dismissal !== 'retiredHurt') {
        curOverWickets += 1;
        partRuns = 0;
        partBalls = 0;
        Object.keys(partContrib).forEach(k => delete partContrib[k]);
      }

      if (isLegal) {
        curLegalCount += 1;
        if (curLegalCount % 6 === 0) {
          overHistory.push({
            overNum: curLegalCount / 6,
            runs: curOverRuns,
            wickets: curOverWickets,
            cumulative: runningTotal
          });
          curOverRuns = 0;
          curOverWickets = 0;
        }
      }
    });

    if (curLegalCount % 6 !== 0 || curOverRuns > 0 || curOverWickets > 0) {
      overHistory.push({
        overNum: Math.floor(curLegalCount / 6) + 1,
        runs: curOverRuns,
        wickets: curOverWickets,
        cumulative: runningTotal,
        isPartial: true
      });
    }

    const oversCompleted = Math.floor(legalDeliveries / 6);
    const ballsRemaining = legalDeliveries % 6;

    return {
      totalRuns,
      wickets: totalWickets,
      oversFormatted: `${oversCompleted}.${ballsRemaining}`,
      legalDeliveries,
      extras,
      batters: Object.values(batters),
      bowlers: Object.values(bowlers),
      fallOfWickets,
      overHistory,
      partnership: { runs: partRuns, balls: partBalls, contrib: partContrib }
    };
  }
}

// ==========================================
// 3. NAVIGATION & VIEW CONTROLLER (9 SECTIONS)
// ==========================================

const VALID_TABS = ['dashboard', 'tournaments', 'live-scorer', 'create-match', 'teams', 'players', 'history', 'statistics', 'settings', 'scorecard', 'watch-live', 'watch-tournament', 'broadcast-overlay'];

function persistActiveTab(tabId) {
  if (!VALID_TABS.includes(tabId)) return;
  try {
    sessionStorage.setItem('cricscorer_active_tab', tabId);
    if (window.location.hash !== '#' + tabId) {
      history.replaceState(null, '', '#' + tabId);
    }
  } catch (e) {}
}

function getSavedActiveTab() {
  try {
    const rawHash = (window.location.hash || '').replace('#', '').trim();
    if (rawHash.startsWith('watch=')) {
      spectatorWatchMatchId = decodeURIComponent(rawHash.slice(6));
      return 'watch-live';
    }
    if (rawHash.startsWith('tournament=')) {
      publicWatchTournamentId = decodeURIComponent(rawHash.slice(11));
      return 'watch-tournament';
    }
    if (rawHash.startsWith('overlay=')) {
      obsOverlayMatchId = decodeURIComponent(rawHash.slice(8));
      return 'broadcast-overlay';
    }
    if (VALID_TABS.includes(rawHash)) return rawHash;
    const storedTab = sessionStorage.getItem('cricscorer_active_tab');
    if (VALID_TABS.includes(storedTab)) return storedTab;
  } catch (e) {}
  return 'dashboard';
}

const PRIMARY_DOCK_TABS = ['dashboard', 'live-scorer', 'create-match', 'tournaments'];

function toggleMoreNavSheet() {
  const sheet = document.getElementById('moreNavSheet');
  const backdrop = document.getElementById('moreNavBackdrop');
  if (!sheet || !backdrop) return;
  const isOpen = sheet.classList.contains('open');
  if (isOpen) {
    closeMoreNavSheet();
  } else {
    sheet.classList.add('open');
    sheet.setAttribute('aria-hidden', 'false');
    backdrop.classList.add('open');
  }
}

function closeMoreNavSheet() {
  const sheet = document.getElementById('moreNavSheet');
  const backdrop = document.getElementById('moreNavBackdrop');
  if (sheet) {
    sheet.classList.remove('open');
    sheet.setAttribute('aria-hidden', 'true');
  }
  if (backdrop) backdrop.classList.remove('open');
}

function navigateFromMoreSheet(tabId) {
  closeMoreNavSheet();
  navigate(tabId);
}

function updateBottomNavLiveBeacon() {
  const dot = document.getElementById('navLiveMatchDot');
  if (!dot) return;
  const hasLive = !!(activeMatch && activeMatch.status === 'Live');
  dot.style.display = hasLive ? 'inline-block' : 'none';
}

function navigate(tabId, options = {}) {
  const targetTab = VALID_TABS.includes(tabId) ? tabId : 'dashboard';
  closeMoreNavSheet();
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === targetTab));

  const isSecondaryDockTab = !PRIMARY_DOCK_TABS.includes(targetTab) && targetTab !== 'watch-live' && targetTab !== 'watch-tournament';
  document.querySelectorAll('.nav-item').forEach(b => {
    const navKey = b.dataset.nav;
    const isActive = navKey === 'more' ? isSecondaryDockTab : (navKey === targetTab);
    b.classList.toggle('active', isActive);
  });
  document.querySelectorAll('.more-tile-btn').forEach(tile => {
    tile.classList.toggle('active', tile.dataset.moreNav === targetTab);
  });
  updateBottomNavLiveBeacon();

  persistActiveTab(targetTab);

  if (!options.preserveScroll) {
    window.scrollTo({ top: 0, behavior: options.instant ? 'auto' : 'smooth' });
  }

  if (targetTab === 'dashboard') { renderDashboard(); refreshPublicLiveCenter(); }
  if (targetTab === 'tournaments') renderTournamentsView();
  if (targetTab === 'watch-live') renderSpectatorView();
  if (targetTab === 'watch-tournament') renderPublicTournamentHub();
  if (targetTab === 'broadcast-overlay') renderBroadcastOverlayView();
  document.body.classList.toggle('obs-overlay-mode', targetTab === 'broadcast-overlay');
  if (targetTab === 'live-scorer') renderLiveScorerView();
  if (targetTab === 'create-match') renderCreateMatchView();
  if (targetTab === 'teams') renderTeams();
  if (targetTab === 'players') renderPlayers();
  if (targetTab === 'history') renderHistory();
  if (targetTab === 'statistics') renderStatistics();
  if (targetTab === 'settings') renderSettings();
}

// ==========================================
// 4. DASHBOARD MODULE
// ==========================================

function buildHomeTeamShieldSVG(teamName, variant = 'a') {
  const initial = (teamName || 'T').trim().charAt(0).toUpperCase();
  const fillMain = variant === 'a' ? '#0288d1' : '#d32f2f';
  const fillAccent = variant === 'a' ? '#29b6f6' : '#ff5252';
  return `
    <svg width="42" height="46" viewBox="0 0 44 48" style="display:block; filter:drop-shadow(0 2px 6px rgba(0,0,0,0.45));">
      <path d="M22 2 L40 9 L40 23 C40 34 31 42 22 46 C13 42 4 34 4 23 L4 9 Z" fill="${fillMain}" stroke="#ffffff" stroke-width="2"/>
      <path d="M22 5 L37 11 L37 23 C37 32 29.5 39 22 42.5 C14.5 39 7 32 7 23 L7 11 Z" fill="none" stroke="${fillAccent}" stroke-width="1.2"/>
      <text x="22" y="29" text-anchor="middle" fill="#ffffff" font-size="18" font-weight="900" font-family="sans-serif">${escapeHTML(initial)}</text>
    </svg>
  `;
}

async function renderDashboard() {
  const [teams, players, matches] = await Promise.all([
    dbGetAll('teams'), dbGetAll('players'), dbGetAll('matches')
  ]);

  const completedCount = matches.filter(m => m.status === 'Completed').length;

  // Update 4-Column Summary Metrics
  const matchCountEl = document.getElementById('statTotalMatches');
  if (matchCountEl) matchCountEl.textContent = matches.length;
  const teamCountEl = document.getElementById('statTotalTeams');
  if (teamCountEl) teamCountEl.textContent = teams.length;
  const playerCountEl = document.getElementById('statTotalPlayers');
  if (playerCountEl) playerCountEl.textContent = players.length;
  const completedCountEl = document.getElementById('statCompletedMatches');
  if (completedCountEl) completedCountEl.textContent = completedCount;
  const navDot = document.getElementById('navLiveMatchDot');
  if (navDot) {
    const anyLiveMatch = matches.some(m => m.status === 'Live');
    navDot.style.display = anyLiveMatch ? 'inline-block' : 'none';
  }

  try {
    const tourns = await getAllTournaments();
    const tSubEl = document.getElementById('homeTournamentSummaryText');
    if (tSubEl) {
      if (tourns.length > 0) {
        const totalFixtures = tourns.reduce((sum, t) => sum + (t.fixtures?.length || 0), 0);
        const doneFixtures = tourns.reduce((sum, t) => sum + (t.fixtures?.filter(f => f.status === 'Completed').length || 0), 0);
        tSubEl.textContent = `${tourns.length} active tournament${tourns.length === 1 ? '' : 's'} · ${doneFixtures}/${totalFixtures} fixtures completed`;
      } else {
        tSubEl.textContent = 'Add teams, auto-generate schedules & track live Points Table / NRR';
      }
    }
  } catch (e) {}

  // Check for an Active Live Match
  const liveMatches = matches.filter(m => m.status === 'Live');
  const primaryLiveMatch = liveMatches[0] || null;
  const heroContainer = document.getElementById('dashHeroContainer');

  if (heroContainer) {
    if (primaryLiveMatch) {
      const inn = primaryLiveMatch.innings[primaryLiveMatch.innings.length - 1];
      const stats = CricketEngine.calculateInnings(inn, inn.squad, inn.bowlingSquad);
      const battingName = teams.find(t => t.id === inn.batting)?.name || 'Batting XI';
      const bowlingName = teams.find(t => t.id === inn.bowling)?.name || 'Bowling XI';

      const totalOvers = primaryLiveMatch.overs || 20;
      const totalMaxBalls = totalOvers * 6;
      const ballsRem = Math.max(0, totalMaxBalls - stats.legalDeliveries);
      const crr = stats.legalDeliveries > 0 ? (stats.totalRuns / (stats.legalDeliveries / 6)).toFixed(2) : '0.00';
      const runsReq = primaryLiveMatch.target ? Math.max(0, primaryLiveMatch.target - stats.totalRuns) : '--';
      const rrr = (primaryLiveMatch.target && ballsRem > 0) ? (runsReq / (ballsRem / 6)).toFixed(2) : '--';

      heroContainer.innerHTML = `
        <div class="home-live-hero-card">
          <div class="hlh-top-row">
            <span class="hlh-status-label"><span class="hlh-red-dot"></span> LIVE MATCH IN PROGRESS</span>
            <span class="hlh-format-pill">${escapeHTML(primaryLiveMatch.format || 'T20')}</span>
          </div>

          <div class="hlh-teams-score-row">
            <div class="hlh-team-col">
              ${buildHomeTeamShieldSVG(battingName, 'a')}
              <span class="hlh-team-label">${escapeHTML(battingName)}</span>
            </div>

            <div class="hlh-score-center">
              <div class="hlh-big-score">${stats.totalRuns} / ${stats.wickets}</div>
              <div class="hlh-overs-label">(${stats.oversFormatted} / ${totalOvers} Overs)</div>
            </div>

            <div class="hlh-team-col">
              ${buildHomeTeamShieldSVG(bowlingName, 'b')}
              <span class="hlh-team-label">${escapeHTML(bowlingName)}</span>
            </div>
          </div>

          <div class="hlh-metrics-strip">
            <div class="hlh-m-cell"><span>CRR</span><strong>${crr}</strong></div>
            <div class="hlh-m-cell"><span>RRR</span><strong>${rrr}</strong></div>
            <div class="hlh-m-cell"><span>Target</span><strong>${primaryLiveMatch.target || '--'}</strong></div>
            <div class="hlh-m-cell"><span>Runs Req.</span><strong>${runsReq}</strong></div>
            <div class="hlh-m-cell"><span>Balls Rem.</span><strong>${ballsRem}</strong></div>
          </div>

          <button class="btn btn-primary hlh-resume-btn" onclick="resumeMatch('${primaryLiveMatch.id}')">▶ Resume Scoring ⚡</button>
        </div>
      `;
    } else {
      heroContainer.innerHTML = `
        <div class="dash-welcome-hero">
          <div class="dash-welcome-text">
            <h1>Match Center</h1>
            <p>No live match running right now. Start a fixture to begin scoring.</p>
          </div>
          <button class="btn btn-primary" onclick="navigate('create-match')">＋ Start Match</button>
        </div>
      `;
    }
  }

  // Render Recent Matches
  const matchesList = document.getElementById('dashboardMatchesList');
  if (matchesList) {
    if (!matches.length) {
      matchesList.className = 'stack-list empty-state';
      matchesList.innerHTML = `<p>No matches recorded yet.</p><button class="btn btn-primary" style="margin-top:8px; font-size:12px;" onclick="navigate('create-match')">Create First Match</button>`;
    } else {
      matchesList.className = 'stack-list';
      const recent = [...matches].sort((a,b) => (b.created || '').localeCompare(a.created || '')).slice(0, 4);
      matchesList.innerHTML = recent.map(m => createMatchItemHTML(m, teams)).join('');
    }
  }

  // Calculate Top Performers Strip
  calculateTopPerformers(matches);
}

function createMatchItemHTML(m, teams) {
  const teamA = teams.find(t => t.id === m.a)?.name || 'Team A';
  const teamB = teams.find(t => t.id === m.b)?.name || 'Team B';
  const isLive = m.status === 'Live';
  const statusBadge = isLive ? 'badge-live' : m.status === 'Completed' ? 'badge-completed' : 'badge-upcoming';

  let liveScoreLine = '';
  if (isLive && m.innings && m.innings.length) {
    const curInn = m.innings[m.innings.length - 1];
    const st = CricketEngine.calculateInnings(curInn, curInn.squad, curInn.bowlingSquad);
    liveScoreLine = `${escapeHTML(m.format || 'T20')} · ${st.oversFormatted} Overs &nbsp;|&nbsp; <strong style="color:var(--primary);">${st.totalRuns}/${st.wickets}</strong>`;
  } else {
    liveScoreLine = `${escapeHTML(m.format || 'T20')} · ${escapeHTML(m.date || 'Today')} &nbsp;|&nbsp; ${escapeHTML(m.result || m.title)}`;
  }

  return `
    <div class="match-card-modern">
      <div class="item-info">
        <div style="margin-bottom:3px;"><span class="badge ${statusBadge}">${m.status.toUpperCase()}</span></div>
        <div class="match-card-teams">${escapeHTML(teamA)} vs ${escapeHTML(teamB)}</div>
        <div class="match-card-result">${liveScoreLine}</div>
      </div>
      <div class="item-actions">
        ${isLive ? `<button class="btn btn-primary" style="font-size:12px; padding:7px 13px;" onclick="resumeMatch('${m.id}')">▶ Resume</button>` : ''}
        ${m.status === 'Completed' ? `<button class="btn btn-secondary" style="font-size:12px; padding:7px 10px;" onclick="viewDetailedScorecard('${m.id}')">Scorecard</button><button class="btn btn-primary" style="font-size:12px; padding:7px 10px;" onclick="openMatchPosterModal('${m.id}')" title="Generate 1080x1080 Match Poster">🖼️</button>` : ''}
        ${m.status === 'Upcoming' ? `<button class="btn btn-primary" style="font-size:12px; padding:7px 12px;" onclick="resumeMatch('${m.id}')">Start</button>` : ''}
        <button class="btn btn-outline" style="font-size:12px; padding:7px 9px;" onclick="deleteMatchPrompt('${m.id}')" title="Delete Match">⋮</button>
      </div>
    </div>
  `;
}

function calculateTopPerformers(matches) {
  const batterTotals = {};
  const bowlerTotals = {};

  matches.forEach(m => {
    (m.innings || []).forEach(inn => {
      const res = CricketEngine.calculateInnings(inn);
      res.batters.forEach(b => {
        if (!batterTotals[b.name]) batterTotals[b.name] = 0;
        batterTotals[b.name] += b.runs;
      });
      res.bowlers.forEach(bo => {
        if (!bowlerTotals[bo.name]) bowlerTotals[bo.name] = 0;
        bowlerTotals[bo.name] += bo.wickets;
      });
    });
  });

  const topBatters = Object.entries(batterTotals).filter(([, r]) => r > 0).sort((a,b) => b[1] - a[1]);
  const topBowlers = Object.entries(bowlerTotals).filter(([, w]) => w > 0).sort((a,b) => b[1] - a[1]);

  const stripEl = document.getElementById('dashboardTopPerformersStrip');
  if (!stripEl) return;

  const cards = [];
  if (topBatters[0]) {
    cards.push(`
      <div class="performer-spotlight-card">
        <div class="ps-icon">🏏</div>
        <div style="min-width:0;">
          <div class="ps-name">${escapeHTML(topBatters[0][0])}</div>
          <div class="ps-stat">${topBatters[0][1]} Runs</div>
        </div>
      </div>
    `);
  }
  if (topBowlers[0]) {
    cards.push(`
      <div class="performer-spotlight-card">
        <div class="ps-icon">🔴</div>
        <div style="min-width:0;">
          <div class="ps-name">${escapeHTML(topBowlers[0][0])}</div>
          <div class="ps-stat">${topBowlers[0][1]} Wicket${topBowlers[0][1] === 1 ? '' : 's'}</div>
        </div>
      </div>
    `);
  }
  if (topBatters[1]) {
    cards.push(`
      <div class="performer-spotlight-card">
        <div class="ps-icon">👑</div>
        <div style="min-width:0;">
          <div class="ps-name">${escapeHTML(topBatters[1][0])}</div>
          <div class="ps-stat">${topBatters[1][1]} Runs</div>
        </div>
      </div>
    `);
  }

  stripEl.innerHTML = cards.length
    ? cards.join('')
    : '<span class="muted" style="font-size:12px;">Complete deliveries in a match to spotlight top run-scorers and wicket-takers.</span>';
}

// ==========================================
// 5. TEAMS MANAGEMENT MODULE
// ==========================================

async function renderTeams() {
  const [teams, players] = await Promise.all([dbGetAll('teams'), dbGetAll('players')]);
  const container = document.getElementById('teamsContainer');
  if (!container) return;

  if (!teams.length) {
    container.className = 'stack-list empty-state';
    container.textContent = 'No teams yet. Click "+ Add Team" to create one.';
    return;
  }

  container.className = 'stack-list';
  container.innerHTML = teams.map(t => {
    const teamPlayerCount = players.filter(p => p.teamId === t.id).length;
    return `
      <div class="team-item">
        <div class="item-info">
          <h3>🏏 ${escapeHTML(t.name)}</h3>
          <p>${escapeHTML(t.location || 'No home city')} · ${teamPlayerCount} players registered</p>
        </div>
        <div class="item-actions">
          <button class="btn btn-secondary" onclick="openTeamModal('${t.id}')">Edit</button>
          <button class="btn btn-outline" onclick="deleteTeamPrompt('${t.id}')">Delete</button>
        </div>
      </div>
    `;
  }).join('');
}

async function openTeamModal(teamId = null) {
  if (!db) await openDatabase();
  const teams = await dbGetAll('teams');
  const team = teamId ? teams.find(t => t.id === teamId) : null;

  const html = `
    <form id="teamForm" onsubmit="event.preventDefault();">
      <div class="form-group" style="margin-bottom:12px;">
        <label>Team Name *</label>
        <input type="text" id="tName" name="name" required value="${escapeHTML(team?.name || '')}" placeholder="e.g. Royal Challengers">
      </div>
      <div class="form-group" style="margin-bottom:12px;">
        <label>Home City / Ground</label>
        <input type="text" id="tLocation" name="location" value="${escapeHTML(team?.location || '')}" placeholder="e.g. Bengaluru">
      </div>
      <div class="form-group">
        <label>Short Code</label>
        <input type="text" id="tShortName" name="shortName" maxlength="4" value="${escapeHTML(team?.shortName || '')}" placeholder="e.g. RCB">
      </div>
    </form>
  `;

  openModal(team ? 'Edit Team' : 'Add Team', html, async () => {
    const name = document.getElementById('tName').value.trim();
    const location = document.getElementById('tLocation').value.trim();
    const shortName = document.getElementById('tShortName').value.trim();

    if (!name) {
      showToast('Please enter a team name');
      return false;
    }

    if (team) {
      await dbPut('teams', { ...team, name, location, shortName });
      showToast('Team updated successfully');
    } else {
      await dbPut('teams', {
        id: generateId(),
        name,
        location,
        shortName,
        created: new Date().toISOString()
      });
      showToast('New team created');
    }
    triggerAutoBackup();
    renderTeams();
    renderDashboard();
    return true;
  });
}

async function deleteTeamPrompt(teamId) {
  const matches = await dbGetAll('matches');
  const inUse = matches.some(m => m.a === teamId || m.b === teamId);
  if (inUse) {
    if (!confirm('This team is linked to existing matches. Deleting it will keep match history intact. Proceed?')) return;
  } else {
    if (!confirm('Are you sure you want to delete this team?')) return;
  }
  await dbDelete('teams', teamId);
  showToast('Team removed');
  renderTeams();
}

// ==========================================
// 6. PLAYERS MANAGEMENT MODULE (Independent Player Pool)
// ==========================================

async function computeAllPlayersCareerMap() {
  const matches = await dbGetAll('matches');
  const map = {};
  const ensure = (id, name) => {
    if (!map[id]) {
      map[id] = { id, name: name || 'Player', matches: 0, runs: 0, balls: 0, fours: 0, sixes: 0, fifties: 0, hundreds: 0, highScore: 0, wickets: 0, legalBalls: 0, runsConceded: 0, bestW: 0, bestR: 999 };
    }
    return map[id];
  };

  matches.forEach(m => {
    const matchSeen = new Set();
    (m.innings || []).forEach(inn => {
      const st = CricketEngine.calculateInnings(inn, inn.squad || [], inn.bowlingSquad || []);
      (st.batters || []).forEach(b => {
        if (b.balls > 0 || b.runs > 0 || b.isOut) {
          const rec = ensure(b.id, b.name);
          if (!matchSeen.has(b.id)) { rec.matches += 1; matchSeen.add(b.id); }
          rec.runs += b.runs;
          rec.balls += b.balls;
          rec.fours += b.fours || 0;
          rec.sixes += b.sixes || 0;
          if (b.runs >= 100) rec.hundreds += 1;
          else if (b.runs >= 50) rec.fifties += 1;
          if (b.runs > rec.highScore) rec.highScore = b.runs;
        }
      });
      (st.bowlers || []).forEach(bo => {
        if (bo.legalBalls > 0 || bo.wickets > 0 || bo.wides > 0 || bo.noBalls > 0) {
          const rec = ensure(bo.id, bo.name);
          if (!matchSeen.has(bo.id)) { rec.matches += 1; matchSeen.add(bo.id); }
          rec.wickets += bo.wickets;
          rec.legalBalls += bo.legalBalls;
          rec.runsConceded += bo.runsConceded;
          if (bo.wickets > rec.bestW || (bo.wickets === rec.bestW && bo.runsConceded < rec.bestR)) {
            rec.bestW = bo.wickets;
            rec.bestR = bo.runsConceded;
          }
        }
      });
    });
  });

  return map;
}

function buildPlayerMilestoneBadgesHTML(c) {
  if (!c) return '';
  const badges = [];
  if (c.runs >= 1000) badges.push('👑 1,000+ Runs Club');
  else if (c.runs >= 500) badges.push('🔥 500+ Runs');
  else if (c.runs >= 100) badges.push('🏏 100+ Runs');
  if (c.hundreds >= 1) badges.push(`💯 ${c.hundreds}x 100s`);
  if (c.wickets >= 50) badges.push('🟣 50+ Wickets');
  else if (c.wickets >= 25) badges.push('⚡ 25+ Wickets');
  else if (c.wickets >= 10) badges.push('🎯 10+ Wickets');
  if (!badges.length) return '';
  return `<div class="career-milestone-row">${badges.map(b => `<span class="career-badge-pill">${b}</span>`).join('')}</div>`;
}

async function renderPlayers() {
  const [players, careerMap] = await Promise.all([dbGetAll('players'), computeAllPlayersCareerMap()]);
  const container = document.getElementById('playersContainer');
  const search = (document.getElementById('playerSearchInput')?.value || '').toLowerCase();
  const roleFilter = document.getElementById('playerRoleFilter')?.value || '';

  let filtered = players.filter(p => {
    const matchName = (p.name || '').toLowerCase().includes(search);
    const matchRole = !roleFilter || p.role === roleFilter;
    return matchName && matchRole;
  });

  filtered.sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));

  if (!filtered.length) {
    container.className = 'stack-list empty-state';
    container.textContent = 'No players found matching criteria. Tap "+ Add Player" to add players.';
    return;
  }

  container.className = 'stack-list';
  container.innerHTML = filtered.map(p => {
    const c = careerMap[p.id];
    const sr = c && c.balls > 0 ? ((c.runs / c.balls) * 100).toFixed(1) : '0.0';
    const careerLine = c
      ? `<p style="margin-top:3px; color:var(--primary); font-weight:700;">${c.matches} M · ${c.runs} Runs (HS ${c.highScore}, SR ${sr}) · ${c.wickets} Wkts</p>`
      : '';
    return `
      <div class="player-item">
        <div class="item-info">
          <h3>${escapeHTML(p.name)}</h3>
          <p>Role: <strong>${escapeHTML(p.role || 'Batter')}</strong> · ${escapeHTML(p.battingStyle || 'Right-hand bat')}</p>
          ${careerLine}
          ${buildPlayerMilestoneBadgesHTML(c)}
        </div>
        <div class="item-actions" style="flex-wrap:wrap; justify-content:flex-end;">
          <button class="btn btn-primary" style="padding:6px 9px; font-size:11px;" onclick="generatePlayerCareerPosterModal('${p.id}')">🪪 Card</button>
          <button class="btn btn-secondary" onclick="openPlayerModal('${p.id}')">Edit</button>
          <button class="btn btn-outline" onclick="deletePlayerPrompt('${p.id}')">Remove</button>
        </div>
      </div>
    `;
  }).join('');
}

async function openPlayerModal(playerId = null) {
  if (!db) await openDatabase();
  const players = await dbGetAll('players');
  const p = playerId ? players.find(x => x.id === playerId) : null;

  const html = `
    <form id="playerForm" onsubmit="event.preventDefault();">
      <div class="form-group" style="margin-bottom:12px;">
        <label>Player Full Name *</label>
        <input type="text" id="pName" name="name" required value="${escapeHTML(p?.name || '')}" placeholder="e.g. Rohit Sharma">
      </div>
      <div class="form-group" style="margin-bottom:12px;">
        <label>Primary Role</label>
        <select id="pRole" name="role">
          <option value="Batter" ${p?.role === 'Batter' ? 'selected' : ''}>Batter</option>
          <option value="Bowler" ${p?.role === 'Bowler' ? 'selected' : ''}>Bowler</option>
          <option value="All-Rounder" ${p?.role === 'All-Rounder' ? 'selected' : ''}>All-Rounder</option>
          <option value="Wicket-Keeper" ${p?.role === 'Wicket-Keeper' ? 'selected' : ''}>Wicket-Keeper</option>
        </select>
      </div>
      <div class="form-group">
        <label>Batting Style</label>
        <select id="pBatStyle" name="battingStyle">
          <option value="Right-hand bat" ${p?.battingStyle === 'Right-hand bat' ? 'selected' : ''}>Right-hand bat</option>
          <option value="Left-hand bat" ${p?.battingStyle === 'Left-hand bat' ? 'selected' : ''}>Left-hand bat</option>
        </select>
      </div>
    </form>
  `;

  openModal(p ? 'Edit Player' : 'Add Player', html, async () => {
    const name = document.getElementById('pName').value.trim();
    const role = document.getElementById('pRole').value;
    const battingStyle = document.getElementById('pBatStyle').value;

    if (!name) {
      showToast('Please enter a player name');
      return false;
    }

    if (p) {
      await dbPut('players', { ...p, name, role, battingStyle });
      showToast('Player updated');
    } else {
      await dbPut('players', {
        id: generateId(),
        name,
        role,
        battingStyle,
        created: new Date().toISOString()
      });
      showToast('Player added to squad pool');
    }
    triggerAutoBackup();
    renderPlayers();
    renderDashboard();
    return true;
  });
}

async function deletePlayerPrompt(playerId) {
  if (!confirm('Remove this player from roster? Historical scorecards will preserve their statistics.')) return;
  await dbDelete('players', playerId);
  showToast('Player removed');
  renderPlayers();
}

// ==========================================
// 7. MATCH SETUP & CREATION MODULE
// ==========================================

async function renderCreateMatchView() {
  const [teams, players] = await Promise.all([dbGetAll('teams'), dbGetAll('players')]);
  const teamASelect = document.getElementById('cmTeamA');
  const teamBSelect = document.getElementById('cmTeamB');
  const dateInput = document.getElementById('cmDate');

  if (dateInput && !dateInput.value) {
    dateInput.value = new Date().toISOString().slice(0, 10);
  }

  if (!teams.length) {
    alert('Please create at least two teams before setting up a match.');
    navigate('teams');
    return;
  }

  teamASelect.innerHTML = teams.map(t => `<option value="${t.id}">${escapeHTML(t.name)}</option>`).join('');
  teamBSelect.innerHTML = teams.map((t, idx) => `<option value="${t.id}" ${idx === 1 ? 'selected' : ''}>${escapeHTML(t.name)}</option>`).join('');

  updateTeamDropdowns();
}

function onFormatChange(format) {
  const oversGroup = document.getElementById('cmOversGroup');
  const oversInput = document.getElementById('cmOvers');
  if (format === 'T20') { oversInput.value = 20; oversGroup.style.display = 'block'; }
  else if (format === 'T10') { oversInput.value = 10; oversGroup.style.display = 'block'; }
  else if (format === 'ODI') { oversInput.value = 50; oversGroup.style.display = 'block'; }
  else if (format === 'Test') { oversInput.value = 90; oversGroup.style.display = 'none'; }
  else { oversGroup.style.display = 'block'; }
}

// ==========================================
// MATCH SQUAD SELECTION ENGINE (CENTRAL POOL)
// ==========================================

let selectedSquadA = new Set();
let selectedSquadB = new Set();
let cachedSquadPlayers = [];
let currentSquadSearch = '';

async function updateTeamDropdowns() {
  const teamAId = document.getElementById('cmTeamA').value;
  const teamBId = document.getElementById('cmTeamB').value;
  const [teams, allPlayers] = await Promise.all([dbGetAll('teams'), dbGetAll('players')]);
  // Sort players alphabetically A-Z
  cachedSquadPlayers = [...allPlayers].sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));

  const teamAName = teams.find(t => t.id === teamAId)?.name || 'Team A';
  const teamBName = teams.find(t => t.id === teamBId)?.name || 'Team B';

  // Update Toss Winner Labels
  const tossSel = document.getElementById('cmTossWinner');
  if (tossSel) {
    tossSel.innerHTML = `
      <option value="${teamAId}">${escapeHTML(teamAName)}</option>
      <option value="${teamBId}">${escapeHTML(teamBName)}</option>
    `;
  }

  // Update Team Card Headings
  const headA = document.getElementById('teamAHeading');
  if (headA) headA.textContent = teamAName;
  const headB = document.getElementById('teamBHeading');
  if (headB) headB.textContent = teamBName;

  // Auto-seed squads alternating if both sets are empty
  if (selectedSquadA.size === 0 && selectedSquadB.size === 0 && allPlayers.length >= 2) {
    allPlayers.forEach((p, idx) => {
      if (idx % 2 === 0) selectedSquadA.add(p.id);
      else selectedSquadB.add(p.id);
    });
  }

  renderSquadLists();
}

function filterSquadLists(query) {
  currentSquadSearch = (query || '').toLowerCase().trim();
  renderSquadLists();
}

function renderSquadLists() {
  const listA = document.getElementById('squadListA');
  const listB = document.getElementById('squadListB');
  if (!listA || !listB) return;

  if (!cachedSquadPlayers.length) {
    listA.innerHTML = '<div class="empty-state" style="padding:12px; font-size:12px;">No players in registry yet.<br><button type="button" class="btn btn-secondary" style="margin-top:6px; font-size:11px; padding:4px 8px;" onclick="openPlayerModal()">＋ Add Player</button></div>';
    listB.innerHTML = '<div class="empty-state" style="padding:12px; font-size:12px;">No players in registry yet.</div>';
    updateSquadCounters();
    return;
  }

  const filtered = cachedSquadPlayers.filter(p => {
    if (!currentSquadSearch) return true;
    const nameMatch = (p.name || '').toLowerCase().includes(currentSquadSearch);
    const roleMatch = (p.role || '').toLowerCase().includes(currentSquadSearch);
    return nameMatch || roleMatch;
  }).sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));

  if (!filtered.length) {
    listA.innerHTML = '<p class="muted" style="padding:8px; font-size:12px;">No matching players found.</p>';
    listB.innerHTML = '<p class="muted" style="padding:8px; font-size:12px;">No matching players found.</p>';
    updateSquadCounters();
    return;
  }

  // Render Team A List
  listA.innerHTML = filtered.map(p => {
    const isSelected = selectedSquadA.has(p.id);
    const isTakenByB = selectedSquadB.has(p.id);
    const statusClass = isSelected ? 'selected-a' : isTakenByB ? 'disabled-taken' : '';
    const metaNote = isTakenByB ? 'In Team B' : (p.battingStyle || 'Player');

    return `
      <div class="player-select-tile ${statusClass}" onclick="toggleSquadPlayer('A', '${p.id}', ${isTakenByB})">
        <div class="player-tile-main">
          <span class="player-custom-checkbox">${isSelected ? '✓' : ''}</span>
          <div class="player-tile-info">
            <span class="player-tile-name">${escapeHTML(p.name)}</span>
            <span class="player-tile-meta">${escapeHTML(metaNote)}</span>
          </div>
        </div>
        <span class="player-role-badge">${escapeHTML(p.role || 'Player')}</span>
      </div>
    `;
  }).join('');

  // Render Team B List
  listB.innerHTML = filtered.map(p => {
    const isSelected = selectedSquadB.has(p.id);
    const isTakenByA = selectedSquadA.has(p.id);
    const statusClass = isSelected ? 'selected-b' : isTakenByA ? 'disabled-taken' : '';
    const metaNote = isTakenByA ? 'In Team A' : (p.battingStyle || 'Player');

    return `
      <div class="player-select-tile ${statusClass}" onclick="toggleSquadPlayer('B', '${p.id}', ${isTakenByA})">
        <div class="player-tile-main">
          <span class="player-custom-checkbox">${isSelected ? '✓' : ''}</span>
          <div class="player-tile-info">
            <span class="player-tile-name">${escapeHTML(p.name)}</span>
            <span class="player-tile-meta">${escapeHTML(metaNote)}</span>
          </div>
        </div>
        <span class="player-role-badge">${escapeHTML(p.role || 'Player')}</span>
      </div>
    `;
  }).join('');

  updateSquadCounters();
}

function toggleSquadPlayer(team, playerId, isTakenByOther) {
  if (isTakenByOther) {
    showToast(`This player is already selected in ${team === 'A' ? 'Team B' : 'Team A'}. Uncheck them first.`);
    return;
  }

  if (team === 'A') {
    if (selectedSquadA.has(playerId)) selectedSquadA.delete(playerId);
    else selectedSquadA.add(playerId);
  } else {
    if (selectedSquadB.has(playerId)) selectedSquadB.delete(playerId);
    else selectedSquadB.add(playerId);
  }

  renderSquadLists();
}

function quickSelectAll(team) {
  cachedSquadPlayers.forEach(p => {
    if (team === 'A' && !selectedSquadB.has(p.id)) selectedSquadA.add(p.id);
    else if (team === 'B' && !selectedSquadA.has(p.id)) selectedSquadB.add(p.id);
  });
  renderSquadLists();
}

function quickClearAll(team) {
  if (team === 'A') selectedSquadA.clear();
  else selectedSquadB.clear();
  renderSquadLists();
}

function updateSquadCounters() {
  const badgeA = document.getElementById('countBadgeA');
  const badgeB = document.getElementById('countBadgeB');
  if (badgeA) {
    badgeA.textContent = `${selectedSquadA.size} selected`;
    badgeA.classList.toggle('ready', selectedSquadA.size >= 2);
  }
  if (badgeB) {
    badgeB.textContent = `${selectedSquadB.size} selected`;
    badgeB.classList.toggle('ready', selectedSquadB.size >= 2);
  }
}

let currentMatchFixtureMode = 'squad';

function toggleMatchFixtureMode(mode) {
  currentMatchFixtureMode = mode;
  const squadBox = document.getElementById('squadSelectionBox');
  if (squadBox) {
    squadBox.style.display = (mode === 'quick') ? 'none' : 'block';
  }
}

async function getOrCreatePlayer(name, defaultRole, targetSquadList) {
  const cleanName = name.trim();
  const allPlayers = await dbGetAll('players');

  // Reuse existing player if matching name exists
  let player = allPlayers.find(p => p.name.toLowerCase() === cleanName.toLowerCase());

  if (!player) {
    player = {
      id: generateId(),
      name: cleanName,
      role: defaultRole,
      battingStyle: 'Right-hand bat',
      created: new Date().toISOString()
    };
    await dbPut('players', player);
  }

  // Ensure player is registered in the match squad list
  if (targetSquadList && !targetSquadList.some(p => p.id === player.id)) {
    targetSquadList.push(player);
  }

  return player.id;
}

async function promptAddPlayerOnTheFly(roleType) {
  if (!activeMatch) return null;
  const inn = activeMatch.innings[activeMatch.innings.length - 1];

  const html = `
    <div class="form-group">
      <label>${escapeHTML(roleType)} Full Name *</label>
      <input type="text" id="quickOnFlyPlayerName" placeholder="e.g. Hardik Pandya" autofocus>
    </div>
  `;

  openModal(`Add ${roleType} On The Fly`, html, async () => {
    const cleanName = (document.getElementById('quickOnFlyPlayerName')?.value || '').trim();
    if (!cleanName) {
      showToast('Please enter a player name');
      return false;
    }

    const defaultRole = roleType.toLowerCase().includes('bowler') ? 'Bowler' : 'Batter';
    const targetList = roleType.toLowerCase().includes('bowler') ? inn.bowlingSquad : inn.squad;
    const newPlayerId = await getOrCreatePlayer(cleanName, defaultRole, targetList);

    if (roleType === 'Striker') {
      if (newPlayerId === inn.nonStrikerId) {
        showToast('Striker and Non-Striker cannot be the same player.');
        renderLiveScorerView();
        return false;
      }
      inn.strikerId = newPlayerId;
    } else if (roleType === 'Non-Striker') {
      if (newPlayerId === inn.strikerId) {
        showToast('Non-Striker and Striker cannot be the same player.');
        renderLiveScorerView();
        return false;
      }
      inn.nonStrikerId = newPlayerId;
    } else if (roleType === 'Bowler') {
      inn.bowlerId = newPlayerId;
    }

    await saveActiveMatch();
    showToast(`${roleType} set to ${cleanName}`);
    renderLiveScorerView();
    return true;
  });
}

async function handleCreateMatchSubmit(event) {
  event.preventDefault();
  const teamA = document.getElementById('cmTeamA').value;
  const teamB = document.getElementById('cmTeamB').value;

  if (teamA === teamB) {
    alert('Team A and Team B must be different teams.');
    return;
  }

  const [teams, allPlayers] = await Promise.all([dbGetAll('teams'), dbGetAll('players')]);
  const tossWinner = document.getElementById('cmTossWinner').value;
  const tossDecision = document.getElementById('cmTossDecision').value;

  // Determine Batting Team
  let battingTeamId = (tossWinner === teamA && tossDecision === 'bat') || (tossWinner === teamB && tossDecision === 'bowl') ? teamA : teamB;
  let bowlingTeamId = battingTeamId === teamA ? teamB : teamA;

  let firstBattingSquad = [];
  let firstBowlingSquad = [];

  if (currentMatchFixtureMode === 'quick') {
    // Quick Match Mode: No squad selection required, players assigned on the spot!
    firstBattingSquad = [];
    firstBowlingSquad = [];
  } else {
    // Standard Squad Mode: Validate squads
    const squadAIds = Array.from(selectedSquadA);
    const squadBIds = Array.from(selectedSquadB);

    if (squadAIds.length < 2 || squadBIds.length < 2) {
      alert('Please select at least 2 players for each team squad.');
      return;
    }

    const duplicateId = squadAIds.find(id => squadBIds.includes(id));
    if (duplicateId) {
      const dupP = allPlayers.find(p => p.id === duplicateId);
      alert(`Player "${dupP ? dupP.name : 'Unknown'}" is selected in both teams. Please choose distinct players.`);
      return;
    }

    const squadAPlayers = allPlayers.filter(p => squadAIds.includes(p.id));
    const squadBPlayers = allPlayers.filter(p => squadBIds.includes(p.id));

    firstBattingSquad = battingTeamId === teamA ? squadAPlayers : squadBPlayers;
    firstBowlingSquad = battingTeamId === teamA ? squadBPlayers : squadAPlayers;
  }

  const matchId = generateId();
  const format = document.getElementById('cmFormat').value;
  const overs = format === 'Test' ? 450 : Number(document.getElementById('cmOvers').value || 20);

  const initialInnings = {
    inningsNum: 1,
    batting: battingTeamId,
    bowling: bowlingTeamId,
    squad: firstBattingSquad,
    bowlingSquad: firstBowlingSquad,
    strikerId: firstBattingSquad[0]?.id || null,
    nonStrikerId: firstBattingSquad[1]?.id || null,
    bowlerId: firstBowlingSquad[0]?.id || null,
    balls: [],
    base: { runs: 0, wickets: 0, legal: 0, ballCount: 0 }
  };

  const newMatch = {
    id: matchId,
    title: document.getElementById('cmTitle').value.trim() || (currentMatchFixtureMode === 'quick' ? 'Quick Match' : 'Cricket Match'),
    series: (document.getElementById('cmSeries')?.value || '').trim(),
    format: format,
    fixtureType: currentMatchFixtureMode, // 'squad' or 'quick'
    a: teamA,
    b: teamB,
    overs: overs,
    date: document.getElementById('cmDate').value,
    venue: document.getElementById('cmVenue').value || 'Ground',
    tossWinner,
    tossDecision,
    status: 'Live',
    innings: [initialInnings],
    created: new Date().toISOString()
  };

  await dbPut('matches', newMatch);
  activeMatch = newMatch;
  triggerAutoBackup();
  showToast(currentMatchFixtureMode === 'quick' ? 'Quick Match started! Set opening players on the fly.' : 'Match configured! Launching Live Scorer...');
  navigate('live-scorer');
}

// ==========================================
// 8. LIVE SCORING ENGINE & WORKFLOW
// ==========================================

async function resumeMatch(matchId) {
  const matches = await dbGetAll('matches');
  const m = matches.find(x => x.id === matchId);
  if (!m) return;
  activeMatch = m;
  navigate('live-scorer');
}

async function resumeLatestLiveMatch() {
  const matches = await dbGetAll('matches');
  const live = matches.find(m => m.status === 'Live');
  if (live) {
    resumeMatch(live.id);
  } else {
    showToast('No active live matches found.');
    navigate('history');
  }
}

// ==========================================
// CREASE & ROLES MANAGEMENT ON THE FLY
// ==========================================

async function changeStriker(newStrikerId) {
  if (newStrikerId === '__ADD_NEW__') {
    return promptAddPlayerOnTheFly('Striker');
  }
  if (!activeMatch) return;
  const inn = activeMatch.innings[activeMatch.innings.length - 1];
  if (newStrikerId === inn.nonStrikerId) {
    showToast('Striker and Non-Striker cannot be the same player.');
    renderLiveScorerView();
    return;
  }
  inn.strikerId = newStrikerId;
  await saveActiveMatch();
  showToast('Striker updated');
  renderLiveScorerView();
}

async function changeNonStriker(newNonStrikerId) {
  if (newNonStrikerId === '__ADD_NEW__') {
    return promptAddPlayerOnTheFly('Non-Striker');
  }
  if (!activeMatch) return;
  const inn = activeMatch.innings[activeMatch.innings.length - 1];
  if (newNonStrikerId === inn.strikerId) {
    showToast('Non-Striker and Striker cannot be the same player.');
    renderLiveScorerView();
    return;
  }
  inn.nonStrikerId = newNonStrikerId;
  await saveActiveMatch();
  showToast('Non-Striker updated');
  renderLiveScorerView();
}

async function changeBowler(newBowlerId) {
  if (newBowlerId === '__ADD_NEW__') {
    return promptAddPlayerOnTheFly('Bowler');
  }
  if (!activeMatch) return;
  const inn = activeMatch.innings[activeMatch.innings.length - 1];
  inn.bowlerId = newBowlerId;
  await saveActiveMatch();
  showToast('Active Bowler updated');
  renderLiveScorerView();
}

let commentarySeedOffset = 0;

function cycleMatchCommentary() {
  commentarySeedOffset += 1;
  triggerHaptic('normal');
  renderLiveScorerView();
}

function pickVariant(variants, seed) {
  if (!variants || !variants.length) return '';
  return variants[Math.abs(seed) % variants.length];
}

function generateMatchInsights(inn, stats, match) {
  const insights = [];
  const balls = inn.balls || [];
  const totalBallsCount = balls.length;
  const seed = totalBallsCount + commentarySeedOffset;

  const legalBalls = stats.legalDeliveries;
  const overs = legalBalls / 6;
  const crr = overs > 0 ? (stats.totalRuns / overs) : 0;
  const totalOvers = match.overs || 20;
  const totalMaxBalls = totalOvers * 6;
  const ballsRemaining = Math.max(0, totalMaxBalls - legalBalls);

  const striker = stats.batters.find(b => b.id === inn.strikerId);
  const nonStriker = stats.batters.find(b => b.id === inn.nonStrikerId);
  const bowler = stats.bowlers.find(b => b.id === inn.bowlerId);
  const sName = striker ? escapeHTML(striker.name) : 'Striker';
  const nsName = nonStriker ? escapeHTML(nonStriker.name) : 'Non-Striker';
  const bName = bowler ? escapeHTML(bowler.name) : 'Bowler';

  const lastBall = balls[balls.length - 1];

  // A. Instant Last-Ball Reaction Commentary
  if (lastBall) {
    if (lastBall.wicket && lastBall.dismissal !== 'retiredHurt') {
      const wicketLines = [
        `TIMBER & HEARTBREAK! Walk back to the pavilion—<strong>${bName}</strong> & co. are celebrating like they just won the World Cup!`,
        `GONE! Clean as a whistle! That dismissal just flipped the dressing room mood upside down.`,
        `WICKET! New batter incoming—time to check if the bat has a middle or just edges today!`
      ];
      insights.push({ icon: '🚨', tag: 'Wicket', text: pickVariant(wicketLines, seed) });
    } else if (lastBall.batRuns === 6) {
      const sixLines = [
        `MAXIMUM! <strong>${sName}</strong> just sent that ball into orbit—someone check Google Maps for where it landed!`,
        `BOOM! Out of the ground! The bowler is suddenly rethinking their life choices.`,
        `HUGE SIX! <strong>${sName}</strong> didn't just hit that—they gave it a boarding pass!`
      ];
      insights.push({ icon: '🚀', tag: 'Maximum', text: pickVariant(sixLines, seed) });
    } else if (lastBall.batRuns === 4) {
      const fourLines = [
        `CRACKING FOUR! Pierced the gap like a laser—fielders could only admire the view.`,
        `BOUNDARY! <strong>${sName}</strong> found the rope faster than Wi-Fi on full bars!`,
        `FOUR RUNS! Pure timing from <strong>${sName}</strong>—that shot belongs in an art museum.`
      ];
      insights.push({ icon: '💥', tag: 'Boundary', text: pickVariant(fourLines, seed) });
    } else if (lastBall.extraType === 'wide') {
      const wideLines = [
        `WIDE BALL! <strong>${bName}</strong> is bowling to the wide-angle lens today. Free runs on the house!`,
        `WAYWARD! Even the wicket-keeper needed a taxi to reach that one. Extra delivery coming up!`
      ];
      insights.push({ icon: '🙆', tag: 'Extra', text: pickVariant(wideLines, seed) });
    } else if (lastBall.extraType === 'noBall') {
      const nbLines = [
        `NO BALL! Overstepped the line—free gift for <strong>${sName}</strong> and an extra ball to survive!`,
        `SIREN SOUNDS! <strong>${bName}</strong> crossed the line. Batters smiling from ear to ear!`
      ];
      insights.push({ icon: '📢', tag: 'No Ball', text: pickVariant(nbLines, seed) });
    }
  }

  // B. 2nd Innings Chase / 1st Innings Projection & Match Pressure
  if (match.target) {
    const runsNeeded = Math.max(0, match.target - stats.totalRuns);
    if (runsNeeded <= 0) {
      insights.push({ icon: '🏆', tag: 'Victory', text: `GAME OVER! Target chased down in style! Break out the victory snacks!` });
    } else if (ballsRemaining === 0) {
      insights.push({ icon: '🏁', tag: 'Finish', text: `Innings wrapped! Fell short by <strong>${runsNeeded} runs</strong>—what a battle!` });
    } else {
      const rrr = (runsNeeded / (ballsRemaining / 6)).toFixed(2);
      const rrrNum = parseFloat(rrr);
      if (runsNeeded <= 12 && ballsRemaining <= 12) {
        insights.push({
          icon: '💓',
          tag: 'Nail-Biter',
          text: `HEART-STOPPER! Need <strong>${runsNeeded} runs</strong> off <strong>${ballsRemaining} balls</strong>—nail-biting stuff, nobody blink!`
        });
      } else if (rrrNum >= 12.0) {
        insights.push({
          icon: '🌋',
          tag: 'High RRR',
          text: `Need <strong>${runsNeeded} runs</strong> in <strong>${ballsRemaining} balls</strong> (RRR: <strong>${rrr}</strong>). Time for <strong>${sName}</strong> to switch to video-game mode!`
        });
      } else if (rrrNum <= 5.5) {
        insights.push({
          icon: '😎',
          tag: 'Cruising',
          text: `Smooth sailing! Only <strong>${runsNeeded} needed</strong> from <strong>${ballsRemaining} balls</strong> (RRR: <strong>${rrr}</strong> vs CRR: <strong>${crr.toFixed(2)}</strong>).`
        });
      } else {
        insights.push({
          icon: '🎯',
          tag: 'Chase',
          text: `Equation: <strong>${runsNeeded} runs</strong> off <strong>${ballsRemaining} balls</strong> (RRR: <strong>${rrr}</strong> vs CRR: <strong>${crr.toFixed(2)}</strong>). Properly balanced!`
        });
      }
    }
  } else if (overs >= 1) {
    const projected = Math.round(crr * totalOvers);
    const phaseNote = overs <= (totalOvers * 0.3)
      ? 'Powerplay fireworks setting the tone!'
      : overs >= (totalOvers * 0.75)
        ? 'Death overs underway—every run is pure gold!'
        : 'Middle-overs chess match in full swing.';
    insights.push({
      icon: '📊',
      tag: 'Forecast',
      text: `At <strong>${crr.toFixed(2)} RPO</strong>, projecting <strong>~${projected} runs</strong>. ${phaseNote}`
    });
  }

  // C. Batter Milestone & Form Watch
  if (striker) {
    const sr = parseFloat(striker.strikeRate);
    if (striker.runs >= 40 && striker.runs < 50) {
      insights.push({
        icon: '🌟',
        tag: 'Milestone',
        text: `<strong>${sName}</strong> is on <strong>${striker.runs}*</strong>—just <strong>${50 - striker.runs} away</strong> from a well-earned half-century! Raise that bat soon?`
      });
    } else if (striker.runs >= 90 && striker.runs < 100) {
      insights.push({
        icon: '💯',
        tag: 'Nervous 90s',
        text: `NERVOUS NINETIES! <strong>${sName}</strong> on <strong>${striker.runs}*</strong>—only <strong>${100 - striker.runs} runs</strong> from a legendary ton!`
      });
    } else if (striker.balls >= 6 && sr >= 175) {
      insights.push({
        icon: '🔥',
        tag: 'On Fire',
        text: `<strong>${sName}</strong> is seeing it like a beach ball! <strong>${striker.runs} (${striker.balls})</strong> at a blistering <strong>${sr.toFixed(0)} SR</strong>!`
      });
    } else if (striker.balls >= 8 && striker.runs === 0) {
      insights.push({
        icon: '🐢',
        tag: 'Test Mode',
        text: `<strong>${sName}</strong> has played <strong>${striker.balls} dot balls</strong> for 0—someone tell them this isn't a 5-day Test match!`
      });
    }
  }

  // D. Bowler & Pressure / Hat-Trick / Collapse Watch
  const lastTwo = balls.slice(-2);
  if (lastTwo.length === 2 && lastTwo.every(b => b.wicket && b.dismissal !== 'retiredHurt')) {
    insights.push({
      icon: '🎩',
      tag: 'Hat-Trick Alert',
      text: `HAT-TRICK BALL INCOMING! Two wickets in two balls—fielders crowding around the bat like bees!`
    });
  } else if (bowler && bowler.legalBalls >= 6) {
    const econ = parseFloat(bowler.economy);
    if (econ <= 5.0) {
      insights.push({
        icon: '🧊',
        tag: 'Ice Cold',
        text: `<strong>${bName}</strong> has locked down the scoring! Giving away just <strong>${econ.toFixed(2)} RPO</strong> (${bowler.wickets} wkts).`
      });
    } else if (econ >= 12.5) {
      insights.push({
        icon: '🌶️',
        tag: 'Expensive',
        text: `<strong>${bName}</strong> is leaking <strong>${econ.toFixed(2)} RPO</strong>—captain might need a backup plan soon!`
      });
    }
  }

  // E. Recent Over Momentum (Dots vs Boundaries)
  const recent6 = balls.slice(-6);
  if (recent6.length >= 6) {
    const dotsInLast6 = recent6.filter(b => b.batRuns === 0 && !b.extraType && !b.wicket).length;
    const boundariesInLast6 = recent6.filter(b => b.batRuns === 4 || b.batRuns === 6).length;
    if (dotsInLast6 >= 5) {
      insights.push({
        icon: '🧱',
        tag: 'Dot Jail',
        text: `<strong>${dotsInLast6} dot balls</strong> in the last 6 deliveries! Pressure cooker is whistling loud!`
      });
    } else if (boundariesInLast6 >= 3) {
      insights.push({
        icon: '⚡',
        tag: 'Carnage',
        text: `<strong>${boundariesInLast6} boundaries</strong> in the last 6 balls! The scoreboard operator needs an ice pack!`
      });
    }
  }

  // F. Opening / Fallback Cheerful Tips
  if (!insights.length) {
    const openerLines = [
      `Fresh pitch, shiny ball, zero excuses! Let's get the scoreboard ticking for <strong>${sName}</strong> & <strong>${nsName}</strong>!`,
      `Fielders are warmed up, <strong>${bName}</strong> has the ball—first boundary wins bragging rights!`,
      `Match on! Tap the run buttons below and let the live commentary roll!`
    ];
    insights.push({ icon: '🏏', tag: 'Kickoff', text: pickVariant(openerLines, seed) });
  }

  return insights.slice(0, 3);
}

async function renderLiveScorerView() {
  const container = document.getElementById('liveScorerContainer');
  if (!activeMatch && db) {
    try {
      const allMatches = await dbGetAll('matches');
      const liveMatches = allMatches
        .filter(m => m.status === 'Live' || m.status === 'In Progress')
        .sort((a, b) => (b.updated || b.created || 0) - (a.updated || a.created || 0));
      if (liveMatches.length > 0) {
        activeMatch = liveMatches[0];
      }
    } catch (e) {}
  }
  if (!activeMatch) {
    container.innerHTML = `
      <div class="empty-state">
        <p>No match is currently selected for live scoring.</p>
        <button class="btn btn-primary" style="margin-top:10px;" onclick="navigate('create-match')">Create New Match</button>
      </div>
    `;
    return;
  }

  const [teams, allPlayers] = await Promise.all([dbGetAll('teams'), dbGetAll('players')]);
  const inn = activeMatch.innings[activeMatch.innings.length - 1];
  const battingTeamName = teams.find(t => t.id === inn.batting)?.name || 'Batting Team';
  const bowlingTeamName = teams.find(t => t.id === inn.bowling)?.name || 'Bowling Team';

  // Compute live scorecard metrics
  const stats = CricketEngine.calculateInnings(inn, inn.squad, inn.bowlingSquad);

  const striker = inn.squad.find(p => p.id === inn.strikerId) || inn.squad[0];
  const nonStriker = inn.squad.find(p => p.id === inn.nonStrikerId) || inn.squad[1];
  const bowler = inn.bowlingSquad.find(p => p.id === inn.bowlerId) || inn.bowlingSquad[0];

  const strikerStats = stats.batters.find(b => b.id === striker?.id) || { runs: 0, balls: 0, fours: 0, sixes: 0, strikeRate: '0.0' };
  const nonStrikerStats = stats.batters.find(b => b.id === nonStriker?.id) || { runs: 0, balls: 0, fours: 0, sixes: 0, strikeRate: '0.0' };
  const bowlerStats = stats.bowlers.find(b => b.id === bowler?.id) || { oversFormatted: '0.0', runsConceded: 0, wickets: 0, economy: '0.00' };

  // Current over balls & runs tally
  const recentBalls = inn.balls.slice(-8);
  const currentOverLegalStart = Math.floor(stats.legalDeliveries / 6) * 6;
  let runningLegal = 0;
  let thisOverRuns = 0;
  (inn.balls || []).forEach(b => {
    const isLegal = b.extraType !== 'wide' && b.extraType !== 'noBall' && b.extraType !== 'penalty';
    if (runningLegal >= currentOverLegalStart) {
      thisOverRuns += (b.batRuns || 0) + (b.extraRuns || 0);
    }
    if (isLegal) runningLegal += 1;
  });

  // Available batters & bowlers for dropdown selection (Alphabetical A-Z)
  const dismissedIds = new Set(stats.fallOfWickets.map(f => f.playerId || ''));
  const availableBatters = inn.squad.filter(p => !dismissedIds.has(p.id) || p.id === inn.strikerId || p.id === inn.nonStrikerId)
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
  const sortedBowlers = [...(inn.bowlingSquad || [])]
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
  const matchInsights = generateMatchInsights(inn, stats, activeMatch);

  let winProbHTML = '';
  if (activeMatch.target) {
    const totalMaxBalls = (activeMatch.overs || 20) * 6;
    const ballsLeft = Math.max(0, totalMaxBalls - stats.legalDeliveries);
    const runsNeeded = Math.max(0, activeMatch.target - stats.totalRuns);
    const maxWkts = Math.max(1, (inn.squad?.length || 11) - 1);
    const wktsLeft = Math.max(0, maxWkts - stats.wickets);

    let batWinPct = 50;
    if (runsNeeded <= 0) batWinPct = 100;
    else if (ballsLeft === 0 || wktsLeft === 0) batWinPct = 0;
    else {
      const rrr = runsNeeded / (ballsLeft / 6);
      const wktFactor = (wktsLeft / maxWkts) * 35;
      const rateFactor = Math.max(0, Math.min(65, (14 - rrr) * 5.5));
      batWinPct = Math.round(Math.max(4, Math.min(96, wktFactor + rateFactor)));
    }
    const bowlWinPct = 100 - batWinPct;
    winProbHTML = `
      <div class="win-prob-card">
        <div class="win-prob-labels">
          <span style="color:var(--primary);">${escapeHTML(battingTeamName)} ${batWinPct}%</span>
          <span class="muted">Win Probability</span>
          <span style="color:var(--accent);">${bowlWinPct}% ${escapeHTML(bowlingTeamName)}</span>
        </div>
        <div class="win-prob-track">
          <div class="win-prob-fill-bat" style="width:${batWinPct}%;"></div>
          <div class="win-prob-fill-bowl" style="width:${bowlWinPct}%;"></div>
        </div>
      </div>
    `;
  }

  let chaseBarHTML = '';
  if (activeMatch.target) {
    const totalMaxBallsChase = (activeMatch.overs || 20) * 6;
    const ballsLeftChase = Math.max(0, totalMaxBallsChase - stats.legalDeliveries);
    const runsNeededChase = Math.max(0, activeMatch.target - stats.totalRuns);
    const rrrChase = ballsLeftChase > 0 ? (runsNeededChase / (ballsLeftChase / 6)) : 0;
    const pctDone = Math.min(100, Math.max(4, Math.round((stats.totalRuns / Math.max(1, activeMatch.target)) * 100)));
    const pressureCls = runsNeededChase === 0 ? 'ahead' : rrrChase <= 8.5 ? 'ahead' : rrrChase <= 11.5 ? 'balanced' : 'pressure';
    const statusText = runsNeededChase === 0
      ? `🎉 Target of ${activeMatch.target} achieved!`
      : `Need <strong>${runsNeededChase}</strong> run${runsNeededChase === 1 ? '' : 's'} in <strong>${ballsLeftChase}</strong> ball${ballsLeftChase === 1 ? '' : 's'} · RRR <strong>${rrrChase.toFixed(2)}</strong>`;
    chaseBarHTML = `
      <div class="chase-bar-box">
        <div class="chase-bar-top">
          <span>${statusText}</span>
          <span style="color:var(--primary);">${pctDone}%</span>
        </div>
        <div class="chase-bar-track">
          <div class="chase-bar-fill ${pressureCls}" style="width:${pctDone}%;"></div>
        </div>
      </div>
    `;
  }

  const capRule = document.getElementById('settingBowlerCap')?.value || 'oneFifth';
  const matchOvers = activeMatch.overs || 20;
  let maxBowlerOvers = null;
  if (capRule === 'oneFifth') maxBowlerOvers = Math.max(1, Math.ceil(matchOvers / 5));
  else if (capRule === 'oneFourth') maxBowlerOvers = Math.max(1, Math.ceil(matchOvers / 4));
  const bowlerOversBowled = (bowlerStats.legalBalls || 0) / 6;
  const isBowlerCapped = maxBowlerOvers !== null && bowler && bowlerOversBowled >= maxBowlerOvers;

  const pInfo = stats.partnership || { runs: 0, balls: 0, contrib: {} };
  const sPart = striker ? (pInfo.contrib[striker.id] || { runs: 0, balls: 0 }) : { runs: 0, balls: 0 };
  const nsPart = nonStriker ? (pInfo.contrib[nonStriker.id] || { runs: 0, balls: 0 }) : { runs: 0, balls: 0 };

  const totalMaxBalls = matchOvers * 6;
  const ballsRem = Math.max(0, totalMaxBalls - stats.legalDeliveries);
  const crr = stats.legalDeliveries > 0 ? (stats.totalRuns / (stats.legalDeliveries / 6)).toFixed(2) : '0.00';
  const runsReq = activeMatch.target ? Math.max(0, activeMatch.target - stats.totalRuns) : '--';
  const rrr = (activeMatch.target && ballsRem > 0) ? (runsReq / (ballsRem / 6)).toFixed(2) : '--';
  const ppOvers = Math.max(1, Math.round(matchOvers * 0.3));
  const currentOverFloat = stats.legalDeliveries / 6;
  const phaseLabel = currentOverFloat < ppOvers
    ? `🔥 <strong>Powerplay:</strong> 0.1 – ${ppOvers}.0 Overs`
    : currentOverFloat >= (matchOvers * 0.75)
      ? `⚡ <strong>Death Overs:</strong> Final Stretch`
      : `🏏 <strong>Middle Overs:</strong> Building Momentum`;

  container.innerHTML = `
    <!-- Top Match Header (Broadcast Hero Card) -->
    <div class="scorer-broadcast-hero">
      <div class="hlh-top-row">
        <span class="broadcast-match-meta" style="font-size:11px; font-weight:800; letter-spacing:0.7px; text-transform:uppercase; color:var(--text-muted);">${escapeHTML(activeMatch.format || 'T20')} MATCH · ${activeMatch.isSuperOver ? 'Super Over' : (activeMatch.innings.length === 1 ? '1st Innings' : '2nd Innings')}</span>
        <div style="display:flex; align-items:center; gap:6px;">
          <button type="button" class="pill-btn" style="padding:3px 9px; font-size:10px; font-weight:900;" onclick="shareLiveMatchLink('${activeMatch.id}')" title="Share Public Live Score Link">📤 Share Live</button>
          <span class="scorer-live-pill"><span class="scorer-live-dot"></span> ${escapeHTML(activeMatch.status.toUpperCase())}</span>
        </div>
      </div>

      <div class="hlh-teams-score-row">
        <div class="hlh-team-col">
          ${buildHomeTeamShieldSVG(battingTeamName, 'a')}
          <span class="hlh-team-label">${escapeHTML(battingTeamName)}</span>
        </div>

        <div class="hlh-score-center">
          <div class="hlh-big-score">${stats.totalRuns} / ${stats.wickets}</div>
          <div class="hlh-overs-label">(${stats.oversFormatted} / ${matchOvers} ov)</div>
        </div>

        <div class="hlh-team-col">
          ${buildHomeTeamShieldSVG(bowlingTeamName, 'b')}
          <span class="hlh-team-label">${escapeHTML(bowlingTeamName)}</span>
        </div>
      </div>

      <div class="hlh-metrics-strip" style="grid-template-columns: repeat(6, 1fr);">
        <div class="hlh-m-cell"><span>CRR</span><strong>${crr}</strong></div>
        <div class="hlh-m-cell"><span>RRR</span><strong>${rrr}</strong></div>
        <div class="hlh-m-cell"><span>Target</span><strong>${activeMatch.target || '--'}</strong></div>
        <div class="hlh-m-cell"><span>Runs Req.</span><strong>${runsReq}</strong></div>
        <div class="hlh-m-cell"><span>Balls Rem.</span><strong>${ballsRem}</strong></div>
        <div class="hlh-m-cell"><span>Extras</span><strong>${stats.extras.total}</strong></div>
      </div>

      <div class="scorer-phase-strip" style="justify-content:space-between; flex-wrap:wrap; gap:6px;">
        <span>${phaseLabel}</span>
        <span style="font-size:10px; font-weight:800; color:var(--primary); background:var(--primary-glow); border:1px solid var(--primary); padding:2px 7px; border-radius:20px;">Extras: ${stats.extras.total || 0} (wd ${stats.extras.wide || 0}, nb ${stats.extras.noBall || 0}, b ${stats.extras.bye || 0}, lb ${stats.extras.legBye || 0}${(stats.extras.penalty || 0) > 0 ? `, pen ${stats.extras.penalty}` : ''})</span>
      </div>
      ${chaseBarHTML}
      ${winProbHTML}
    </div>

    ${buildFreeHitBannerHTML(inn)}

    <!-- High-Contrast Match-Day Tools 4-Tile Control Bar -->
    <div class="matchday-tools-card">
      <div class="mdt-header-row">
        <span class="mdt-header-title">🛠️ Match-Day Tools</span>
        <span class="muted" style="font-size:10px; font-weight:700;">Tap to configure</span>
      </div>
      <div class="mdt-grid-4">
        <button type="button" class="mdt-tile-btn wheel-tile ${getActiveCustomGroundRules().length ? 'active' : ''}" onclick="openCustomGroundRulesModal()">
          <div class="mdt-tile-top">
            <span class="mdt-tile-icon">⚡</span>
            <span class="mdt-tile-badge">${getActiveCustomGroundRules().length} ON</span>
          </div>
          <span class="mdt-tile-title">Ground Rules</span>
          <span class="mdt-tile-sub">Add / edit box rules</span>
        </button>

        <button type="button" class="mdt-tile-btn pin-tile" onclick="openCoScorerPinModal()">
          <div class="mdt-tile-top">
            <span class="mdt-tile-icon">🔑</span>
            <span class="mdt-tile-badge">${activeMatch.handoverPin ? activeMatch.handoverPin : '4-PIN'}</span>
          </div>
          <span class="mdt-tile-title">Share PIN</span>
          <span class="mdt-tile-sub">Co-scorer handover</span>
        </button>

        <button type="button" class="mdt-tile-btn dls-tile" onclick="openDlsRevisionModal()">
          <div class="mdt-tile-top">
            <span class="mdt-tile-icon">🌧️</span>
            <span class="mdt-tile-badge">${matchOvers} OV</span>
          </div>
          <span class="mdt-tile-title">DLS / Overs</span>
          <span class="mdt-tile-sub">Rain target &amp; overs</span>
        </button>

        <button type="button" class="mdt-tile-btn wheel-tile ${shotWheelEnabled ? 'active' : ''}" onclick="toggleShotWheelPreference(!shotWheelEnabled)">
          <div class="mdt-tile-top">
            <span class="mdt-tile-icon">🎯</span>
            <span class="mdt-tile-badge">${shotWheelEnabled ? 'ON' : 'OFF'}</span>
          </div>
          <span class="mdt-tile-title">Shot Wheel</span>
          <span class="mdt-tile-sub">${shotWheelEnabled ? 'ON · Boundary map' : 'Tap to enable 4/6'}</span>
        </button>
      </div>
    </div>

    <div class="scorer-desktop-split">
    <div class="scorer-split-col">
    <!-- Live Match Insights -->
    <div class="insights-box">
      <div class="insights-header">
        <span>🎙️ Live Match Pulse & Commentary</span>
        <button type="button" class="insights-refresh-btn" onclick="cycleMatchCommentary()" title="Cycle Commentary Line">🎲 Next Line</button>
      </div>
      <div class="insights-list">
        ${matchInsights.map(item => `
          <div class="insight-item">
            <span class="insight-icon">${item.icon}</span>
            <span>${item.tag ? `<span class="insight-tag">${escapeHTML(item.tag)}</span>` : ''}${item.text}</span>
          </div>
        `).join('')}
      </div>
    </div>

    <!-- Crease & Bowler Dropdown Manager -->
    <div class="card crease-manager-card">
      <div class="eyebrow" style="margin-bottom:6px;">Manage Crease & Bowler on the fly</div>
      <div class="crease-dropdown-row">
        <div class="crease-selector-group">
          <label>Striker (★)</label>
          <select class="crease-select striker-select" onchange="changeStriker(this.value)">
            ${!inn.strikerId ? '<option value="" selected disabled>Select Striker</option>' : ''}
            ${availableBatters.map(p => `
              <option value="${p.id}" ${p.id === inn.strikerId ? 'selected' : ''}>★ ${escapeHTML(p.name)}</option>
            `).join('')}
            <option value="__ADD_NEW__">＋ Type New Batter...</option>
          </select>
        </div>

        <div class="crease-selector-group">
          <label>Non-Striker</label>
          <select class="crease-select" onchange="changeNonStriker(this.value)">
            ${!inn.nonStrikerId ? '<option value="" selected disabled>Select Non-Striker</option>' : ''}
            ${availableBatters.map(p => `
              <option value="${p.id}" ${p.id === inn.nonStrikerId ? 'selected' : ''}>${escapeHTML(p.name)}</option>
            `).join('')}
            <option value="__ADD_NEW__">＋ Type New Batter...</option>
          </select>
        </div>

        <div class="crease-selector-group">
          <label>Current Bowler</label>
          <select class="crease-select bowler-select" onchange="changeBowler(this.value)">
            ${!inn.bowlerId ? '<option value="" selected disabled>Select Bowler</option>' : ''}
            ${sortedBowlers.map(b => `
              <option value="${b.id}" ${b.id === inn.bowlerId ? 'selected' : ''}>⚡ ${escapeHTML(b.name)}</option>
            `).join('')}
            <option value="__ADD_NEW__">＋ Type New Bowler...</option>
          </select>
        </div>
      </div>
    </div>

    <!-- On-Crease Batters & Active Bowler Live Stats -->
    <div class="card" style="padding:10px;">
      <table class="crease-table">
        <thead>
          <tr>
            <th>Batter</th>
            <th>R</th>
            <th>B</th>
            <th>4s</th>
            <th>6s</th>
            <th>SR</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><span class="striker-indicator">★</span> <strong>${escapeHTML(striker?.name || 'Striker')}</strong>${renderBatterMilestoneBadges(strikerStats.runs)}</td>
            <td><strong>${strikerStats.runs}</strong></td>
            <td>${strikerStats.balls}</td>
            <td>${strikerStats.fours}</td>
            <td>${strikerStats.sixes}</td>
            <td>${strikerStats.strikeRate}</td>
          </tr>
          <tr>
            <td>&nbsp;&nbsp;${escapeHTML(nonStriker?.name || 'Non-Striker')}${renderBatterMilestoneBadges(nonStrikerStats.runs)}</td>
            <td><strong>${nonStrikerStats.runs}</strong></td>
            <td>${nonStrikerStats.balls}</td>
            <td>${nonStrikerStats.fours}</td>
            <td>${nonStrikerStats.sixes}</td>
            <td>${nonStrikerStats.strikeRate}</td>
          </tr>
        </tbody>
      </table>

      <table class="crease-table" style="margin-top:10px;">
        <thead>
          <tr>
            <th>Bowler</th>
            <th>O</th>
            <th>R</th>
            <th>W</th>
            <th>ECON</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              ⚡ <strong>${escapeHTML(bowler?.name || 'Bowler')}</strong>${bowlerStats.wickets >= 5 ? `<span class="sc-5w-badge" title="5-Wicket Haul">5W🔥</span>` : ''}
              ${isBowlerCapped ? `<br><span class="bowler-cap-warn">⚠️ Quota Reached (${maxBowlerOvers} ov max)</span>` : ''}
            </td>
            <td>${bowlerStats.oversFormatted}</td>
            <td>${bowlerStats.runsConceded}</td>
            <td><strong style="color:var(--danger);">${bowlerStats.wickets}</strong></td>
            <td>${bowlerStats.economy}</td>
          </tr>
        </tbody>
      </table>

      <div class="partnership-strip">
        <span>🤝 Partnership: <strong>${pInfo.runs} (${pInfo.balls})</strong></span>
        <span class="muted">${escapeHTML(striker?.name || 'Striker')}: ${sPart.runs}(${sPart.balls}) · ${escapeHTML(nonStriker?.name || 'Non-Striker')}: ${nsPart.runs}(${nsPart.balls})</span>
      </div>
    </div>

    </div>
    <div class="scorer-split-col">
    <!-- Over Timeline Strip -->
    <div class="card" style="padding:10px 14px;">
      <div class="over-timeline-header">
        <div class="eyebrow" style="margin:0;">Recent Deliveries</div>
        <span class="over-runs-badge">This Over: ${thisOverRuns} run${thisOverRuns === 1 ? '' : 's'}</span>
      </div>
      <div class="timeline-strip">
        ${recentBalls.length ? recentBalls.map(b => {
          const isDot = !b.wicket && !b.extraType && (b.batRuns || 0) === 0;
          const cls = b.batRuns === 4 ? 'four' : b.batRuns === 6 ? 'six' : b.wicket ? 'wicket' : b.extraType ? 'extra' : isDot ? 'dot' : '';
          const lbl = b.wicket ? 'W' : b.extraType ? b.extraType.slice(0,2).toUpperCase() : isDot ? '·' : b.batRuns;
          return `<div class="timeline-ball ${cls}">${lbl}</div>`;
        }).join('') : '<span class="muted" style="font-size:12px;">Over in progress...</span>'}
      </div>
    </div>

    <!-- Scoring Touch Keypad -->
    <div class="card scoring-keypad-panel">
      ${buildActiveRuleQuickTriggersHTML()}
      <div class="keypad-grid-numbers">
        <button class="key-touch" onclick="recordBallEvent(0)">0</button>
        <button class="key-touch" onclick="recordBallEvent(1)">1</button>
        <button class="key-touch" onclick="recordBallEvent(2)">2</button>
        <button class="key-touch" onclick="recordBallEvent(3)">3</button>
        <button class="key-touch four" onclick="recordBallEvent(4)">4</button>
        <button class="key-touch" onclick="recordBallEvent(5)">5</button>
        <button class="key-touch six" onclick="recordBallEvent(6)">6</button>
      </div>

      <div class="keypad-grid-extras">
        <button class="key-touch extra-key" onclick="openExtraModal('wide')">WD</button>
        <button class="key-touch extra-key" onclick="openExtraModal('noBall')">NB</button>
        <button class="key-touch extra-key" onclick="openExtraModal('bye')">BYE</button>
        <button class="key-touch extra-key" onclick="openExtraModal('legBye')">LB</button>
        <button class="key-touch wicket" onclick="openWicketModal()">WICKET</button>
      </div>

      <div class="aux-controls-row">
        <button class="btn btn-secondary" onclick="swapStrike()">⇄ Swap</button>
        <button class="btn btn-secondary" onclick="openBowlerSelectModal()">⚡ Bowler</button>
        <button class="btn btn-outline" onclick="openBallLogEditorModal()">📝 Edit Log</button>
        <button class="btn btn-outline" onclick="undoLastDelivery()">↶ Undo</button>
      </div>

      <div class="aux-controls-row" style="margin-top:6px;">
        <button class="btn btn-secondary" onclick="viewDetailedScorecard(activeMatch.id)">📋 Scorecard</button>
        <button class="btn btn-secondary" onclick="endInningsPrompt(false)">End Inn</button>
        ${activeMatch.format === 'Test' ? `<button class="btn btn-secondary" onclick="endInningsPrompt(true)">Declare</button>` : ''}
        <button class="btn btn-primary" onclick="finishMatchPrompt()">Finish</button>
      </div>


    </div>
    </div>
    </div>
  `;
}


// ==========================================
// BROADCAST EVENT ANIMATIONS ENGINE (4, 6, WICKETS, 50/100)
// ==========================================
let broadcastFxEnabled = true;
try {
  const savedFx = localStorage.getItem('cricscorer_fx_enabled');
  if (savedFx === '0') broadcastFxEnabled = false;
} catch (e) {}

const broadcastFxQueue = [];
let isBroadcastFxPlaying = false;

function syncFxToggleBtn() {
  const btn = document.getElementById('fxToggleBtn');
  if (!btn) return;
  btn.innerHTML = broadcastFxEnabled
    ? '✨ FX<span class="fx-btn-detail">: ON</span>'
    : '✨ FX<span class="fx-btn-detail">: OFF</span>';
  btn.classList.toggle('active', broadcastFxEnabled);
}

function toggleBroadcastFx() {
  broadcastFxEnabled = !broadcastFxEnabled;
  try {
    localStorage.setItem('cricscorer_fx_enabled', broadcastFxEnabled ? '1' : '0');
  } catch (e) {}
  syncFxToggleBtn();
  showToast(broadcastFxEnabled ? 'On-screen celebration animations enabled' : 'On-screen celebration animations muted');
}

function getBatterRunsFromInnings(inn, batterId) {
  if (!inn || !batterId) return 0;
  const stats = CricketEngine.calculateInnings(inn, inn.squad, inn.bowlingSquad);
  const found = stats.batters.find(b => b.id === batterId);
  return found ? found.runs : 0;
}

function buildWicketGraphicSVG(dismissalType) {
  if (dismissalType === 'lbw') {
    return `
      <svg width="96" height="62" viewBox="0 0 100 66">
        <rect x="30" y="14" width="6" height="44" rx="2" fill="#e2e8f0"/>
        <rect x="47" y="14" width="6" height="44" rx="2" fill="#e2e8f0"/>
        <rect x="64" y="14" width="6" height="44" rx="2" fill="#e2e8f0"/>
        <circle class="fx-lbw-dot" cx="50" cy="24" r="5" fill="#ef4444" stroke="#ffffff" stroke-width="1.5"/>
        <circle class="fx-lbw-dot" cx="50" cy="36" r="5" fill="#ef4444" stroke="#ffffff" stroke-width="1.5"/>
        <circle class="fx-lbw-dot" cx="50" cy="48" r="5" fill="#ef4444" stroke="#ffffff" stroke-width="1.5"/>
      </svg>`;
  }
  if (dismissalType === 'caught' || dismissalType === 'caughtAndBowled') {
    return `
      <svg width="96" height="62" viewBox="0 0 100 66">
        <circle cx="50" cy="33" r="24" fill="rgba(255,255,255,0.12)" stroke="#fca5a5" stroke-width="2" stroke-dasharray="4 3"/>
        <circle cx="50" cy="33" r="13" fill="#ffffff"/>
        <path d="M 41 25 Q 50 32 59 25" fill="none" stroke="#dc2626" stroke-width="2.2" stroke-linecap="round"/>
        <path d="M 41 41 Q 50 34 59 41" fill="none" stroke="#dc2626" stroke-width="2.2" stroke-linecap="round"/>
      </svg>`;
  }
  // Bowled, Run Out, Stumped, Hit Wicket & other special dismissals
  return `
    <svg width="104" height="64" viewBox="0 0 104 68">
      <rect x="32" y="18" width="6" height="44" rx="2" fill="#f8fafc"/>
      <rect x="49" y="18" width="6" height="44" rx="2" fill="#f8fafc"/>
      <rect class="fx-stump-tilt" x="66" y="18" width="6" height="44" rx="2" fill="#fca5a5"/>
      <rect class="fx-bail-left" x="31" y="13" width="19" height="4" rx="2" fill="#fbbf24"/>
      <rect class="fx-bail-right" x="54" y="13" width="19" height="4" rx="2" fill="#fbbf24"/>
    </svg>`;
}

function buildFxParticlesHTML(colors) {
  let out = '';
  const count = 18;
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count;
    const dist = 75 + (i % 3) * 34;
    const dx = Math.round(Math.cos(angle) * dist);
    const dy = Math.round(Math.sin(angle) * dist);
    const color = colors[i % colors.length];
    out += `<span class="fx-particle" style="--dx:${dx}px; --dy:${dy}px; background:${color}; box-shadow:0 0 8px ${color};"></span>`;
  }
  return out;
}

function queueBroadcastFx(eventPayload) {
  if (!broadcastFxEnabled) return;
  broadcastFxQueue.push(eventPayload);
  if (!isBroadcastFxPlaying) {
    playNextBroadcastFx();
  }
}

function playNextBroadcastFx() {
  const stage = document.getElementById('broadcastFxStage');
  if (!stage || broadcastFxQueue.length === 0) {
    isBroadcastFxPlaying = false;
    if (stage) stage.innerHTML = '';
    return;
  }

  isBroadcastFxPlaying = true;
  const ev = broadcastFxQueue.shift();
  let cardHTML = '';

  if (ev.type === 'FOUR') {
    cardHTML = `
      <div class="fx-card-shell fx-four">
        <div class="fx-laser-sweep"></div>
        ${buildFxParticlesHTML(['#34d399', '#38bdf8', '#ffffff'])}
        <div class="fx-kicker">BOUNDARY LASER</div>
        <div class="fx-big-title">FOUR! • +4</div>
        <div class="fx-sub-detail">${escapeHTML(ev.batterName || 'Batter')} (${ev.runs || 0}*)</div>
        <div class="fx-badge-pill">CRACKING SHOT TO THE FENCE</div>
      </div>`;
  } else if (ev.type === 'SIX') {
    cardHTML = `
      <div class="fx-card-shell fx-six">
        ${buildFxParticlesHTML(['#fbbf24', '#34d399', '#f97316', '#ffffff'])}
        <div class="fx-kicker">MAXIMUM TRAJECTORY</div>
        <div class="fx-big-title">SIX! • +6</div>
        <div class="fx-sub-detail">${escapeHTML(ev.batterName || 'Batter')} (${ev.runs || 0}*)</div>
        <div class="fx-badge-pill">OUT OF THE GROUND!</div>
      </div>`;
  } else if (ev.type === 'WICKET') {
    const dismissalLabels = {
      bowled: 'CLEAN BOWLED!',
      caught: 'CAUGHT OUT!',
      caughtAndBowled: 'CAUGHT & BOWLED!',
      lbw: 'LBW • PLUMB IN FRONT!',
      runOut: 'DIRECT HIT • RUN OUT!',
      stumped: 'LIGHTNING STUMPED!',
      hitWicket: 'HIT WICKET!',
      retiredHurt: 'RETIRED HURT',
      retiredOut: 'RETIRED OUT',
      obstructingTheField: 'OBSTRUCTING THE FIELD',
      hitBallTwice: 'HIT THE BALL TWICE',
      timedOut: 'TIMED OUT'
    };
    const title = dismissalLabels[ev.dismissal] || 'WICKET!';
    cardHTML = `
      <div class="fx-card-shell fx-wicket">
        ${buildFxParticlesHTML(['#f87171', '#fbbf24', '#ffffff'])}
        <div class="fx-svg-stage">${buildWicketGraphicSVG(ev.dismissal)}</div>
        <div class="fx-kicker">DISMISSAL BREAKTHROUGH</div>
        <div class="fx-big-title" style="font-size:23px;">${title}</div>
        <div class="fx-sub-detail">${escapeHTML(ev.batterName || 'Batter')} — ${ev.batterRuns || 0} (${ev.batterBalls || 0}b)</div>
        ${ev.creditText ? `<div class="fx-badge-pill">${escapeHTML(ev.creditText)}</div>` : ''}
      </div>`;
  } else if (ev.type === 'MILESTONE_50') {
    cardHTML = `
      <div class="fx-card-shell fx-milestone">
        ${buildFxParticlesHTML(['#38bdf8', '#34d399', '#ffffff'])}
        <div class="fx-kicker">BATTER MILESTONE</div>
        <div class="fx-big-title" style="font-size:24px;">🌟 HALF-CENTURY!</div>
        <div class="fx-sub-detail">${escapeHTML(ev.batterName || 'Batter')} reaches ${ev.runs}* (${ev.balls} balls)</div>
        <div class="fx-badge-pill">50★ SCORECARD BADGE UNLOCKED</div>
      </div>`;
  } else if (ev.type === 'MILESTONE_100') {
    cardHTML = `
      <div class="fx-card-shell fx-century">
        ${buildFxParticlesHTML(['#facc15', '#fb923c', '#34d399', '#ffffff'])}
        <div class="fx-kicker">SENSATIONAL INNINGS</div>
        <div class="fx-big-title" style="font-size:24px;">👑 CENTURY! 100</div>
        <div class="fx-sub-detail">${escapeHTML(ev.batterName || 'Batter')} powers to ${ev.runs}* (${ev.balls} balls)</div>
        <div class="fx-badge-pill">100👑 SCORECARD CROWN UNLOCKED</div>
      </div>`;
  } else if (ev.type === 'TEAM_MILESTONE') {
    cardHTML = `
      <div class="fx-card-shell fx-team-milestone">
        <div class="fx-laser-sweep"></div>
        ${buildFxParticlesHTML(['#34d399', '#38bdf8', '#fbbf24', '#ffffff'])}
        <div class="fx-kicker">TEAM SCORE MILESTONE</div>
        <div class="fx-big-title" style="font-size:24px;">🏟️ TEAM ${ev.milestone} UP!</div>
        <div class="fx-sub-detail">${escapeHTML(ev.teamName || 'Batting Team')} · ${ev.scoreStr} (${ev.oversStr} ov)</div>
        <div class="fx-badge-pill">CURRENT RUN RATE: ${ev.crr}</div>
      </div>`;
  } else if (ev.type === 'FIVE_WICKET') {
    cardHTML = `
      <div class="fx-card-shell fx-five-wicket">
        ${buildFxParticlesHTML(['#e879f9', '#fbbf24', '#f87171', '#ffffff'])}
        <div class="fx-kicker">SENSATIONAL SPELL</div>
        <div class="fx-big-title" style="font-size:23px;">🎳 5-WICKET HAUL!</div>
        <div class="fx-sub-detail">${escapeHTML(ev.bowlerName || 'Bowler')} · ${ev.figures} (${ev.overs} ov)</div>
        <div class="fx-badge-pill">5W🔥 BOWLING BADGE UNLOCKED</div>
      </div>`;
  } else if (ev.type === 'ALL_OUT') {
    cardHTML = `
      <div class="fx-card-shell fx-all-out">
        ${buildFxParticlesHTML(['#fb7185', '#fbbf24', '#ffffff'])}
        <div class="fx-svg-stage">${buildWicketGraphicSVG('bowled')}</div>
        <div class="fx-kicker">INNINGS CONCLUDED</div>
        <div class="fx-big-title" style="font-size:24px;">💥 ALL OUT!</div>
        <div class="fx-sub-detail">${escapeHTML(ev.teamName || 'Batting Team')} · ${ev.scoreStr} (${ev.oversStr} ov)</div>
        <div class="fx-badge-pill">${escapeHTML(ev.subNote || 'END OF BATTING INNINGS')}</div>
      </div>`;
  }

  stage.innerHTML = cardHTML;
  setTimeout(() => {
    playNextBroadcastFx();
  }, 2350);
}

function checkAndQueueBatterMilestones(inn, batterId, prevRuns) {
  if (!inn || !batterId) return;
  const stats = CricketEngine.calculateInnings(inn, inn.squad, inn.bowlingSquad);
  const b = stats.batters.find(p => p.id === batterId);
  if (!b) return;
  if (prevRuns < 50 && b.runs >= 50 && b.runs < 100) {
    queueBroadcastFx({ type: 'MILESTONE_50', batterName: b.name, runs: b.runs, balls: b.balls });
  } else if (prevRuns < 100 && b.runs >= 100) {
    queueBroadcastFx({ type: 'MILESTONE_100', batterName: b.name, runs: b.runs, balls: b.balls });
  }
}


function checkAndQueueTeamScoreMilestones(inn, prevTeamRuns, teamName) {
  if (!inn) return;
  const stats = CricketEngine.calculateInnings(inn, inn.squad, inn.bowlingSquad);
  const newRuns = stats.totalRuns;
  if (newRuns <= prevTeamRuns) return;
  const prevBucket = Math.floor(prevTeamRuns / 50);
  const newBucket = Math.floor(newRuns / 50);
  if (newBucket > prevBucket && newBucket >= 1) {
    const milestone = newBucket * 50;
    const crr = stats.legalDeliveries > 0 ? ((stats.totalRuns / stats.legalDeliveries) * 6).toFixed(2) : '0.00';
    queueBroadcastFx({
      type: 'TEAM_MILESTONE',
      milestone,
      teamName: teamName || 'Batting Team',
      scoreStr: `${stats.totalRuns}/${stats.wickets}`,
      oversStr: stats.oversFormatted,
      crr
    });
  }
}

function checkAndQueueBowlerFiveWicketHaul(inn, bowlerId, prevBowlerWickets) {
  if (!inn || !bowlerId) return;
  const stats = CricketEngine.calculateInnings(inn, inn.squad, inn.bowlingSquad);
  const bo = stats.bowlers.find(b => b.id === bowlerId);
  if (!bo) return;
  if (prevBowlerWickets < 5 && bo.wickets >= 5) {
    queueBroadcastFx({
      type: 'FIVE_WICKET',
      bowlerName: bo.name,
      figures: `${bo.wickets}/${bo.runsConceded}`,
      overs: bo.oversFormatted
    });
  }
}

function checkAndQueueAllOutFx(inn, teamName) {
  if (!inn) return;
  const stats = CricketEngine.calculateInnings(inn, inn.squad, inn.bowlingSquad);
  const squadCount = (inn.squad || []).length;
  const maxWickets = squadCount >= 2 ? (squadCount - 1) : 10;
  if (stats.wickets >= maxWickets) {
    const isFirstInnings = activeMatch && activeMatch.innings && activeMatch.innings.length === 1;
    queueBroadcastFx({
      type: 'ALL_OUT',
      teamName: teamName || 'Batting Team',
      scoreStr: `${stats.totalRuns}/${stats.wickets}`,
      oversStr: stats.oversFormatted,
      subNote: isFirstInnings ? `TARGET FOR CHASE: ${stats.totalRuns + 1}` : '2ND INNINGS COMPLETED'
    });
  }
}

function renderBatterMilestoneBadges(runs) {
  if (runs >= 100) {
    return `<span class="sc-milestone-badge sc-milestone-100" title="Century (100+)">100👑</span>`;
  }
  if (runs >= 50) {
    return `<span class="sc-milestone-badge sc-milestone-50" title="Half-Century (50+)">50★</span>`;
  }
  return '';
}

// Ball Recording Logic
async function recordBallEvent(runs) {
  if (!activeMatch) return;
  const inn = activeMatch.innings[activeMatch.innings.length - 1];

  if (!inn.strikerId || !inn.nonStrikerId || !inn.bowlerId) {
    alert('Please set Striker, Non-Striker, and Bowler using the dropdowns above before scoring deliveries.');
    return;
  }

  const scoringBatterId = inn.strikerId;
  const prevBatterRuns = getBatterRunsFromInnings(inn, scoringBatterId);

  const ball = {
    id: generateId(),
    batterId: scoringBatterId,
    nonStrikerId: inn.nonStrikerId,
    bowlerId: inn.bowlerId,
    batRuns: runs,
    extraType: null,
    extraRuns: 0,
    extraTotal: 0,
    wicket: false,
    dismissal: 'none',
    timestamp: Date.now()
  };

  inn.balls.push(ball);

  const updatedBatterRuns = prevBatterRuns + runs;
  const batterName = inn.squad.find(p => p.id === scoringBatterId)?.name || 'Batter';
  if (runs === 4) {
    queueBroadcastFx({ type: 'FOUR', batterName, runs: updatedBatterRuns });
  } else if (runs === 6) {
    queueBroadcastFx({ type: 'SIX', batterName, runs: updatedBatterRuns });
  }
  checkAndQueueBatterMilestones(inn, scoringBatterId, prevBatterRuns);
  if (runs > 0) {
    const prevTeamRuns = Math.max(0, CricketEngine.calculateInnings(inn, inn.squad, inn.bowlingSquad).totalRuns - runs);
    dbGetAll('teams').then(allT => {
      const batTName = allT.find(t => t.id === inn.batting)?.name || 'Batting Team';
      checkAndQueueTeamScoreMilestones(inn, prevTeamRuns, batTName);
    }).catch(() => checkAndQueueTeamScoreMilestones(inn, prevTeamRuns, 'Batting Team'));
  }

  // Auto Strike Rotation on Odd Runs
  if (runs % 2 !== 0) {
    const temp = inn.strikerId;
    inn.strikerId = inn.nonStrikerId;
    inn.nonStrikerId = temp;
  }

  // End of Over Detection (6 legal deliveries)
  const stats = CricketEngine.calculateInnings(inn);
  if (stats.legalDeliveries > 0 && stats.legalDeliveries % 6 === 0) {
    const temp = inn.strikerId;
    inn.strikerId = inn.nonStrikerId;
    inn.nonStrikerId = temp;
    showToast('Over complete. Select new bowler.');
    openBowlerSelectModal();
  }

  await saveActiveMatch();
  checkInningsAutoCompletion(inn, stats);
  renderLiveScorerView();
}

// Modern Extras Modal (WD, NB, BYE, LB)
let selectedExtraAddRuns = 0;
let selectedNbRunSource = 'bat'; // 'bat' or 'bye'

function openExtraModal(extraType) {
  if (!activeMatch) return;
  const inn = activeMatch.innings[activeMatch.innings.length - 1];

  if (!inn.strikerId || !inn.nonStrikerId || !inn.bowlerId) {
    showToast('Set Striker, Non-Striker, and Bowler first.');
    return;
  }

  selectedExtraAddRuns = 0;
  selectedNbRunSource = 'bat';

  const titles = {
    wide: 'Wide Ball (WD)',
    noBall: 'No Ball (NB)',
    bye: 'Bye Runs (BYE)',
    legBye: 'Leg Bye Runs (LB)'
  };

  const descriptions = {
    wide: '1 penalty run + any completed bye runs. Ball is re-bowled.',
    noBall: '1 penalty run + runs off bat or byes. Ball is re-bowled.',
    bye: 'Legal delivery. Runs credited to team extras only.',
    legBye: 'Legal delivery off batter body/pads. Team extras only.'
  };

  const presets = (extraType === 'bye' || extraType === 'legBye')
    ? [
        { val: 1, label: '1', sub: 'Single' },
        { val: 2, label: '2', sub: 'Two' },
        { val: 3, label: '3', sub: 'Three' },
        { val: 4, label: '4', sub: 'Boundary' },
        { val: 5, label: '5', sub: 'Overthrow' }
      ]
    : [
        { val: 0, label: '+0', sub: 'Standard' },
        { val: 1, label: '+1', sub: 'Single' },
        { val: 2, label: '+2', sub: 'Two' },
        { val: 3, label: '+3', sub: 'Three' },
        { val: 4, label: '+4', sub: 'Boundary' },
        { val: 6, label: '+6', sub: 'Maximum' }
      ];

  if (extraType === 'bye' || extraType === 'legBye') {
    selectedExtraAddRuns = 1;
  }

  const basePenalty = (extraType === 'wide' || extraType === 'noBall') ? 1 : 0;

  const html = `
    <div>
      <div class="extra-modal-banner">
        <span>${descriptions[extraType]}</span>
        <span class="extra-total-pill" id="extraTotalPreview">+${basePenalty + selectedExtraAddRuns} Run${(basePenalty + selectedExtraAddRuns) === 1 ? '' : 's'}</span>
      </div>

      ${extraType === 'noBall' ? `
        <label style="font-size:11px; font-weight:800; color:var(--text-muted); text-transform:uppercase; display:block; margin-bottom:6px;">Additional Runs Credited To</label>
        <div class="nb-source-toggle">
          <button type="button" class="nb-source-btn active" id="nbSrcBat" onclick="setNbSource('bat')">🏏 Batter (Off the Bat)</button>
          <button type="button" class="nb-source-btn" id="nbSrcBye" onclick="setNbSource('bye')">🏃 Byes / Leg-Byes</button>
        </div>
      ` : ''}

      <label style="font-size:11px; font-weight:800; color:var(--text-muted); text-transform:uppercase; display:block; margin-bottom:8px;">
        ${basePenalty ? 'Select Additional Runs Completed' : 'Select Runs Completed'}
      </label>

      <div class="run-chip-grid">
        ${presets.map(p => `
          <button type="button" class="run-chip-btn ${p.val === selectedExtraAddRuns ? 'active' : ''}" data-run="${p.val}" onclick="selectExtraRunChip(${p.val}, ${basePenalty})">
            <strong>${p.label}</strong>
            <span>${p.sub}</span>
          </button>
        `).join('')}
      </div>

      <div class="form-group">
        <label>Or Custom Additional Runs</label>
        <input type="number" id="customExtraRunInput" min="0" max="12" value="${selectedExtraAddRuns}" oninput="onCustomExtraInput(this.value, ${basePenalty})">
      </div>
    </div>
  `;

  openModal(titles[extraType], html, async () => {
    const addRuns = Math.max(0, parseInt(selectedExtraAddRuns, 10) || 0);
    const isWideOrNb = (extraType === 'wide' || extraType === 'noBall');
    const compExtra = isWideOrNb ? 1 : 0;

    let batRuns = 0;
    let extraRuns = addRuns;
    let extraTotal = compExtra + addRuns;

    if (extraType === 'noBall' && selectedNbRunSource === 'bat' && addRuns > 0) {
      batRuns = addRuns;
      extraRuns = 0;
      extraTotal = compExtra;
    }

    const ball = {
      id: generateId(),
      batterId: inn.strikerId,
      nonStrikerId: inn.nonStrikerId,
      bowlerId: inn.bowlerId,
      batRuns,
      extraType,
      extraRuns,
      extraTotal,
      wicket: false,
      dismissal: 'none',
      timestamp: Date.now()
    };

    const extraBatterId = inn.strikerId;
    const prevExtraBatRuns = getBatterRunsFromInnings(inn, extraBatterId);
    const prevExtraTeamRuns = CricketEngine.calculateInnings(inn, inn.squad, inn.bowlingSquad).totalRuns;
    inn.balls.push(ball);
    triggerHaptic(addRuns >= 4 ? 'boundary' : 'normal');
    if ((batRuns + extraTotal) > 0) {
      dbGetAll('teams').then(allT => {
        const batTName = allT.find(t => t.id === inn.batting)?.name || 'Batting Team';
        checkAndQueueTeamScoreMilestones(inn, prevExtraTeamRuns, batTName);
      }).catch(() => checkAndQueueTeamScoreMilestones(inn, prevExtraTeamRuns, 'Batting Team'));
    }

    if (batRuns > 0) {
      const bName = inn.squad.find(p => p.id === extraBatterId)?.name || 'Batter';
      if (batRuns === 4) {
        queueBroadcastFx({ type: 'FOUR', batterName: bName, runs: prevExtraBatRuns + batRuns });
      } else if (batRuns === 6) {
        queueBroadcastFx({ type: 'SIX', batterName: bName, runs: prevExtraBatRuns + batRuns });
      }
      checkAndQueueBatterMilestones(inn, extraBatterId, prevExtraBatRuns);
    }

    if (addRuns % 2 !== 0) {
      const temp = inn.strikerId;
      inn.strikerId = inn.nonStrikerId;
      inn.nonStrikerId = temp;
    }

    await saveActiveMatch();
    renderLiveScorerView();
    return true;
  });
}

function selectExtraRunChip(val, basePenalty) {
  selectedExtraAddRuns = val;
  document.querySelectorAll('.run-chip-btn').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.run) === val);
  });
  const inp = document.getElementById('customExtraRunInput');
  if (inp) inp.value = val;
  const total = basePenalty + val;
  const preview = document.getElementById('extraTotalPreview');
  if (preview) preview.textContent = `+${total} Run${total === 1 ? '' : 's'}`;
}

function onCustomExtraInput(rawVal, basePenalty) {
  const val = Math.max(0, parseInt(rawVal, 10) || 0);
  selectedExtraAddRuns = val;
  document.querySelectorAll('.run-chip-btn').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.run) === val);
  });
  const total = basePenalty + val;
  const preview = document.getElementById('extraTotalPreview');
  if (preview) preview.textContent = `+${total} Run${total === 1 ? '' : 's'}`;
}

function setNbSource(src) {
  selectedNbRunSource = src;
  document.getElementById('nbSrcBat')?.classList.toggle('active', src === 'bat');
  document.getElementById('nbSrcBye')?.classList.toggle('active', src === 'bye');
}

// 12 Wicket Dismissals Workflow
function openWicketModal() {
  if (!activeMatch) return;
  const inn = activeMatch.innings[activeMatch.innings.length - 1];
  const available = getAvailableIncomingBatters(inn);
  const fielders = inn.bowlingSquad || [];

  const html = `
    <form id="wicketForm">
      <div class="form-group" style="margin-bottom:12px;">
        <label>Dismissal Type</label>
        <select id="wfType" onchange="onDismissalTypeChange(this.value)">
          <option value="caught">Caught</option>
          <option value="bowled">Bowled</option>
          <option value="runOut">Run Out</option>
          <option value="lbw">LBW</option>
          <option value="stumped">Stumped</option>
          <option value="caughtAndBowled">Caught & Bowled</option>
          <option value="hitWicket">Hit Wicket</option>
          <option value="retiredHurt">Retired Hurt (Can Return Later)</option>
          <option value="retiredOut">Retired Out (No Ball Consumed)</option>
          <option value="obstructingTheField">Obstructing the Field</option>
          <option value="hitBallTwice">Hit the Ball Twice</option>
          <option value="timedOut">Timed Out</option>
        </select>
      </div>

      <div class="field-grid" style="margin-bottom:12px;" id="wfDeliveryDetailsRow">
        <div class="form-group">
          <label>Delivery Type</label>
          <select id="wfDeliveryExtra">
            <option value="legal">Legal Delivery</option>
            <option value="wide">Wide (+1 Extra)</option>
            <option value="noBall">No-Ball (+1 Extra)</option>
          </select>
        </div>

        <div class="form-group">
          <label>Runs Completed on Ball</label>
          <select id="wfCompletedRuns">
            <option value="0">0 Runs</option>
            <option value="1">1 Run</option>
            <option value="2">2 Runs</option>
            <option value="3">3 Runs</option>
          </select>
        </div>
      </div>

      <div class="form-group" style="margin-bottom:12px;">
        <label>Dismissed Batter</label>
        <select id="wfOutBatter">
          <option value="${inn.strikerId}">Striker (${inn.squad.find(p => p.id === inn.strikerId)?.name || 'Striker'})</option>
          <option value="${inn.nonStrikerId}">Non-Striker (${inn.squad.find(p => p.id === inn.nonStrikerId)?.name || 'Non-Striker'})</option>
        </select>
      </div>

      <div class="form-group" id="wfFielderGroup" style="display:block; margin-bottom:12px;">
        <label id="wfFielderLabel">Fielder / Catcher</label>
        <select id="wfFielder" onchange="onFielderSelectChange(this.value)">
          <option value="">Unknown / None</option>
          ${fielders.map(p => `<option value="${p.id}">${escapeHTML(p.name)}</option>`).join('')}
          <option value="__NEW_FIELDER__">＋ Type Fielder Name...</option>
        </select>
      </div>

      <div class="form-group" id="wfCustomFielderWrap" style="display:none; margin-bottom:12px;">
        <label>New Fielder Name</label>
        <input type="text" id="wfCustomFielderName" placeholder="e.g. Jadeja">
      </div>

      <div class="form-group" style="margin-bottom:10px;">
        <label>Incoming Batter</label>
        <select id="wfIncoming" onchange="toggleCustomIncomingField(this.value)">
          ${available.map(p => `<option value="${p.id}">${escapeHTML(p.name)}${p.isRetiredHurt ? ' (Retired Hurt - Returning)' : ''}</option>`).join('')}
          <option value="__NEW__">＋ Type New Batter...</option>
        </select>
      </div>

      <div class="form-group" id="wfNewBatterGroup" style="${available.length === 0 ? 'display:block;' : 'display:none;'} margin-bottom:12px;">
        <label>New Batter Name *</label>
        <input type="text" id="wfNewBatterName" placeholder="e.g. Suresh">
      </div>

      <label class="checklist-item" style="cursor:pointer; user-select:none; padding:6px 0;" id="wfCrossedWrap">
        <input type="checkbox" id="wfBattersCrossed" style="width:16px; height:16px; accent-color:var(--primary);">
        <span>Batters crossed before dismissal (Incoming takes Non-Striker end)</span>
      </label>
    </form>
  `;

  openModal('Record Dismissal / Wicket', html, async () => {
    const type = document.getElementById('wfType').value;
    const outBatterId = document.getElementById('wfOutBatter').value;
    let incomingId = document.getElementById('wfIncoming').value;
    let fielderId = document.getElementById('wfFielder')?.value;
    const deliveryExtra = document.getElementById('wfDeliveryExtra')?.value || 'legal';
    const completedRuns = Math.max(0, parseInt(document.getElementById('wfCompletedRuns')?.value || '0', 10));
    const battersCrossed = !!document.getElementById('wfBattersCrossed')?.checked;

    if (fielderId === '__NEW_FIELDER__') {
      const customFielder = (document.getElementById('wfCustomFielderName')?.value || '').trim();
      fielderId = customFielder ? await getOrCreatePlayer(customFielder, 'Bowler', inn.bowlingSquad) : null;
    }

    if (incomingId === '__NEW__' || !incomingId) {
      const customName = (document.getElementById('wfNewBatterName')?.value || '').trim();
      if (!customName) {
        showToast('Please enter incoming batter name');
        return false;
      }
      incomingId = await getOrCreatePlayer(customName, 'Batter', inn.squad);
    }

    if (type === 'retiredHurt' || type === 'retiredOut') {
      inn.balls.push({
        id: generateId(),
        batterId: inn.strikerId,
        nonStrikerId: inn.nonStrikerId,
        bowlerId: inn.bowlerId,
        batRuns: 0,
        extraType: 'penalty',
        extraRuns: 0,
        extraTotal: 0,
        wicket: true,
        dismissal: type,
        wicketPlayerId: outBatterId,
        dismissalDetails: { fielderId: null },
        timestamp: Date.now()
      });

      if (inn.strikerId === outBatterId) inn.strikerId = incomingId;
      else inn.nonStrikerId = incomingId;

      const retStats = CricketEngine.calculateInnings(inn, inn.squad, inn.bowlingSquad);
      const retBatterObj = retStats.batters.find(b => b.id === outBatterId);
      queueBroadcastFx({
        type: 'WICKET',
        dismissal: type,
        batterName: retBatterObj?.name || 'Batter',
        batterRuns: retBatterObj?.runs || 0,
        batterBalls: retBatterObj?.balls || 0,
        creditText: type === 'retiredHurt' ? 'Retired Hurt (Can Return)' : 'Retired Out'
      });
      showToast(type === 'retiredHurt' ? 'Batter retired hurt (can return later)' : 'Batter retired out');
      await saveActiveMatch();
      renderLiveScorerView();
      return true;
    }

    const isWide = deliveryExtra === 'wide';
    const isNoBall = deliveryExtra === 'noBall';
    const extraType = (isWide || isNoBall) ? deliveryExtra : null;
    const compExtra = (isWide || isNoBall) ? 1 : 0;

    const batRuns = isWide ? 0 : completedRuns;
    const extraRuns = isWide ? completedRuns : 0;
    const extraTotal = compExtra + extraRuns;

    const strikerBeforeWicket = inn.strikerId;
    const prevStrikerRunsBeforeWicket = getBatterRunsFromInnings(inn, strikerBeforeWicket);
    const preWicketStats = CricketEngine.calculateInnings(inn, inn.squad, inn.bowlingSquad);
    const prevTeamRunsBeforeWicket = preWicketStats.totalRuns;
    const activeBowlerIdForWicket = inn.bowlerId;
    const prevBowlerWickets = preWicketStats.bowlers.find(b => b.id === activeBowlerIdForWicket)?.wickets || 0;

    inn.balls.push({
      id: generateId(),
      batterId: inn.strikerId,
      nonStrikerId: inn.nonStrikerId,
      bowlerId: inn.bowlerId,
      batRuns,
      extraType,
      extraRuns,
      extraTotal,
      wicket: true,
      dismissal: type,
      wicketPlayerId: outBatterId,
      dismissalDetails: { fielderId },
      timestamp: Date.now()
    });

    triggerHaptic('wicket');

    if (batRuns > 0) {
      checkAndQueueBatterMilestones(inn, strikerBeforeWicket, prevStrikerRunsBeforeWicket);
    }

    const postWicketStats = CricketEngine.calculateInnings(inn, inn.squad, inn.bowlingSquad);
    const outBatterObj = postWicketStats.batters.find(b => b.id === outBatterId);
    const bowlerName = inn.bowlingSquad.find(b => b.id === inn.bowlerId)?.name || 'Bowler';
    const fielderName = fielderId ? (inn.bowlingSquad.find(b => b.id === fielderId)?.name || '') : '';
    const playersLookup = {};
    [...(inn.squad || []), ...(inn.bowlingSquad || [])].forEach(p => { playersLookup[p.id] = p.name; });
    const creditText = outBatterObj
      ? formatDismissalText(outBatterObj, playersLookup, playersLookup)
      : (fielderName ? `${fielderName} / b ${bowlerName}` : `b ${bowlerName}`);

    queueBroadcastFx({
      type: 'WICKET',
      dismissal: type,
      batterName: outBatterObj?.name || (inn.squad.find(p => p.id === outBatterId)?.name || 'Batter'),
      batterRuns: outBatterObj?.runs || 0,
      batterBalls: outBatterObj?.balls || 0,
      creditText
    });

    if ((batRuns + extraTotal) > 0) {
      dbGetAll('teams').then(allT => {
        const batTName = allT.find(t => t.id === inn.batting)?.name || 'Batting Team';
        checkAndQueueTeamScoreMilestones(inn, prevTeamRunsBeforeWicket, batTName);
      }).catch(() => {});
    }

    if (type !== 'runOut' && type !== 'retiredHurt' && type !== 'retiredOut' && type !== 'obstructingTheField' && type !== 'hitBallTwice' && type !== 'timedOut') {
      checkAndQueueBowlerFiveWicketHaul(inn, activeBowlerIdForWicket, prevBowlerWickets);
    }

    dbGetAll('teams').then(allT => {
      const batTName = allT.find(t => t.id === inn.batting)?.name || 'Batting Team';
      checkAndQueueAllOutFx(inn, batTName);
    }).catch(() => checkAndQueueAllOutFx(inn, 'Batting Team'));

    if (inn.strikerId === outBatterId) inn.strikerId = incomingId;
    else inn.nonStrikerId = incomingId;

    if (battersCrossed || (completedRuns % 2 !== 0)) {
      const temp = inn.strikerId;
      inn.strikerId = inn.nonStrikerId;
      inn.nonStrikerId = temp;
    }

    const stats = CricketEngine.calculateInnings(inn, inn.squad, inn.bowlingSquad);
    const isLegal = !isWide && !isNoBall;
    if (isLegal && stats.legalDeliveries > 0 && stats.legalDeliveries % 6 === 0) {
      const temp = inn.strikerId;
      inn.strikerId = inn.nonStrikerId;
      inn.nonStrikerId = temp;
      showToast('Over complete. Select next bowler.');
      await saveActiveMatch();
      renderLiveScorerView();
      openBowlerSelectModal();
      return true;
    }

    await saveActiveMatch();
    checkInningsAutoCompletion(inn, stats);
    renderLiveScorerView();
    return true;
  });
}

function onFielderSelectChange(val) {
  const wrap = document.getElementById('wfCustomFielderWrap');
  if (wrap) wrap.style.display = (val === '__NEW_FIELDER__') ? 'block' : 'none';
}

function toggleCustomIncomingField(val) {
  const customBox = document.getElementById('wfNewBatterGroup');
  if (customBox) customBox.style.display = (val === '__NEW__') ? 'block' : 'none';
}

function onDismissalTypeChange(val) {
  const fg = document.getElementById('wfFielderGroup');
  const label = document.getElementById('wfFielderLabel');
  const delivRow = document.getElementById('wfDeliveryDetailsRow');
  const crossedWrap = document.getElementById('wfCrossedWrap');
  const isRet = (val === 'retiredHurt' || val === 'retiredOut');

  if (delivRow) delivRow.style.display = isRet ? 'none' : 'grid';
  if (crossedWrap) crossedWrap.style.display = isRet ? 'none' : 'flex';

  if (!fg) return;
  if (val === 'caught') {
    fg.style.display = 'block';
    if (label) label.textContent = 'Catcher Name';
  } else if (val === 'runOut') {
    fg.style.display = 'block';
    if (label) label.textContent = 'Fielder Affecting Run-Out';
  } else if (val === 'stumped') {
    fg.style.display = 'block';
    if (label) label.textContent = 'Wicket-Keeper / Fielder';
  } else {
    fg.style.display = 'none';
  }
}

function getAvailableIncomingBatters(inn) {
  const stats = CricketEngine.calculateInnings(inn, inn.squad, inn.bowlingSquad);
  const outIds = new Set(stats.fallOfWickets.map(f => f.playerId || '').concat([inn.strikerId, inn.nonStrikerId]));
  const retiredHurtIds = new Set(stats.batters.filter(b => b.isRetiredHurt).map(b => b.id));

  return inn.squad
    .filter(p => !outIds.has(p.id))
    .map(p => ({ ...p, isRetiredHurt: retiredHurtIds.has(p.id) }))
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
}

function swapStrike() {
  if (!activeMatch) return;
  const inn = activeMatch.innings[activeMatch.innings.length - 1];
  const temp = inn.strikerId;
  inn.strikerId = inn.nonStrikerId;
  inn.nonStrikerId = temp;
  saveActiveMatch();
  renderLiveScorerView();
}

function openBowlerSelectModal() {
  if (!activeMatch) return;
  const inn = activeMatch.innings[activeMatch.innings.length - 1];
  const sortedSquad = [...(inn.bowlingSquad || [])].sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
  const opts = sortedSquad.map(b => `<option value="${b.id}" ${b.id === inn.bowlerId ? 'selected' : ''}>${escapeHTML(b.name)}</option>`).join('');

  const html = `
    <div class="form-group">
      <label>Select Next Bowler</label>
      <select id="newBowlerSelect">${opts}</select>
    </div>
  `;

  openModal('Change Bowler', html, async () => {
    const sel = document.getElementById('newBowlerSelect');
    if (sel) {
      inn.bowlerId = sel.value;
      await saveActiveMatch();
      renderLiveScorerView();
    }
    return true;
  });
}

async function undoLastDelivery() {
  if (!activeMatch) return;
  const inn = activeMatch.innings[activeMatch.innings.length - 1];
  if (!inn.balls.length) {
    showToast('No balls to undo in this innings.');
    return;
  }
  const removed = inn.balls.pop();
  showToast('Last delivery undone');
  await saveActiveMatch();
  renderLiveScorerView();
}

function checkInningsAutoCompletion(inn, stats) {
  if (!activeMatch || activeMatch.status === 'Completed') return;
  const maxOversBalls = (activeMatch.overs || 20) * 6;
  const squadCount = (inn.squad || []).length;
  const maxWickets = squadCount >= 2 ? (squadCount - 1) : 10;

  if (activeMatch.target && stats.totalRuns >= activeMatch.target) {
    setTimeout(() => {
      if (confirm(`Target of ${activeMatch.target} reached! Finish match now?`)) {
        finishMatchPrompt(true);
      }
    }, 200);
    return;
  }

  const lastManActive = isLastManStandsEnabled();
  const effectiveMaxWickets = lastManActive ? squadCount : maxWickets;
  if (stats.wickets >= effectiveMaxWickets) {
    setTimeout(() => {
      if (confirm(`All Out (${stats.wickets} wickets)! Conclude this innings?`)) {
        endInningsPrompt(false, true);
      }
    }, 200);
    return;
  }

  if (stats.legalDeliveries >= maxOversBalls) {
    setTimeout(() => {
      if (confirm(`${activeMatch.overs} overs completed! Conclude this innings?`)) {
        endInningsPrompt(false, true);
      }
    }, 200);
  }
}

function openBallLogEditorModal() {
  if (!activeMatch) return;
  const inn = activeMatch.innings[activeMatch.innings.length - 1];
  const balls = inn.balls || [];

  if (!balls.length) {
    showToast('No deliveries recorded in this innings yet.');
    return;
  }

  const playersMap = {};
  (inn.squad || []).concat(inn.bowlingSquad || []).forEach(p => { playersMap[p.id] = p.name; });

  const renderRows = () => {
    let legalCounter = 0;
    return balls.map((b, idx) => {
      const isWide = b.extraType === 'wide';
      const isNoBall = b.extraType === 'noBall';
      const isPenalty = b.extraType === 'penalty';
      const isLegal = !isWide && !isNoBall && !isPenalty;
      const ovLabel = `${Math.floor(legalCounter / 6)}.${(legalCounter % 6) + (isLegal ? 1 : 0)}`;
      if (isLegal) legalCounter += 1;

      const label = b.wicket
        ? (b.dismissal === 'retiredHurt' ? 'RET-H' : b.dismissal === 'retiredOut' ? 'RET-O' : 'W')
        : b.extraType
          ? `${b.extraType.toUpperCase()} +${b.extraRuns || 0}`
          : `${b.batRuns} run${b.batRuns === 1 ? '' : 's'}`;

      const badgeClass = b.wicket ? 'w' : b.batRuns === 4 ? 'b4' : b.batRuns === 6 ? 'b6' : '';
      const btrName = playersMap[b.batterId] || 'Batter';
      const blrName = playersMap[b.bowlerId] || 'Bowler';

      return `
        <div class="ball-log-row">
          <div style="display:flex; align-items:center; gap:8px;">
            <span class="muted" style="font-weight:800; min-width:28px;">${ovLabel}</span>
            <span class="ball-log-badge ${badgeClass}">${b.wicket ? 'W' : b.extraType ? b.extraType.slice(0,2).toUpperCase() : b.batRuns}</span>
            <div>
              <strong>${escapeHTML(label)}</strong>
              <div class="muted" style="font-size:10.5px;">${escapeHTML(blrName)} to ${escapeHTML(btrName)}</div>
            </div>
          </div>
          <div style="display:flex; gap:4px;">
            ${!b.wicket && !b.extraType ? `<button type="button" class="btn btn-secondary" style="padding:4px 8px; font-size:11px;" onclick="editBallRunsAt(${idx})">Edit</button>` : ''}
            <button type="button" class="btn btn-outline" style="padding:4px 8px; font-size:11px; color:var(--danger);" onclick="deleteBallAt(${idx})">✕</button>
          </div>
        </div>
      `;
    }).reverse().join('');
  };

  openModal('Innings Delivery Log (Latest First)', `<div id="ballLogListWrap">${renderRows()}</div>`, () => true, false);
}

async function editBallRunsAt(index) {
  if (!activeMatch) return;
  const inn = activeMatch.innings[activeMatch.innings.length - 1];
  const ball = inn.balls[index];
  if (!ball) return;

  const val = prompt('Enter corrected runs off the bat (0 - 6):', String(ball.batRuns || 0));
  if (val === null) return;
  ball.batRuns = Math.max(0, Math.min(6, parseInt(val, 10) || 0));
  await saveActiveMatch();
  renderLiveScorerView();
  openBallLogEditorModal();
  showToast('Delivery updated & scorecard recalculated');
}

async function deleteBallAt(index) {
  if (!activeMatch) return;
  if (!confirm('Delete this delivery from the innings log?')) return;
  const inn = activeMatch.innings[activeMatch.innings.length - 1];
  inn.balls.splice(index, 1);
  await saveActiveMatch();
  renderLiveScorerView();
  openBallLogEditorModal();
  showToast('Delivery removed');
}

async function endInningsPrompt(isDeclaration = false, skipConfirm = false) {
  const msg = isDeclaration
    ? 'Declare this innings closed now?'
    : 'Are you sure you want to conclude this innings?';
  if (!skipConfirm && !confirm(msg)) return;

  const inn = activeMatch.innings[activeMatch.innings.length - 1];
  inn.declared = isDeclaration;
  const stats = CricketEngine.calculateInnings(inn, inn.squad, inn.bowlingSquad);

  if (activeMatch.innings.length === 1) {
    activeMatch.target = stats.totalRuns + 1;
    const innings2 = {
      inningsNum: 2,
      batting: inn.bowling,
      bowling: inn.batting,
      squad: inn.bowlingSquad,
      bowlingSquad: inn.squad,
      strikerId: inn.bowlingSquad[0]?.id || null,
      nonStrikerId: inn.bowlingSquad[1]?.id || null,
      bowlerId: inn.squad[0]?.id || null,
      balls: [],
      base: { runs: 0, wickets: 0, legal: 0, ballCount: 0 }
    };

    activeMatch.innings.push(innings2);
    await saveActiveMatch();
    showToast(`Innings 1 finished! Target: ${activeMatch.target} runs.`);
    renderLiveScorerView();
  } else {
    finishMatchPrompt(true);
  }
}

async function finishMatchPrompt(skipConfirm = false) {
  if (!skipConfirm && !confirm('Mark this match as Completed and calculate official result?')) return;
  const inn1 = activeMatch.innings[0];
  const inn2 = activeMatch.innings[1];

  const stats1 = CricketEngine.calculateInnings(inn1, inn1.squad, inn1.bowlingSquad);
  const stats2 = inn2 ? CricketEngine.calculateInnings(inn2, inn2.squad, inn2.bowlingSquad) : null;

  const teams = await dbGetAll('teams');
  const team1Name = teams.find(t => t.id === inn1.batting)?.name || 'Team 1';
  const team2Name = teams.find(t => t.id === inn1.bowling)?.name || 'Team 2';

  let resultStr = 'Match Completed';

  if (stats2) {
    if (stats2.totalRuns >= (stats1.totalRuns + 1)) {
      const maxWkts = Math.max(1, (inn2.squad?.length || 11) - 1);
      const wktsLeft = Math.max(1, maxWkts - stats2.wickets);
      resultStr = `${team2Name} won by ${wktsLeft} wicket${wktsLeft === 1 ? '' : 's'}`;
    } else if (stats1.totalRuns > stats2.totalRuns) {
      const margin = stats1.totalRuns - stats2.totalRuns;
      resultStr = `${team1Name} won by ${margin} run${margin === 1 ? '' : 's'}`;
    } else {
      resultStr = `Match Tied (${stats1.totalRuns} - ${stats2.totalRuns})`;
      if (confirm(`${resultStr}!

Would you like to start a 1-Over Super Over tie-breaker?`)) {
        activeMatch.isSuperOver = true;
        activeMatch.overs = 1;
        activeMatch.target = null;
        activeMatch.innings = [
          {
            inningsNum: 1,
            batting: inn2.batting,
            bowling: inn2.bowling,
            squad: inn2.squad,
            bowlingSquad: inn2.bowlingSquad,
            strikerId: inn2.squad[0]?.id || null,
            nonStrikerId: inn2.squad[1]?.id || null,
            bowlerId: inn2.bowlingSquad[0]?.id || null,
            balls: [],
            base: { runs: 0, wickets: 0, legal: 0, ballCount: 0 }
          }
        ];
        await saveActiveMatch();
        showToast('⚡ Super Over started! (1 Over)');
        renderLiveScorerView();
        return;
      }
    }
  }

  activeMatch.status = 'Completed';
  activeMatch.result = resultStr;

  await saveActiveMatch();
  if (activeMatch.tournamentId && activeMatch.tournamentFixtureId) {
    await syncTournamentFixtureCompletion(activeMatch, stats1, stats2);
  }
  triggerAutoBackup();
  showToast('Match marked as Completed.');
  navigate(activeMatch.tournamentId ? 'tournaments' : 'history');
}

async function saveActiveMatch() {
  if (activeMatch) {
    activeMatch.updated = Date.now();
    await dbPut('matches', activeMatch);
    triggerAutoBackup();
    queueCloudMatchSync(activeMatch);
  }
}

// ==========================================
// 9. MATCH HISTORY & DETAILED SCORECARD
// ==========================================

async function renderHistory() {
  const [matches, teams] = await Promise.all([dbGetAll('matches'), dbGetAll('teams')]);
  const container = document.getElementById('historyMatchesContainer');
  const search = (document.getElementById('historySearchInput')?.value || '').toLowerCase();
  const statusFilter = document.getElementById('historyStatusFilter')?.value || '';

  let filtered = matches.filter(m => {
    const tA = teams.find(t => t.id === m.a)?.name.toLowerCase() || '';
    const tB = teams.find(t => t.id === m.b)?.name.toLowerCase() || '';
    const titleMatch = (m.title || '').toLowerCase().includes(search) || tA.includes(search) || tB.includes(search);
    const statusMatch = !statusFilter || m.status === statusFilter;
    return titleMatch && statusMatch;
  });

  if (!filtered.length) {
    container.className = 'stack-list empty-state';
    container.textContent = 'No matching matches in history.';
    return;
  }

  container.className = 'stack-list';
  container.innerHTML = filtered.sort((a,b) => (b.created || '').localeCompare(a.created || '')).map(m => createMatchItemHTML(m, teams)).join('');
}

function calculateMatchMVP(match, playersMap) {
  const scores = {};
  const addPts = (id, name, pts, summaryPart) => {
    if (!id) return;
    if (!scores[id]) scores[id] = { id, name: name || playersMap[id] || 'Player', pts: 0, highlights: [] };
    scores[id].pts += pts;
    if (summaryPart) scores[id].highlights.push(summaryPart);
  };

  (match.innings || []).forEach(inn => {
    const stats = CricketEngine.calculateInnings(inn, inn.squad, inn.bowlingSquad);
    stats.batters.forEach(b => {
      if (b.runs > 0 || b.balls > 0) {
        let pts = b.runs * 1 + (b.fours * 2) + (b.sixes * 4);
        if (b.runs >= 50) pts += 15;
        if (b.runs >= 100) pts += 30;
        addPts(b.id, b.name, pts, `${b.runs}(${b.balls})`);
      }
    });
    stats.bowlers.forEach(bo => {
      if (bo.wickets > 0 || bo.maidens > 0) {
        let pts = (bo.wickets * 20) + ((bo.maidens || 0) * 10);
        if (bo.wickets >= 3) pts += 15;
        addPts(bo.id, bo.name, pts, `${bo.wickets}/${bo.runsConceded}`);
      }
    });
    (inn.balls || []).forEach(ball => {
      if (ball.wicket && ball.dismissalDetails?.fielderId) {
        const fid = ball.dismissalDetails.fielderId;
        const pts = (ball.dismissal === 'caught' || ball.dismissal === 'stumped') ? 10 : 5;
        addPts(fid, playersMap[fid], pts, null);
      }
    });
  });

  const sorted = Object.values(scores).sort((a, b) => b.pts - a.pts);
  return sorted[0] || null;
}

function buildMatchChartsSVG(m, teams) {
  if (!m.innings || !m.innings.length) return '';
  const inn1Stats = CricketEngine.calculateInnings(m.innings[0], m.innings[0].squad, m.innings[0].bowlingSquad);
  const inn2Stats = m.innings[1] ? CricketEngine.calculateInnings(m.innings[1], m.innings[1].squad, m.innings[1].bowlingSquad) : null;

  const ov1 = inn1Stats.overHistory || [];
  const ov2 = inn2Stats ? (inn2Stats.overHistory || []) : [];
  const maxOvers = Math.max(ov1.length, ov2.length, 1);
  if (ov1.length === 0 && ov2.length === 0) return '';

  const t1Name = teams.find(t => t.id === m.innings[0].batting)?.name || 'Inn 1';
  const t2Name = m.innings[1] ? (teams.find(t => t.id === m.innings[1].batting)?.name || 'Inn 2') : 'Inn 2';

  const maxOverRuns = Math.max(12, ...ov1.map(o => o.runs), ...ov2.map(o => o.runs));
  const svgW = 320;
  const svgH = 110;
  const padL = 22;
  const padB = 18;
  const plotW = svgW - padL - 8;
  const plotH = svgH - padB - 10;
  const groupW = plotW / maxOvers;

  let barsSVG = '';
  for (let i = 0; i < maxOvers; i++) {
    const o1 = ov1[i];
    const o2 = ov2[i];
    const xBase = padL + i * groupW;
    const barW = ov2.length ? Math.max(3, (groupW - 4) / 2) : Math.max(4, groupW - 4);

    if (o1) {
      const h1 = (o1.runs / maxOverRuns) * plotH;
      const y1 = 10 + plotH - h1;
      barsSVG += `<rect x="${xBase + 1}" y="${y1.toFixed(1)}" width="${barW.toFixed(1)}" height="${h1.toFixed(1)}" fill="var(--primary)" rx="2" />`;
      if (o1.wickets > 0) {
        barsSVG += `<circle cx="${(xBase + 1 + barW / 2).toFixed(1)}" cy="${Math.max(5, y1 - 4).toFixed(1)}" r="3" fill="var(--danger)" />`;
      }
    }
    if (o2) {
      const h2 = (o2.runs / maxOverRuns) * plotH;
      const y2 = 10 + plotH - h2;
      barsSVG += `<rect x="${(xBase + 2 + barW).toFixed(1)}" y="${y2.toFixed(1)}" width="${barW.toFixed(1)}" height="${h2.toFixed(1)}" fill="var(--accent)" rx="2" />`;
      if (o2.wickets > 0) {
        barsSVG += `<circle cx="${(xBase + 2 + barW * 1.5).toFixed(1)}" cy="${Math.max(5, y2 - 4).toFixed(1)}" r="3" fill="var(--danger)" />`;
      }
    }
    if ((i + 1) % Math.ceil(maxOvers / 10) === 0 || i === 0) {
      barsSVG += `<text x="${(xBase + groupW / 2).toFixed(1)}" y="${svgH - 4}" font-size="8" fill="var(--text-muted)" text-anchor="middle">${i + 1}</text>`;
    }
  }

  const maxCum = Math.max(20, ...ov1.map(o => o.cumulative), ...ov2.map(o => o.cumulative));
  const buildPolyline = (arr) => {
    if (!arr.length) return '';
    const pts = [`${padL},${10 + plotH}`];
    arr.forEach((o, idx) => {
      const x = padL + ((idx + 1) / maxOvers) * plotW;
      const y = 10 + plotH - ((o.cumulative / maxCum) * plotH);
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    });
    return pts.join(' ');
  };

  return `
    <div class="chart-box">
      <div class="chart-header">
        <span>📊 Manhattan (Runs / Over)</span>
        <div class="chart-legend">
          <span><span class="legend-dot" style="background:var(--primary);"></span>${escapeHTML(t1Name)}</span>
          ${ov2.length ? `<span><span class="legend-dot" style="background:var(--accent);"></span>${escapeHTML(t2Name)}</span>` : ''}
          <span><span class="legend-dot" style="background:var(--danger);"></span>Wkt</span>
        </div>
      </div>
      <svg viewBox="0 0 ${svgW} ${svgH}" style="width:100%; height:auto; display:block;">
        <line x1="${padL}" y1="${10 + plotH}" x2="${svgW - 4}" y2="${10 + plotH}" stroke="var(--border)" stroke-width="1" />
        ${barsSVG}
      </svg>
    </div>

    <div class="chart-box">
      <div class="chart-header">
        <span>📈 Worm Progression</span>
        <span style="font-size:9.5px;">Peak: ${maxCum} runs</span>
      </div>
      <svg viewBox="0 0 ${svgW} ${svgH}" style="width:100%; height:auto; display:block;">
        <line x1="${padL}" y1="${10 + plotH}" x2="${svgW - 4}" y2="${10 + plotH}" stroke="var(--border)" stroke-width="1" />
        <polyline fill="none" stroke="var(--primary)" stroke-width="2.2" points="${buildPolyline(ov1)}" />
        ${ov2.length ? `<polyline fill="none" stroke="var(--accent)" stroke-width="2.2" points="${buildPolyline(ov2)}" />` : ''}
      </svg>
    </div>
  `;
}

async function shareMatchSummaryText(matchId) {
  const [matches, teams, players] = await Promise.all([dbGetAll('matches'), dbGetAll('teams'), dbGetAll('players')]);
  const m = matches.find(x => x.id === matchId);
  if (!m) return;

  const playersMap = {};
  players.forEach(p => { playersMap[p.id] = p.name; });
  const teamA = teams.find(t => t.id === m.a)?.name || 'Team A';
  const teamB = teams.find(t => t.id === m.b)?.name || 'Team B';

  let lines = [
    `🏏 *${m.title}*${m.series ? ` (${m.series})` : ''}`,
    `${teamA} vs ${teamB} · ${m.format} (${m.overs} ov)`,
    `Result: *${m.result || m.status}*`,
    ``
  ];

  (m.innings || []).forEach((inn, idx) => {
    const stats = CricketEngine.calculateInnings(inn, inn.squad, inn.bowlingSquad);
    const batName = teams.find(t => t.id === inn.batting)?.name || `Innings ${idx + 1}`;
    const topBat = [...stats.batters].filter(b => b.balls > 0 || b.isOut).sort((a, b) => b.runs - a.runs).slice(0, 2);
    const topBowl = [...stats.bowlers].filter(b => b.legalBalls > 0).sort((a, b) => b.wickets - a.wickets || a.runsConceded - b.runsConceded).slice(0, 2);

    lines.push(`*${batName}: ${stats.totalRuns}/${stats.wickets} (${stats.oversFormatted} ov)*`);
    if (topBat.length) {
      lines.push(`Batting: ` + topBat.map(b => `${b.name} ${b.runs}${b.isOut ? '' : '*'} (${b.balls})`).join(', '));
    }
    if (topBowl.length) {
      lines.push(`Bowling: ` + topBowl.map(bo => `${bo.name} ${bo.wickets}/${bo.runsConceded} (${bo.oversFormatted})`).join(', '));
    }
    lines.push(``);
  });

  const mvp = calculateMatchMVP(m, playersMap);
  if (mvp && m.status === 'Completed') {
    lines.push(`🏆 Player of the Match: *${mvp.name}* (${mvp.highlights.join(', ')})`);
  }

  const shareText = lines.join('\n').trim();

  if (navigator.share) {
    try {
      await navigator.share({ title: m.title, text: shareText });
      return;
    } catch (e) {}
  }

  if (navigator.clipboard) {
    await navigator.clipboard.writeText(shareText);
    showToast('Scorecard summary copied! Ready to paste in WhatsApp.');
  } else {
    alert(shareText);
  }
}

async function viewDetailedScorecard(matchId) {
  const [matches, teams, players] = await Promise.all([
    dbGetAll('matches'),
    dbGetAll('teams'),
    dbGetAll('players')
  ]);
  const m = matches.find(x => x.id === matchId);
  if (!m) return;

  const playersMap = {};
  (players || []).forEach(p => { playersMap[p.id] = p.name; });

  const teamAName = teams.find(t => t.id === m.a)?.name || 'Team A';
  const teamBName = teams.find(t => t.id === m.b)?.name || 'Team B';
  const tossWinnerName = teams.find(t => t.id === m.tossWinner)?.name || '';
  const tossSummary = tossWinnerName
    ? `Toss: ${escapeHTML(tossWinnerName)} won the toss and elected to ${m.tossDecision === 'bowl' ? 'bowl' : 'bat'} first`
    : '';

  const mvp = calculateMatchMVP(m, playersMap);
  const chartsHTML = buildMatchChartsSVG(m, teams);

  const html = `
    <div style="font-size:13px;">
      <div style="margin-bottom:12px; border-bottom:1px solid var(--border); padding-bottom:10px; display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
        <div>
          <h3 style="font-size:16px; margin-bottom:2px;">${escapeHTML(m.title)} ${m.series ? `<span class="badge badge-completed" style="font-size:9px; vertical-align:middle;">${escapeHTML(m.series)}</span>` : ''}</h3>
          <p class="muted">${escapeHTML(teamAName)} vs ${escapeHTML(teamBName)} · ${escapeHTML(m.venue || 'Venue')} · ${escapeHTML(m.date || '')}</p>
          ${tossSummary ? `<p class="muted" style="font-size:11px; margin-top:3px;">🪙 ${tossSummary}</p>` : ''}
          <p style="color:var(--primary); font-weight:800; margin-top:5px;">${escapeHTML(m.result || m.status)}</p>
        </div>
        <div style="display:flex; gap:6px; flex-shrink:0;">
          <button type="button" class="btn btn-secondary" style="font-size:11px; padding:6px 9px; white-space:nowrap;" onclick="openMatchPosterModal('${m.id}')">🖼️ Poster</button>
          <button type="button" class="btn btn-primary" style="font-size:11px; padding:6px 9px; white-space:nowrap;" onclick="shareMatchSummaryText('${m.id}')">📲 Text</button>
        </div>
      </div>

      ${mvp ? `
        <div class="mvp-banner">
          <div>
            <div class="mvp-title">🏆 ${m.status === 'Completed' ? 'Player of the Match' : 'Current MVP Leader'}</div>
            <div class="mvp-player-name">${escapeHTML(mvp.name)} ${mvp.highlights.length ? `<small class="muted" style="font-weight:600;">(${mvp.highlights.join(', ')})</small>` : ''}</div>
          </div>
          <span class="mvp-pts-pill">${mvp.pts} pts</span>
        </div>
      ` : ''}

      ${m.innings.map((inn, idx) => {
        const stats = CricketEngine.calculateInnings(inn, inn.squad, inn.bowlingSquad);
        const battingName = teams.find(t => t.id === inn.batting)?.name || `Innings ${idx + 1}`;
        const runRate = stats.legalDeliveries > 0 ? (stats.totalRuns / (stats.legalDeliveries / 6)).toFixed(2) : '0.00';

        const activeIds = new Set([inn.strikerId, inn.nonStrikerId]);
        (inn.balls || []).forEach(b => {
          if (b.batterId) activeIds.add(b.batterId);
          if (b.nonStrikerId) activeIds.add(b.nonStrikerId);
          if (b.wicketPlayerId) activeIds.add(b.wicketPlayerId);
        });

        const battedList = stats.batters.filter(b => b.balls > 0 || b.isOut || activeIds.has(b.id));
        const dnbList = stats.batters.filter(b => !battedList.some(x => x.id === b.id));

        const extrasParts = [];
        if (stats.extras.wide) extrasParts.push(`wd ${stats.extras.wide}`);
        if (stats.extras.noBall) extrasParts.push(`nb ${stats.extras.noBall}`);
        if (stats.extras.bye) extrasParts.push(`b ${stats.extras.bye}`);
        if (stats.extras.legBye) extrasParts.push(`lb ${stats.extras.legBye}`);
        if (stats.extras.penalty) extrasParts.push(`pen ${stats.extras.penalty}`);
        const extrasDetailStr = extrasParts.length ? `(${extrasParts.join(', ')})` : '(none)';

        const fowStr = stats.fallOfWickets.length
          ? stats.fallOfWickets.map(f => `${f.wicketNum}-${f.score} (${escapeHTML(f.playerName)}, ${f.overs} ov)`).join(', ')
          : 'None';

        return `
          <div style="margin-bottom:18px; background:var(--bg-surface-alt); padding:12px; border-radius:12px; border:1px solid var(--border);">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
              <strong style="font-size:14px;">${escapeHTML(battingName)} ${inn.declared ? '<small class="muted">(dec)</small>' : ''}</strong>
              <span style="font-size:15px; font-weight:900; color:var(--primary);">${stats.totalRuns}/${stats.wickets} <small style="font-weight:600; color:var(--text-muted);">(${stats.oversFormatted} ov)</small></span>
            </div>

            <h4 style="font-size:11px; text-transform:uppercase; color:var(--text-muted); margin-bottom:4px;">Batting</h4>
            <table class="crease-table">
              <thead>
                <tr>
                  <th>Batter</th>
                  <th>R</th>
                  <th>B</th>
                  <th>4s</th>
                  <th>6s</th>
                  <th>SR</th>
                </tr>
              </thead>
              <tbody>
                ${battedList.length ? battedList.map(b => `
                  <tr>
                    <td>
                      <strong>${escapeHTML(b.name)}</strong>${(!b.isOut && (b.id === inn.strikerId || b.id === inn.nonStrikerId)) ? '*' : ''}${renderBatterMilestoneBadges(b.runs)}
                      <br>${b.isOut ? `<span class="sc-dismissal-pill">${escapeHTML(formatDismissalText(b, playersMap, playersMap))}</span>` : `<small class="muted">${formatDismissalText(b, playersMap, playersMap)}</small>`}
                    </td>
                    <td><strong>${b.runs}</strong></td>
                    <td>${b.balls}</td>
                    <td>${b.fours}</td>
                    <td>${b.sixes}</td>
                    <td>${b.strikeRate}</td>
                  </tr>
                `).join('') : '<tr><td colspan="6" class="muted" style="text-align:center;">No deliveries faced yet.</td></tr>'}
              </tbody>
            </table>

            <div class="sc-summary-strip">
              <span class="muted"><strong>Extras:</strong> ${stats.extras.total} ${extrasDetailStr}</span>
              <span class="muted"><strong>Run Rate:</strong> ${runRate}</span>
            </div>
            <div class="sc-total-row">
              <span>TOTAL</span>
              <span>${stats.totalRuns}/${stats.wickets} (${stats.oversFormatted} Overs)</span>
            </div>

            <div class="sc-meta-block">
              ${dnbList.length ? `<div><strong>Did Not Bat:</strong> ${dnbList.map(p => escapeHTML(p.name)).join(', ')}</div>` : ''}
              <div><strong>Fall of Wickets:</strong> ${fowStr}</div>
            </div>

            <h4 style="font-size:11px; text-transform:uppercase; color:var(--text-muted); margin-bottom:4px;">Bowling</h4>
            <table class="crease-table">
              <thead>
                <tr>
                  <th>Bowler</th>
                  <th>O</th>
                  <th>M</th>
                  <th>R</th>
                  <th>W</th>
                  <th>WD</th>
                  <th>NB</th>
                  <th>ECON</th>
                </tr>
              </thead>
              <tbody>
                ${stats.bowlers.filter(bo => bo.legalBalls > 0 || bo.wides > 0 || bo.noBalls > 0).map(bo => `
                  <tr>
                    <td><strong>${escapeHTML(bo.name)}</strong>${bo.wickets >= 5 ? `<span class="sc-5w-badge" title="5-Wicket Haul">5W🔥</span>` : ''}</td>
                    <td>${bo.oversFormatted}</td>
                    <td>${bo.maidens || 0}</td>
                    <td>${bo.runsConceded}</td>
                    <td><strong style="color:var(--danger);">${bo.wickets}</strong></td>
                    <td>${bo.wides || 0}</td>
                    <td>${bo.noBalls || 0}</td>
                    <td>${bo.economy}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `;
      }).join('')}

      ${chartsHTML}
      ${buildMatchWagonWheelSVG(m)}
    </div>
  `;

  openModal('Full Match Scorecard', html, () => true, false);
}

async function deleteMatchPrompt(matchId) {
  if (!confirm('Permanently delete this match and its ball records?')) return;
  await dbDelete('matches', matchId);
  showToast('Match deleted');
  renderHistory();
  renderDashboard();
}

// ==========================================
// 10. STATISTICS MODULE (MULTI-FILTER ENGINE)
// ==========================================

let cachedStatsTeams = [];
let cachedStatsMatches = [];

function switchStatsTab(tab) {
  currentStatsTab = tab;
  document.getElementById('btnStatsBatting')?.classList.toggle('active', tab === 'batting');
  document.getElementById('btnStatsBowling')?.classList.toggle('active', tab === 'bowling');
  document.getElementById('btnStatsFielding')?.classList.toggle('active', tab === 'fielding');
  renderStatistics();
}

async function populateStatsFilterDropdowns(teams, matches) {
  cachedStatsTeams = teams;
  cachedStatsMatches = matches;

  const seriesSelect = document.getElementById('statsSeriesFilter');
  const teamSelect = document.getElementById('statsTeamFilter');
  const matchSelect = document.getElementById('statsMatchFilter');

  if (seriesSelect && seriesSelect.options.length <= 1) {
    const uniqueSeries = [...new Set(matches.map(m => (m.series || '').trim()).filter(Boolean))].sort();
    uniqueSeries.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      seriesSelect.appendChild(opt);
    });
  }

  if (teamSelect && teamSelect.options.length <= 1) {
    teams.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.name;
      teamSelect.appendChild(opt);
    });
  }

  if (matchSelect && matchSelect.options.length <= 1) {
    matches.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      const tA = teams.find(t => t.id === m.a)?.name || 'Team A';
      const tB = teams.find(t => t.id === m.b)?.name || 'Team B';
      opt.textContent = `${tA} vs ${tB} (${m.date || 'Match'})`;
      matchSelect.appendChild(opt);
    });
  }
}

function onStatsFilterChange(changedFilter) {
  if (changedFilter === 'match') {
    const matchId = document.getElementById('statsMatchFilter')?.value;
    if (matchId) {
      const match = cachedStatsMatches.find(m => m.id === matchId);
      const teamSelect = document.getElementById('statsTeamFilter');
      if (match && teamSelect && teamSelect.value && teamSelect.value !== match.a && teamSelect.value !== match.b) {
        teamSelect.value = '';
      }
    }
  }
  renderStatistics();
}

function getFilteredStatsMatches(matches) {
  const seriesFilter = document.getElementById('statsSeriesFilter')?.value || '';
  const formatFilter = document.getElementById('statsFormatFilter')?.value || '';
  const teamFilter = document.getElementById('statsTeamFilter')?.value || '';
  const matchFilter = document.getElementById('statsMatchFilter')?.value || '';

  return matches.filter(m => {
    const matchSeries = !seriesFilter || (m.series || '').trim() === seriesFilter;
    const matchFormat = !formatFilter || m.format === formatFilter;
    const matchTeam = !teamFilter || m.a === teamFilter || m.b === teamFilter;
    const matchSpecific = !matchFilter || m.id === matchFilter;
    return matchSeries && matchFormat && matchTeam && matchSpecific;
  });
}

function computePlayerFigures(matches, players) {
  const battingStats = {};
  const bowlingStats = {};
  const fieldingStats = {};

  players.forEach(p => {
    battingStats[p.id] = { id: p.id, name: p.name, role: p.role || 'Batter', innings: 0, runs: 0, balls: 0, fours: 0, sixes: 0, highest: 0, outs: 0, fifties: 0, hundreds: 0 };
    bowlingStats[p.id] = { id: p.id, name: p.name, role: p.role || 'Bowler', legalBalls: 0, runs: 0, wickets: 0 };
    fieldingStats[p.id] = { id: p.id, name: p.name, role: p.role || 'Player', catches: 0, runOuts: 0, stumpings: 0, totalDismissals: 0 };
  });

  matches.forEach(m => {
    (m.innings || []).forEach(inn => {
      const stats = CricketEngine.calculateInnings(inn, inn.squad, inn.bowlingSquad);

      // Batting
      stats.batters.forEach(b => {
        if (!battingStats[b.id]) {
          battingStats[b.id] = { id: b.id, name: b.name, role: 'Batter', innings: 0, runs: 0, balls: 0, fours: 0, sixes: 0, highest: 0, outs: 0, fifties: 0, hundreds: 0 };
        }
        if (b.balls > 0 || b.isOut) {
          const bs = battingStats[b.id];
          bs.innings += 1;
          bs.runs += b.runs;
          bs.balls += b.balls;
          bs.fours += b.fours;
          bs.sixes += b.sixes;
          if (b.runs > bs.highest) bs.highest = b.runs;
          if (b.runs >= 100) bs.hundreds += 1;
          else if (b.runs >= 50) bs.fifties += 1;
          if (b.isOut) bs.outs += 1;
        }
      });

      // Bowling
      stats.bowlers.forEach(bo => {
        if (!bowlingStats[bo.id]) {
          bowlingStats[bo.id] = { id: bo.id, name: bo.name, role: 'Bowler', legalBalls: 0, runs: 0, wickets: 0 };
        }
        const bl = bowlingStats[bo.id];
        bl.legalBalls += bo.legalBalls;
        bl.runs += bo.runsConceded;
        bl.wickets += bo.wickets;
      });

      // Fielding
      (inn.balls || []).forEach(ball => {
        if (ball.wicket && ball.dismissalDetails?.fielderId) {
          const fid = ball.dismissalDetails.fielderId;
          if (!fieldingStats[fid]) {
            fieldingStats[fid] = { id: fid, name: 'Fielder', role: 'Fielder', catches: 0, runOuts: 0, stumpings: 0, totalDismissals: 0 };
          }
          const fs = fieldingStats[fid];
          if (ball.dismissal === 'caught') fs.catches += 1;
          else if (ball.dismissal === 'runOut') fs.runOuts += 1;
          else if (ball.dismissal === 'stumped') fs.stumpings += 1;
          fs.totalDismissals += 1;
        }
      });
    });
  });

  return { battingStats, bowlingStats, fieldingStats };
}

async function renderStatistics() {
  const [matches, players, teams] = await Promise.all([
    dbGetAll('matches'), dbGetAll('players'), dbGetAll('teams')
  ]);

  await populateStatsFilterDropdowns(teams, matches);

  const container = document.getElementById('statsTableContainer');
  if (!container) return;

  const filteredMatches = getFilteredStatsMatches(matches);
  const { battingStats, bowlingStats, fieldingStats } = computePlayerFigures(filteredMatches, players);

  if (!filteredMatches.length) {
    container.innerHTML = '<p class="muted" style="padding:18px; text-align:center;">No matches found matching the selected filters.</p>';
    return;
  }

  if (currentStatsTab === 'batting') {
    const list = Object.values(battingStats).filter(b => b.innings > 0).sort((a,b) => b.runs - a.runs);
    container.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>Player</th>
            <th>Inn</th>
            <th>Runs</th>
            <th>HS</th>
            <th>Avg</th>
            <th>SR</th>
            <th>4s</th>
            <th>6s</th>
          </tr>
        </thead>
        <tbody>
          ${list.length ? list.map(b => {
            const avg = b.outs > 0 ? (b.runs / b.outs).toFixed(1) : b.runs.toFixed(1);
            const sr = b.balls > 0 ? ((b.runs / b.balls) * 100).toFixed(1) : '0.0';
            return `
              <tr>
                <td><strong>${escapeHTML(b.name)}</strong></td>
                <td>${b.innings}</td>
                <td><strong>${b.runs}</strong></td>
                <td>${b.highest}</td>
                <td>${avg}</td>
                <td>${sr}</td>
                <td>${b.fours}</td>
                <td>${b.sixes}</td>
              </tr>
            `;
          }).join('') : '<tr><td colspan="8" style="text-align:center; padding:12px;">No batting records for this filter.</td></tr>'}
        </tbody>
      </table>
    `;
  } else if (currentStatsTab === 'bowling') {
    const list = Object.values(bowlingStats).filter(b => b.legalBalls > 0).sort((a,b) => b.wickets - a.wickets);
    container.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>Bowler</th>
            <th>Overs</th>
            <th>Runs</th>
            <th>Wkts</th>
            <th>Econ</th>
            <th>Avg</th>
          </tr>
        </thead>
        <tbody>
          ${list.length ? list.map(bo => {
            const overs = `${Math.floor(bo.legalBalls / 6)}.${bo.legalBalls % 6}`;
            const oversDec = bo.legalBalls / 6;
            const econ = oversDec > 0 ? (bo.runs / oversDec).toFixed(2) : '0.00';
            const avg = bo.wickets > 0 ? (bo.runs / bo.wickets).toFixed(1) : '--';
            return `
              <tr>
                <td><strong>${escapeHTML(bo.name)}</strong></td>
                <td>${overs}</td>
                <td>${bo.runs}</td>
                <td><strong style="color:var(--danger);">${bo.wickets}</strong></td>
                <td>${econ}</td>
                <td>${avg}</td>
              </tr>
            `;
          }).join('') : '<tr><td colspan="6" style="text-align:center; padding:12px;">No bowling records for this filter.</td></tr>'}
        </tbody>
      </table>
    `;
  } else {
    const list = Object.values(fieldingStats).filter(f => f.totalDismissals > 0).sort((a,b) => b.totalDismissals - a.totalDismissals);
    container.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>Player</th>
            <th>Catches</th>
            <th>Run Outs</th>
            <th>Stumpings</th>
            <th>Total Dismissals</th>
          </tr>
        </thead>
        <tbody>
          ${list.length ? list.map(f => `
            <tr>
              <td><strong>${escapeHTML(f.name)}</strong></td>
              <td>${f.catches}</td>
              <td>${f.runOuts}</td>
              <td>${f.stumpings}</td>
              <td><strong>${f.totalDismissals}</strong></td>
            </tr>
          `).join('') : '<tr><td colspan="5" style="text-align:center; padding:12px;">No fielding dismissals recorded for this filter.</td></tr>'}
        </tbody>
      </table>
    `;
  }
}

async function exportStatsCSV() {
  const [players, matches] = await Promise.all([dbGetAll('players'), dbGetAll('matches')]);
  const filteredMatches = getFilteredStatsMatches(matches);
  const { battingStats } = computePlayerFigures(filteredMatches, players);

  let csv = 'Player,Role,Innings,Runs,Balls,Highest,Average,StrikeRate,Fours,Sixes\n';
  Object.values(battingStats).filter(b => b.innings > 0).forEach(b => {
    const avg = b.outs > 0 ? (b.runs / b.outs).toFixed(1) : b.runs.toFixed(1);
    const sr = b.balls > 0 ? ((b.runs / b.balls) * 100).toFixed(1) : '0.0';
    csv += `"${b.name}","${b.role}",${b.innings},${b.runs},${b.balls},${b.highest},${avg},${sr},${b.fours},${b.sixes}\n`;
  });

  triggerDownload(csv, `CricScorer_Filtered_Stats_${Date.now()}.csv`, 'text/csv');
}

async function exportPlayerStatsPDF() {
  if (!db) await openDatabase();
  const [matches, players, teams] = await Promise.all([
    dbGetAll('matches'), dbGetAll('players'), dbGetAll('teams')
  ]);

  const filteredMatches = getFilteredStatsMatches(matches);
  if (!filteredMatches.length) {
    showToast('No matching records to export as PDF.');
    return;
  }

  showToast('Preparing filtered statistics PDF...');
  const { battingStats, bowlingStats } = computePlayerFigures(filteredMatches, players);

  const battingList = Object.values(battingStats).filter(b => b.innings > 0).sort((a,b) => b.runs - a.runs);
  const bowlingList = Object.values(bowlingStats).filter(b => b.legalBalls > 0).sort((a,b) => b.wickets - a.wickets);

  const teamVal = document.getElementById('statsTeamFilter')?.value;
  const matchVal = document.getElementById('statsMatchFilter')?.value;
  const formatVal = document.getElementById('statsFormatFilter')?.value;

  let filterLabel = 'All Fixtures';
  if (matchVal) {
    const mObj = matches.find(m => m.id === matchVal);
    const tA = teams.find(t => t.id === mObj?.a)?.name || 'Team A';
    const tB = teams.find(t => t.id === mObj?.b)?.name || 'Team B';
    filterLabel = `Match: ${tA} vs ${tB}`;
  } else if (teamVal) {
    const tObj = teams.find(t => t.id === teamVal);
    filterLabel = `Team: ${tObj?.name || 'Selected Team'}`;
  } else if (formatVal) {
    filterLabel = `Format: ${formatVal}`;
  }

  const dateStr = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

  const pdfHTML = `
    <div class="pdf-report-header">
      <div>
        <h1>🏏 CricScorer</h1>
        <p><strong>${escapeHTML(filterLabel)}</strong> — Performance & Records Summary</p>
      </div>
      <div class="pdf-meta-badge">
        <strong>Date:</strong> ${dateStr}<br>
        <strong>Matches Included:</strong> ${filteredMatches.length}<br>
        <strong>Active Players:</strong> ${battingList.length}
      </div>
    </div>

    <div class="pdf-section-title">Batting Figures</div>
    <table class="pdf-stats-table">
      <thead>
        <tr>
          <th>Player</th>
          <th>Role</th>
          <th class="num">Inn</th>
          <th class="num">Runs</th>
          <th class="num">HS</th>
          <th class="num">Avg</th>
          <th class="num">SR</th>
          <th class="num">50s</th>
          <th class="num">100s</th>
          <th class="num">4s</th>
          <th class="num">6s</th>
        </tr>
      </thead>
      <tbody>
        ${battingList.length ? battingList.map(b => {
          const avg = b.outs > 0 ? (b.runs / b.outs).toFixed(1) : b.runs.toFixed(1);
          const sr = b.balls > 0 ? ((b.runs / b.balls) * 100).toFixed(1) : '0.0';
          return `
            <tr>
              <td><strong>${escapeHTML(b.name)}</strong></td>
              <td>${escapeHTML(b.role)}</td>
              <td class="num">${b.innings}</td>
              <td class="num"><strong>${b.runs}</strong></td>
              <td class="num">${b.highest}</td>
              <td class="num">${avg}</td>
              <td class="num">${sr}</td>
              <td class="num">${b.fifties}</td>
              <td class="num">${b.hundreds}</td>
              <td class="num">${b.fours}</td>
              <td class="num">${b.sixes}</td>
            </tr>
          `;
        }).join('') : '<tr><td colspan="11" style="text-align:center; padding:12px;">No batting records logged.</td></tr>'}
      </tbody>
    </table>

    <div class="pdf-section-title">Bowling Figures</div>
    <table class="pdf-stats-table">
      <thead>
        <tr>
          <th>Bowler</th>
          <th class="num">Overs</th>
          <th class="num">Runs</th>
          <th class="num">Wkts</th>
          <th class="num">Econ</th>
          <th class="num">Avg</th>
        </tr>
      </thead>
      <tbody>
        ${bowlingList.length ? bowlingList.map(bo => {
          const fullOvers = Math.floor(bo.legalBalls / 6);
          const remBalls = bo.legalBalls % 6;
          const oversFormatted = `${fullOvers}.${remBalls}`;
          const oversDec = bo.legalBalls / 6;
          const econ = oversDec > 0 ? (bo.runs / oversDec).toFixed(2) : '0.00';
          const avg = bo.wickets > 0 ? (bo.runs / bo.wickets).toFixed(1) : '--';
          return `
            <tr>
              <td><strong>${escapeHTML(bo.name)}</strong></td>
              <td class="num">${oversFormatted}</td>
              <td class="num">${bo.runs}</td>
              <td class="num"><strong>${bo.wickets}</strong></td>
              <td class="num">${econ}</td>
              <td class="num">${avg}</td>
            </tr>
          `;
        }).join('') : '<tr><td colspan="6" style="text-align:center; padding:12px;">No bowling records logged.</td></tr>'}
      </tbody>
    </table>

    <div class="pdf-footer">
      <span>Generated by CricScorer (Filtered Export)</span>
      <span>Page 1 of 1</span>
    </div>
  `;

  const container = document.getElementById('statsPdfPrintContainer');
  if (container) {
    container.innerHTML = pdfHTML;
  }

  setTimeout(() => {
    window.print();
  }, 250);
}

// ==========================================
// 11. BACKUP, RESTORE & AUDIT LOGS
// ==========================================

// ==========================================
// IN-APP AUTO BACKUP ENGINE
// ==========================================

const AUTO_BACKUP_KEY = 'CricScorer_AutoBackup_Vault';
let autoBackupDebounceTimer = null;

function triggerAutoBackup() {
  clearTimeout(autoBackupDebounceTimer);
  autoBackupDebounceTimer = setTimeout(async () => {
    try {
      if (!db) return;
      const settings = await dbGetAll('settings');
      const isEnabled = settings.find(s => s.key === 'autoBackupEnabled')?.val;
      if (isEnabled === false) return; // Enabled by default unless explicitly disabled

      const [teams, players, matches] = await Promise.all([
        dbGetAll('teams'), dbGetAll('players'), dbGetAll('matches')
      ]);

      const snapshot = {
        app: 'CricScorer',
        schemaVersion: 2,
        snapshotAt: new Date().toISOString(),
        teams,
        players,
        matches,
        summary: {
          teamsCount: teams.length,
          playersCount: players.length,
          matchesCount: matches.length
        }
      };

      await dbPut('settings', { key: AUTO_BACKUP_KEY, val: snapshot });
      await dbPut('settings', { key: 'autoBackupLastRun', val: snapshot.snapshotAt });
      updateAutoBackupDisplay(snapshot);
      console.log('[AutoBackup] Local recovery snapshot created at', snapshot.snapshotAt);
    } catch (err) {
      console.warn('[AutoBackup] Background snapshot error:', err);
    }
  }, 800);
}

async function toggleAutoBackupPreference(enabled) {
  await saveAppSetting('autoBackupEnabled', enabled);
  if (enabled) {
    triggerAutoBackup();
    showToast('Auto Backup enabled');
  } else {
    showToast('Auto Backup paused');
  }
}

async function restoreFromAutoBackupVault() {
  try {
    if (!db) await openDatabase();
    const settings = await dbGetAll('settings');
    const vaultItem = settings.find(s => s.key === AUTO_BACKUP_KEY);

    if (!vaultItem || !vaultItem.val) {
      alert('No auto-backup snapshot found in the local vault yet.');
      return;
    }

    const data = vaultItem.val;
    const dateFormatted = new Date(data.snapshotAt).toLocaleString();
    const promptMsg = `Restore auto snapshot from ${dateFormatted}?\n\nContains: ${data.teams.length} teams, ${data.players.length} players, ${data.matches.length} matches. Existing data will be merged.`;

    if (!confirm(promptMsg)) return;

    for (const t of (data.teams || [])) await dbPut('teams', t);
    for (const p of (data.players || [])) await dbPut('players', p);
    for (const m of (data.matches || [])) await dbPut('matches', m);

    showToast('Restored from Auto Backup snapshot!');
    renderDashboard();
    renderSettings();
  } catch (err) {
    alert('Could not restore auto backup: ' + err.message);
  }
}

function updateAutoBackupDisplay(snapshot) {
  const timeEl = document.getElementById('autoBackupTimestampText');
  if (timeEl && snapshot && snapshot.snapshotAt) {
    const d = new Date(snapshot.snapshotAt);
    timeEl.textContent = `Last snapshot: ${d.toLocaleDateString()} at ${d.toLocaleTimeString()} (${snapshot.matches?.length || 0} matches, ${snapshot.players?.length || 0} players)`;
  }
}

async function exportFullDatabaseJSON() {
  const [teams, players, matches, settings] = await Promise.all([
    dbGetAll('teams'), dbGetAll('players'), dbGetAll('matches'), dbGetAll('settings')
  ]);

  const backupPayload = {
    app: 'CricScorer',
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    teams,
    players,
    matches,
    settings
  };

  triggerDownload(JSON.stringify(backupPayload, null, 2), `CricScorer_Full_Backup_${Date.now()}.json`, 'application/json');
  showToast('Full backup downloaded');
}

async function handleBackupFileSelect(event) {
  const file = event.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const data = JSON.parse(text);

    // Validate backup schema
    const isValidV1 = data.app === 'LocalCricket' && Array.isArray(data.teams) && Array.isArray(data.players) && Array.isArray(data.matches);
    const isValidV2 = data.app === 'CricScorer' && Array.isArray(data.teams) && Array.isArray(data.players) && Array.isArray(data.matches);

    if (!isValidV1 && !isValidV2) {
      throw new Error('Unsupported or corrupted JSON backup format.');
    }

    if (!confirm(`Restore ${data.teams.length} teams, ${data.players.length} players, and ${data.matches.length} matches? This will merge with existing records.`)) {
      event.target.value = '';
      return;
    }

    for (const t of data.teams) await dbPut('teams', t);
    for (const p of data.players) await dbPut('players', p);
    for (const m of data.matches) await dbPut('matches', m);

    showToast('Backup restored successfully!');
    navigate('dashboard');
  } catch (err) {
    alert('Restore failed: ' + err.message);
  } finally {
    event.target.value = '';
  }
}

async function confirmWipeAllData() {
  if (prompt('Type "DELETE" to permanently wipe all teams, players, and match records:') === 'DELETE') {
    for (const s of ['teams', 'players', 'matches', 'deliveries', 'settings']) {
      await new Promise(res => {
        const tx = db.transaction(s, 'readwrite');
        tx.objectStore(s).clear();
        tx.oncomplete = res;
      });
    }
    showToast('All local data wiped');
    navigate('dashboard');
  }
}



function triggerDownload(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ==========================================
// 12. THEME & SETTINGS CONTROLLER
// ==========================================

function toggleTheme() {
  const current = document.body.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  document.body.setAttribute('data-theme', next);
  
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) {
    themeMeta.setAttribute('content', next === 'dark' ? '#0b3b2e' : '#ffffff');
  }

  if (db) {
    saveAppSetting('theme', next).catch(() => {});
  }
}

async function saveAppSetting(key, val) {
  if (!db) return;
  try {
    await dbPut('settings', { key, val });
  } catch (e) {
    console.warn('Could not save setting:', e);
  }
}

async function loadSavedSettings() {
  if (!db) return;
  try {
    const settings = await dbGetAll('settings');
    const theme = settings.find(s => s.key === 'theme')?.val;
    if (theme) {
      document.body.setAttribute('data-theme', theme);
      const themeMeta = document.querySelector('meta[name="theme-color"]');
      if (themeMeta) {
        themeMeta.setAttribute('content', theme === 'dark' ? '#0b3b2e' : '#ffffff');
      }
    }
    const defaultFormat = settings.find(s => s.key === 'defaultFormat')?.val;
    if (defaultFormat) {
      const sel = document.getElementById('settingDefaultFormat');
      if (sel) sel.value = defaultFormat;
    }
  } catch (e) {
    console.warn('Could not load settings:', e);
  }
}

function openModal(title, htmlContent, onSaveCallback, showSaveBtn = true) {
  const modal = document.getElementById('appModal');
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBody').innerHTML = htmlContent;

  const footer = document.getElementById('modalFooter');
  footer.innerHTML = `
    <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
    ${showSaveBtn ? `<button type="button" class="btn btn-primary" id="modalSubmitBtn">Save</button>` : ''}
  `;

  if (showSaveBtn) {
    document.getElementById('modalSubmitBtn').onclick = async (e) => {
      e.preventDefault();
      try {
        const success = await onSaveCallback();
        if (success !== false) closeModal();
      } catch (err) {
        showToast(err.message || 'Error saving');
      }
    };
  }

  if (typeof modal.showModal === 'function') {
    modal.showModal();
  } else {
    modal.setAttribute('open', '');
  }
}

function closeModal() {
  const modal = document.getElementById('appModal');
  if (modal.open) {
    modal.close();
  } else {
    modal.removeAttribute('open');
  }
}


// ==========================================
// SCREEN WAKE LOCK, HAPTICS & SETTINGS
// ==========================================

let screenWakeLock = null;

async function toggleWakeLockPreference(enabled) {
  await saveAppSetting('wakeLock', enabled);
  if (enabled) {
    requestWakeLock();
  } else if (screenWakeLock) {
    screenWakeLock.release().then(() => { screenWakeLock = null; });
  }
}

async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      screenWakeLock = await navigator.wakeLock.request('screen');
      screenWakeLock.addEventListener('release', () => { screenWakeLock = null; });
    } catch (err) {
      console.warn('Wake Lock error:', err);
    }
  }
}

function triggerHaptic(type = 'normal') {
  const hapticSetting = document.getElementById('settingHaptics')?.checked;
  if (!hapticSetting || !('vibrate' in navigator)) return;

  if (type === 'boundary') {
    navigator.vibrate([40, 60, 40]);
  } else if (type === 'wicket') {
    navigator.vibrate(120);
  } else {
    navigator.vibrate(25);
  }
}

function handleThemeSwitch(isLight) {
  const targetTheme = isLight ? 'light' : 'dark';
  document.body.setAttribute('data-theme', targetTheme);
  
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) {
    themeMeta.setAttribute('content', targetTheme === 'dark' ? '#0b3b2e' : '#ffffff');
  }

  saveAppSetting('theme', targetTheme);
}

async function renderSettings() {
  if (!db) await openDatabase();
  const [teams, players, matches, settings] = await Promise.all([
    dbGetAll('teams'), dbGetAll('players'), dbGetAll('matches'), dbGetAll('settings')
  ]);

  const shotWheelEl = document.getElementById('settingShotWheel');
  if (shotWheelEl) shotWheelEl.checked = !!shotWheelEnabled;
  const teamsEl = document.getElementById('dbCountTeams');
  if (teamsEl) teamsEl.textContent = teams.length;
  const playersEl = document.getElementById('dbCountPlayers');
  if (playersEl) playersEl.textContent = players.length;
  const matchesEl = document.getElementById('dbCountMatches');
  if (matchesEl) matchesEl.textContent = matches.length;

  let totalBalls = 0;
  matches.forEach(m => (m.innings || []).forEach(inn => { totalBalls += (inn.balls || []).length; }));
  const delivEl = document.getElementById('dbCountDeliveries');
  if (delivEl) delivEl.textContent = totalBalls;

  const currentTheme = document.body.getAttribute('data-theme') || 'dark';
  const themeToggle = document.getElementById('settingThemeToggle');
  if (themeToggle) themeToggle.checked = (currentTheme === 'light');

  const wakeVal = settings.find(s => s.key === 'wakeLock')?.val;
  const wakeToggle = document.getElementById('settingWakeLock');
  if (wakeToggle) wakeToggle.checked = !!wakeVal;

  const hapticsVal = settings.find(s => s.key === 'haptics')?.val;
  const hapticsToggle = document.getElementById('settingHaptics');
  if (hapticsToggle) hapticsToggle.checked = (hapticsVal !== false);

  const defaultFormat = settings.find(s => s.key === 'defaultFormat')?.val;
  const formatSelect = document.getElementById('settingDefaultFormat');
  if (formatSelect && defaultFormat) formatSelect.value = defaultFormat;

  const bowlerCap = settings.find(s => s.key === 'bowlerCapRule')?.val;
  const capSelect = document.getElementById('settingBowlerCap');
  if (capSelect && bowlerCap) capSelect.value = bowlerCap;

  // Sync Auto Backup Toggle & Display
  const autoBackupPref = settings.find(s => s.key === 'autoBackupEnabled')?.val;
  const autoBackupSwitch = document.getElementById('settingAutoBackup');
  if (autoBackupSwitch) autoBackupSwitch.checked = (autoBackupPref !== false);

  const vaultData = settings.find(s => s.key === AUTO_BACKUP_KEY)?.val;
  if (vaultData) {
    updateAutoBackupDisplay(vaultData);
  }

  inspectStorageQuota();
}

async function inspectStorageQuota() {
  const quotaEl = document.getElementById('storageQuotaDetail');
  if (navigator.storage && navigator.storage.estimate) {
    const est = await navigator.storage.estimate();
    const usedMB = (est.usage / (1024 * 1024)).toFixed(2);
    const quotaMB = (est.quota / (1024 * 1024)).toFixed(0);
    if (quotaEl) quotaEl.textContent = `Using ${usedMB} MB of ~${quotaMB} MB quota available.`;
  }
}

function dismissSplashOverlay() {
  const splash = document.getElementById('appSplashOverlay');
  if (splash && !splash.classList.contains('splash-hidden')) {
    splash.classList.add('splash-hidden');
    setTimeout(() => splash.remove(), 500);
  }
}

// App Launch
document.addEventListener('DOMContentLoaded', () => {
  const splash = document.getElementById('appSplashOverlay');
  if (splash) {
    let alreadyShown = false;
    try {
      alreadyShown = sessionStorage.getItem('cricscorer_splash_shown') === '1';
      if (!alreadyShown) {
        sessionStorage.setItem('cricscorer_splash_shown', '1');
      }
    } catch (e) {}

    if (alreadyShown) {
      splash.remove();
    } else {
      splash.addEventListener('click', dismissSplashOverlay);
      setTimeout(dismissSplashOverlay, 1550);
    }
  }
  // themeToggleBtn handled directly via onclick in index.html

  const initialTab = getSavedActiveTab();
  if (initialTab && initialTab !== 'dashboard') {
    document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === initialTab));
    document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.nav === initialTab));
  }

  window.addEventListener('hashchange', () => {
    const hashTab = getSavedActiveTab();
    if (hashTab) navigate(hashTab, { instant: true });
  });

  openDatabase()
    .then(async () => {
      await loadSavedSettings();
      const restoredTab = getSavedActiveTab();
      if (restoredTab && restoredTab !== 'dashboard') {
        navigate(restoredTab, { instant: true });
      } else {
        renderDashboard();
      }
      triggerAutoBackup();
    })
    .catch((err) => {
      console.error('Database launch error:', err);
      showToast('Running in local storage fallback mode.');
    });

  syncFxToggleBtn();
  initTopNavTelemetry();
  initSupabaseCloud();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
});


// Interactive Top Nav Cricket Telemetry & Parabolic Seam-Ball Trajectory
function initTopNavTelemetry() {
  const header = document.getElementById('interactiveTopNav');
  const canvas = document.getElementById('topNavTelemetryCanvas');
  const toastEl = document.getElementById('topNavPulseToast');
  if (!header || !canvas) return;
  const ctx = canvas.getContext('2d');

  let width = 0;
  let height = 0;
  let dpr = Math.min(window.devicePixelRatio || 1, 2);
  let t = 0;
  let burstEnergy = 0;
  let burstX = 0;
  let burstY = 0;
  let toastTimer = null;

  const callouts = [
    '⚡ 6! MAXIMUM BOUNDARY PULSE',
    '🏏 SWEET SPOT TIMING',
    '🔥 POWERPLAY SURGE',
    '✨ CRICKET TELEMETRY ACTIVE'
  ];
  let calloutIdx = 0;

  const motes = Array.from({ length: 14 }, (_, i) => ({
    x: (i * 0.073) % 1,
    y: (i * 0.137) % 1,
    r: 0.8 + (i % 3) * 0.55,
    vx: 0.00045 + (i % 4) * 0.00018,
    phase: i * 0.8
  }));

  function resize() {
    const rect = header.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  header.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    const rect = header.getBoundingClientRect();
    burstX = e.clientX - rect.left;
    burstY = e.clientY - rect.top;
    burstEnergy = 1.0;

    if (toastEl) {
      toastEl.textContent = callouts[calloutIdx % callouts.length];
      calloutIdx++;
      toastEl.classList.add('visible');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl.classList.remove('visible'), 1300);
    }
  });

  function renderFrame() {
    const isLight = document.body.getAttribute('data-theme') === 'light';
    const primaryRgb = isLight ? '6, 95, 70' : '0, 230, 118';
    const accentRgb = isLight ? '220, 38, 38' : '163, 230, 53';

    ctx.clearRect(0, 0, width, height);

    // Subtle stadium horizon glow
    const grad = ctx.createRadialGradient(width * 0.62, height * 0.5, 4, width * 0.62, height * 0.5, width * 0.48);
    grad.addColorStop(0, `rgba(${primaryRgb}, ${isLight ? 0.08 : 0.13})`);
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    // Boundary radar arcs on right
    const rx = width - 46;
    const ry = height * 0.52;
    ctx.save();
    ctx.strokeStyle = `rgba(${primaryRgb}, ${isLight ? 0.32 : 0.18})`;
    ctx.lineWidth = isLight ? 1.3 : 1;
    ctx.setLineDash([4, 5]);
    ctx.beginPath();
    ctx.arc(rx, ry, 28, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(rx, ry, 44, t * 0.35, t * 0.35 + Math.PI * 1.35);
    ctx.stroke();
    ctx.restore();

    // Floating stadium motes
    motes.forEach((m) => {
      m.x = (m.x + m.vx * (1 + burstEnergy * 1.8)) % 1;
      const mx = m.x * width;
      const my = m.y * height + Math.sin(t * 1.6 + m.phase) * 3;
      const alpha = (isLight ? 0.38 : 0.35) + 0.15 * Math.sin(t * 2 + m.phase);
      ctx.fillStyle = `rgba(${primaryRgb}, ${alpha})`;
      ctx.beginPath();
      ctx.arc(mx, my, m.r, 0, Math.PI * 2);
      ctx.fill();
    });

    // Parabolic Seam-Ball Trajectory
    const startX = width * 0.36;
    const endX = width * 0.84;
    const baseY = height - 10;
    const peakY = 12;
    const progress = (t * (0.24 + burstEnergy * 0.32)) % 1;

    // Dotted trajectory path
    ctx.save();
    ctx.strokeStyle = `rgba(${primaryRgb}, ${isLight ? 0.34 : 0.22})`;
    ctx.lineWidth = isLight ? 1.4 : 1.2;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    for (let s = 0; s <= 24; s++) {
      const p = s / 24;
      const px = startX + (endX - startX) * p;
      const py = baseY - Math.sin(p * Math.PI) * (baseY - peakY);
      if (s === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.restore();

    // Glowing trail & seam-spinning cricket ball
    const bx = startX + (endX - startX) * progress;
    const by = baseY - Math.sin(progress * Math.PI) * (baseY - peakY);

    const trailGrad = ctx.createLinearGradient(bx - 34, by + 6, bx, by);
    trailGrad.addColorStop(0, 'rgba(0,0,0,0)');
    trailGrad.addColorStop(1, `rgba(${accentRgb}, ${isLight ? 0.6 : 0.55})`);
    ctx.strokeStyle = trailGrad;
    ctx.lineWidth = isLight ? 2.8 : 2.5;
    ctx.beginPath();
    ctx.moveTo(Math.max(startX, bx - 32), baseY - Math.sin(Math.max(0, progress - 0.14) * Math.PI) * (baseY - peakY));
    ctx.lineTo(bx, by);
    ctx.stroke();

    // Ball core (Crimson red leather ball in Light Mode, glowing white in Dark Mode)
    ctx.save();
    ctx.translate(bx, by);
    ctx.rotate(t * 4.5);
    ctx.fillStyle = isLight ? '#dc2626' : '#ffffff';
    ctx.shadowColor = isLight ? 'rgba(220, 38, 38, 0.55)' : `rgba(${primaryRgb}, 0.75)`;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(0, 0, isLight ? 4.2 : 3.6, 0, Math.PI * 2);
    ctx.fill();

    // Seam line
    ctx.strokeStyle = isLight ? '#ffffff' : '#0b1017';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.arc(0, 0, 2.3, -0.7, 0.7);
    ctx.stroke();
    ctx.restore();

    // Interactive Boundary Pulse shockwave on tap
    if (burstEnergy > 0.01) {
      const radius = (1 - burstEnergy) * 75 + 8;
      ctx.save();
      ctx.strokeStyle = `rgba(${primaryRgb}, ${burstEnergy * 0.75})`;
      ctx.lineWidth = 2 * burstEnergy;
      ctx.beginPath();
      ctx.arc(burstX, burstY, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      burstEnergy *= 0.93;
    }

    t += 0.016;
    requestAnimationFrame(renderFrame);
  }

  requestAnimationFrame(renderFrame);
}


// ==========================================
// TOURNAMENTS & LEAGUES MODULE (SCHEDULE, TEAMS, POINTS TABLE & NRR)
// ==========================================
const TOURNAMENTS_STORAGE_KEY = 'cricscorer_tournaments_v1';
let selectedTournamentId = null;

async function getAllTournaments() {
  if (!db) return [];
  try {
    const item = await dbGet('settings', TOURNAMENTS_STORAGE_KEY);
    return Array.isArray(item?.val) ? item.val : [];
  } catch (e) {
    try {
      const settings = await dbGetAll('settings');
      const found = settings.find(s => s.key === TOURNAMENTS_STORAGE_KEY);
      return Array.isArray(found?.val) ? found.val : [];
    } catch (err) {
      return [];
    }
  }
}

async function saveAllTournaments(list) {
  if (!db) return;
  await dbPut('settings', { key: TOURNAMENTS_STORAGE_KEY, val: list });
  triggerAutoBackup();
  queueCloudTournamentsSync(list);
}

function generateRoundRobinFixtures(teamIds, doubleRound = false) {
  const fixtures = [];
  let matchNum = 1;
  const rounds = doubleRound ? 2 : 1;
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < teamIds.length; i++) {
      for (let j = i + 1; j < teamIds.length; j++) {
        const teamA = r === 0 ? teamIds[i] : teamIds[j];
        const teamB = r === 0 ? teamIds[j] : teamIds[i];
        fixtures.push({
          id: generateId(),
          matchNumber: matchNum++,
          roundLabel: doubleRound ? `League Stage (Leg ${r + 1})` : 'League Stage',
          teamAId: teamA,
          teamBId: teamB,
          status: 'Scheduled',
          matchId: null,
          result: '',
          winnerTeamId: null
        });
      }
    }
  }
  return fixtures;
}

function generateKnockoutFixtures(teamIds) {
  const fixtures = [];
  let matchNum = 1;
  const total = teamIds.length;
  const roundName = total <= 2 ? 'Grand Final' : total <= 4 ? 'Semi-Final' : 'Quarter-Final';
  for (let i = 0; i < total; i += 2) {
    if (i + 1 < total) {
      fixtures.push({
        id: generateId(),
        matchNumber: matchNum++,
        roundLabel: roundName,
        teamAId: teamIds[i],
        teamBId: teamIds[i + 1],
        status: 'Scheduled',
        matchId: null,
        result: '',
        winnerTeamId: null
      });
    } else {
      fixtures.push({
        id: generateId(),
        matchNumber: matchNum++,
        roundLabel: `${roundName} (Bye)`,
        teamAId: teamIds[i],
        teamBId: teamIds[0],
        status: 'Scheduled',
        matchId: null,
        result: '',
        winnerTeamId: null
      });
    }
  }
  return fixtures;
}

function computeTournamentStandings(tournament, teamsMap, allMatches) {
  const table = {};
  (tournament.teamIds || []).forEach(tid => {
    table[tid] = {
      teamId: tid,
      teamName: teamsMap[tid] || 'Team',
      played: 0,
      won: 0,
      lost: 0,
      tied: 0,
      points: 0,
      runsFor: 0,
      oversFacedFloat: 0,
      runsAgainst: 0,
      oversBowledFloat: 0,
      nrr: 0
    };
  });

  (tournament.fixtures || []).forEach(fx => {
    if (fx.status !== 'Completed') return;
    const m = allMatches.find(item => item.id === fx.matchId);
    const rowA = table[fx.teamAId];
    const rowB = table[fx.teamBId];
    if (!rowA || !rowB) return;

    rowA.played += 1;
    rowB.played += 1;

    if (fx.winnerTeamId === fx.teamAId) {
      rowA.won += 1;
      rowA.points += 2;
      rowB.lost += 1;
    } else if (fx.winnerTeamId === fx.teamBId) {
      rowB.won += 1;
      rowB.points += 2;
      rowA.lost += 1;
    } else {
      rowA.tied += 1;
      rowB.tied += 1;
      rowA.points += 1;
      rowB.points += 1;
    }

    if (m && Array.isArray(m.innings) && m.innings.length >= 1) {
      const maxOv = m.overs || tournament.overs || 20;
      m.innings.forEach(inn => {
        const st = CricketEngine.calculateInnings(inn, inn.squad, inn.bowlingSquad);
        const squadCount = (inn.squad || []).length;
        const maxWkts = squadCount >= 2 ? (squadCount - 1) : 10;
        const isAllOut = st.wickets >= maxWkts;
        const oversUsed = isAllOut ? maxOv : (st.legalDeliveries / 6);

        if (table[inn.batting]) {
          table[inn.batting].runsFor += st.totalRuns;
          table[inn.batting].oversFacedFloat += oversUsed;
        }
        if (table[inn.bowling]) {
          table[inn.bowling].runsAgainst += st.totalRuns;
          table[inn.bowling].oversBowledFloat += oversUsed;
        }
      });
    }
  });

  const rows = Object.values(table).map(r => {
    const forRate = r.oversFacedFloat > 0 ? (r.runsFor / r.oversFacedFloat) : 0;
    const againstRate = r.oversBowledFloat > 0 ? (r.runsAgainst / r.oversBowledFloat) : 0;
    r.nrr = forRate - againstRate;
    return r;
  });

  rows.sort((a, b) => (b.points - a.points) || (b.nrr - a.nrr) || (b.won - a.won));
  return rows;
}

async function syncTournamentFixtureCompletion(matchObj, stats1, stats2) {
  const tournaments = await getAllTournaments();
  const tIdx = tournaments.findIndex(t => t.id === matchObj.tournamentId);
  if (tIdx === -1) return;

  const tourn = tournaments[tIdx];
  const fIdx = (tourn.fixtures || []).findIndex(f => f.id === matchObj.tournamentFixtureId);
  if (fIdx === -1) return;

  const inn1 = matchObj.innings[0];
  let winnerId = null;
  if (stats2) {
    if (stats2.totalRuns >= (stats1.totalRuns + 1)) winnerId = inn1.bowling;
    else if (stats1.totalRuns > stats2.totalRuns) winnerId = inn1.batting;
  }

  tourn.fixtures[fIdx].status = 'Completed';
  tourn.fixtures[fIdx].matchId = matchObj.id;
  tourn.fixtures[fIdx].result = matchObj.result || 'Completed';
  tourn.fixtures[fIdx].winnerTeamId = winnerId;

  await saveAllTournaments(tournaments);
}

let activeTournamentSubTab = 'standings';

function switchTournamentSubTab(tab) {
  activeTournamentSubTab = tab;
  renderTournamentsView();
}

function computeTournamentPlayerCaps(tournament, teamsMap, allMatches) {
  const tourMatches = allMatches.filter(m =>
    m.tournamentId === tournament.id ||
    (tournament.fixtures || []).some(f => f.matchId && f.matchId === m.id)
  );

  const batters = {};
  const bowlers = {};
  const mvpMap = {};

  const ensureBatter = (id, name, teamName) => {
    if (!batters[id]) {
      batters[id] = { id, name: name || 'Batter', teamName: teamName || 'Team', innings: 0, runs: 0, balls: 0, fours: 0, sixes: 0, fifties: 0, hundreds: 0, highScore: 0 };
    }
    return batters[id];
  };

  const ensureBowler = (id, name, teamName) => {
    if (!bowlers[id]) {
      bowlers[id] = { id, name: name || 'Bowler', teamName: teamName || 'Team', innings: 0, legalBalls: 0, runsConceded: 0, wickets: 0, fiveW: 0, bestW: 0, bestR: 999 };
    }
    return bowlers[id];
  };

  const addMvp = (id, name, teamName, pts) => {
    if (!id) return;
    if (!mvpMap[id]) mvpMap[id] = { id, name: name || 'Player', teamName: teamName || 'Team', pts: 0, runs: 0, wickets: 0 };
    mvpMap[id].pts += pts;
  };

  tourMatches.forEach(m => {
    (m.innings || []).forEach(inn => {
      const batTeamName = teamsMap[inn.batting] || (inn.batting === m.a ? m.teamAName : m.teamBName) || 'Team';
      const bowlTeamName = teamsMap[inn.bowling] || (inn.bowling === m.a ? m.teamAName : m.teamBName) || 'Team';
      const st = CricketEngine.calculateInnings(inn, inn.squad || [], inn.bowlingSquad || []);

      (st.batters || []).forEach(b => {
        if (b.balls > 0 || b.runs > 0 || b.isOut) {
          const rec = ensureBatter(b.id, b.name, batTeamName);
          rec.innings += 1;
          rec.runs += b.runs;
          rec.balls += b.balls;
          rec.fours += b.fours || 0;
          rec.sixes += b.sixes || 0;
          if (b.runs >= 100) rec.hundreds += 1;
          else if (b.runs >= 50) rec.fifties += 1;
          if (b.runs > rec.highScore) rec.highScore = b.runs;

          let pts = b.runs + (b.fours || 0) * 2 + (b.sixes || 0) * 4;
          if (b.runs >= 50) pts += 15;
          if (b.runs >= 100) pts += 30;
          addMvp(b.id, b.name, batTeamName, pts);
          mvpMap[b.id].runs += b.runs;
        }
      });

      (st.bowlers || []).forEach(bo => {
        if (bo.legalBalls > 0 || bo.wickets > 0 || bo.wides > 0 || bo.noBalls > 0) {
          const rec = ensureBowler(bo.id, bo.name, bowlTeamName);
          rec.innings += 1;
          rec.legalBalls += bo.legalBalls;
          rec.runsConceded += bo.runsConceded;
          rec.wickets += bo.wickets;
          if (bo.wickets >= 5) rec.fiveW += 1;
          if (bo.wickets > rec.bestW || (bo.wickets === rec.bestW && bo.runsConceded < rec.bestR)) {
            rec.bestW = bo.wickets;
            rec.bestR = bo.runsConceded;
          }

          let pts = bo.wickets * 25 + (bo.maidens || 0) * 10;
          if (bo.wickets >= 5) pts += 25;
          addMvp(bo.id, bo.name, bowlTeamName, pts);
          mvpMap[bo.id].wickets += bo.wickets;
        }
      });
    });
  });

  const orangeList = Object.values(batters).map(b => ({
    ...b,
    sr: b.balls > 0 ? ((b.runs / b.balls) * 100).toFixed(1) : '0.0'
  })).sort((a, b) => (b.runs - a.runs) || (Number(b.sr) - Number(a.sr)));

  const purpleList = Object.values(bowlers).map(bo => ({
    ...bo,
    overs: `${Math.floor(bo.legalBalls / 6)}.${bo.legalBalls % 6}`,
    econ: bo.legalBalls > 0 ? ((bo.runsConceded / bo.legalBalls) * 6).toFixed(2) : '0.00',
    bestFig: bo.bestR < 999 ? `${bo.bestW}/${bo.bestR}` : `${bo.bestW}/0`
  })).sort((a, b) => (b.wickets - a.wickets) || (Number(a.econ) - Number(b.econ)));

  const mvpList = Object.values(mvpMap).sort((a, b) => b.pts - a.pts);

  return { orangeList, purpleList, mvpList };
}

function buildTournamentLeaderboardHTML(subTab, standings, caps, fixtures, teamsMap, allMatches, isOrganizer = false, tournId = '') {
  if (subTab === 'orange') {
    const leader = caps.orangeList[0];
    return `
      ${leader ? `
        <div class="cap-spotlight-card orange-cap">
          <div>
            <div style="font-size:10px; font-weight:900; letter-spacing:0.8px; color:#fb923c;">🧢 ORANGE CAP HOLDER</div>
            <div style="font-size:16px; font-weight:950; margin:2px 0;">${escapeHTML(leader.name)}</div>
            <div class="muted" style="font-size:11.5px;">${escapeHTML(leader.teamName)} · HS ${leader.highScore} · SR ${leader.sr}</div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:24px; font-weight:950; color:#f97316;">${leader.runs}</div>
            <div class="muted" style="font-size:10.5px; font-weight:800;">RUNS (${leader.innings} inn)</div>
          </div>
        </div>
      ` : ''}
      <div class="card" style="padding:10px; overflow-x:auto;">
        <table class="crease-table">
          <thead><tr><th>#</th><th>Batter</th><th>Inn</th><th>Runs</th><th>4s/6s</th><th>SR</th></tr></thead>
          <tbody>
            ${caps.orangeList.length ? caps.orangeList.map((b, i) => `
              <tr>
                <td><strong>${i === 0 ? '🧢' : i + 1}</strong></td>
                <td><strong>${escapeHTML(b.name)}</strong><br><small class="muted">${escapeHTML(b.teamName)}</small></td>
                <td>${b.innings}</td>
                <td><strong style="color:#f97316;">${b.runs}</strong></td>
                <td>${b.fours}/${b.sixes}</td>
                <td>${b.sr}</td>
              </tr>
            `).join('') : '<tr><td colspan="6" class="muted" style="text-align:center; padding:14px;">Score a tournament match to populate Orange Cap stats.</td></tr>'}
          </tbody>
        </table>
      </div>
    `;
  }

  if (subTab === 'purple') {
    const leader = caps.purpleList[0];
    return `
      ${leader ? `
        <div class="cap-spotlight-card purple-cap">
          <div>
            <div style="font-size:10px; font-weight:900; letter-spacing:0.8px; color:#c084fc;">🟣 PURPLE CAP HOLDER</div>
            <div style="font-size:16px; font-weight:950; margin:2px 0;">${escapeHTML(leader.name)}</div>
            <div class="muted" style="font-size:11.5px;">${escapeHTML(leader.teamName)} · Best ${leader.bestFig} · Econ ${leader.econ}</div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:24px; font-weight:950; color:#a855f7;">${leader.wickets}</div>
            <div class="muted" style="font-size:10.5px; font-weight:800;">WKTS (${leader.overs} ov)</div>
          </div>
        </div>
      ` : ''}
      <div class="card" style="padding:10px; overflow-x:auto;">
        <table class="crease-table">
          <thead><tr><th>#</th><th>Bowler</th><th>Ov</th><th>Wkts</th><th>Best</th><th>Econ</th></tr></thead>
          <tbody>
            ${caps.purpleList.length ? caps.purpleList.map((bo, i) => `
              <tr>
                <td><strong>${i === 0 ? '🟣' : i + 1}</strong></td>
                <td><strong>${escapeHTML(bo.name)}</strong><br><small class="muted">${escapeHTML(bo.teamName)}</small></td>
                <td>${bo.overs}</td>
                <td><strong style="color:#a855f7;">${bo.wickets}</strong></td>
                <td>${bo.bestFig}</td>
                <td>${bo.econ}</td>
              </tr>
            `).join('') : '<tr><td colspan="6" class="muted" style="text-align:center; padding:14px;">Score a tournament match to populate Purple Cap stats.</td></tr>'}
          </tbody>
        </table>
      </div>
    `;
  }

  if (subTab === 'mvp') {
    const leader = caps.mvpList[0];
    return `
      ${leader ? `
        <div class="cap-spotlight-card mvp-cap">
          <div>
            <div style="font-size:10px; font-weight:900; letter-spacing:0.8px; color:var(--primary);">🌟 TOURNAMENT MVP LEADER</div>
            <div style="font-size:16px; font-weight:950; margin:2px 0;">${escapeHTML(leader.name)}</div>
            <div class="muted" style="font-size:11.5px;">${escapeHTML(leader.teamName)} · ${leader.runs} Runs &amp; ${leader.wickets} Wickets</div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:24px; font-weight:950; color:var(--primary);">${leader.pts}</div>
            <div class="muted" style="font-size:10.5px; font-weight:800;">IMPACT PTS</div>
          </div>
        </div>
      ` : ''}
      <div class="card" style="padding:10px; overflow-x:auto;">
        <table class="crease-table">
          <thead><tr><th>#</th><th>Player</th><th>Runs</th><th>Wkts</th><th>MVP Pts</th></tr></thead>
          <tbody>
            ${caps.mvpList.length ? caps.mvpList.map((p, i) => `
              <tr>
                <td><strong>${i === 0 ? '🌟' : i + 1}</strong></td>
                <td><strong>${escapeHTML(p.name)}</strong><br><small class="muted">${escapeHTML(p.teamName)}</small></td>
                <td>${p.runs}</td>
                <td>${p.wickets}</td>
                <td><strong style="color:var(--primary);">${p.pts}</strong></td>
              </tr>
            `).join('') : '<tr><td colspan="5" class="muted" style="text-align:center; padding:14px;">No tournament impact points recorded yet.</td></tr>'}
          </tbody>
        </table>
      </div>
    `;
  }

  // Default: Standings & Fixtures
  const hasSemiFinals = fixtures.some(f => (f.roundLabel || '').toLowerCase().includes('semi-final'));
  const hasGrandFinal = fixtures.some(f => (f.roundLabel || '').toLowerCase().includes('grand final'));
  const completedSemis = fixtures.filter(f => (f.roundLabel || '').toLowerCase().includes('semi-final') && f.status === 'Completed');

  let knockoutBarHTML = '';
  if (isOrganizer) {
    if (!hasSemiFinals && standings.length >= 4) {
      knockoutBarHTML = `
        <div class="knockout-action-bar">
          <div style="font-size:11.5px; font-weight:800;">⚡ League Stage Ready for Playoffs</div>
          <button type="button" class="btn btn-primary" style="padding:6px 11px; font-size:11px;" onclick="seedTop4Knockouts('${tournId}')">Seed Top 4 to Semi-Finals</button>
        </div>`;
    } else if (hasSemiFinals && !hasGrandFinal && completedSemis.length >= 2) {
      knockoutBarHTML = `
        <div class="knockout-action-bar">
          <div style="font-size:11.5px; font-weight:800;">👑 Both Semi-Finals Complete!</div>
          <button type="button" class="btn btn-primary" style="padding:6px 11px; font-size:11px;" onclick="seedTournamentGrandFinal('${tournId}')">Generate Grand Final</button>
        </div>`;
    }
  }

  return `
    ${knockoutBarHTML}
    <div class="section-title-row">
      <h2>📊 Points Table &amp; NRR</h2>
      <span class="muted" style="font-size:11px;">Win = 2 pts · Tie = 1 pt</span>
    </div>
    <div class="card" style="padding:10px; margin-bottom:16px; overflow-x:auto;">
      <table class="crease-table">
        <thead>
          <tr><th>#</th><th>Team</th><th>M</th><th>W</th><th>L</th><th>NRR</th><th>PTS</th></tr>
        </thead>
        <tbody>
          ${standings.map((row, idx) => `
            <tr>
              <td><strong>${idx + 1}</strong></td>
              <td><strong>${escapeHTML(row.teamName)}</strong>${idx < 4 && standings.length >= 4 ? ' <small style="color:var(--primary); font-weight:900;">Q</small>' : ''}</td>
              <td>${row.played}</td>
              <td>${row.won}</td>
              <td>${row.lost}</td>
              <td style="font-weight:700; color:${row.nrr >= 0 ? 'var(--primary)' : 'var(--danger)'};">${row.nrr >= 0 ? '+' : ''}${row.nrr.toFixed(3)}</td>
              <td><strong style="color:var(--primary); font-size:13px;">${row.points}</strong></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    <div class="section-title-row">
      <h2>🗓️ Match Schedule (${fixtures.length})</h2>
      ${isOrganizer ? `<button type="button" class="link-btn" onclick="openAddFixtureModal('${tournId}')">＋ Add Fixture</button>` : ''}
    </div>

    <div>
      ${fixtures.map(fx => {
        const nameA = teamsMap[fx.teamAId] || 'Team A';
        const nameB = teamsMap[fx.teamBId] || 'Team B';
        const linkedMatch = fx.matchId ? allMatches.find(m => m.id === fx.matchId) : null;
        const effectiveStatus = linkedMatch ? linkedMatch.status : fx.status;
        const statusCls = effectiveStatus === 'Completed' ? 'completed' : effectiveStatus === 'Live' ? 'live' : 'scheduled';

        return `
          <div class="tourn-fixture-card">
            <div class="tourn-fixture-top">
              <span>MATCH #${fx.matchNumber} · ${escapeHTML(fx.roundLabel || 'League')}</span>
              <span class="tourn-status-badge ${statusCls}">${escapeHTML(effectiveStatus)}</span>
            </div>
            <div class="tourn-fixture-teams">
              <span>${escapeHTML(nameA)}</span>
              <span class="tourn-vs-pill">VS</span>
              <span>${escapeHTML(nameB)}</span>
            </div>
            ${(linkedMatch?.result || fx.result) ? `
              <div style="margin-top:6px; font-size:11.5px; font-weight:800; color:var(--primary);">
                🏆 ${escapeHTML(linkedMatch?.result || fx.result)}
              </div>
            ` : ''}
            <div style="margin-top:10px; display:flex; justify-content:flex-end; gap:8px;">
              ${isOrganizer ? (
                effectiveStatus === 'Completed' && linkedMatch
                  ? `<button type="button" class="btn btn-secondary" style="padding:6px 11px; font-size:11px;" onclick="viewMatchScorecardModal('${linkedMatch.id}')">📋 Scorecard</button>`
                  : `<button type="button" class="btn btn-primary" style="padding:6px 12px; font-size:11.5px;" onclick="launchTournamentFixture('${tournId}', '${fx.id}')">${effectiveStatus === 'Live' ? '⚡ Resume Match' : '⚡ Score Match'}</button>`
              ) : (
                fx.matchId
                  ? `<button type="button" class="btn btn-primary" style="padding:5px 11px; font-size:11px;" onclick="openSpectatorLiveMatch('${fx.matchId}')">📺 Watch Scoreboard</button>`
                  : ''
              )}
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

async function seedTop4Knockouts(tournId) {
  const [tournaments, teams, allMatches] = await Promise.all([
    getAllTournaments(),
    dbGetAll('teams'),
    dbGetAll('matches')
  ]);
  const tIdx = tournaments.findIndex(t => t.id === tournId);
  if (tIdx === -1) return;
  const tourn = tournaments[tIdx];
  const teamsMap = {};
  teams.forEach(t => { teamsMap[t.id] = t.name; });

  const standings = computeTournamentStandings(tourn, teamsMap, allMatches);
  if (standings.length < 4) {
    alert('At least 4 teams are required to seed Top-4 Semi-Finals.');
    return;
  }

  const [r1, r2, r3, r4] = standings;
  if (!confirm(`Seed Top 4 Knockouts?

• Semi-Final 1: #1 ${r1.teamName} vs #4 ${r4.teamName}
• Semi-Final 2: #2 ${r2.teamName} vs #3 ${r3.teamName}`)) return;

  let nextNum = (tourn.fixtures?.length || 0) + 1;
  tourn.fixtures.push(
    {
      id: generateId(),
      matchNumber: nextNum++,
      roundLabel: 'Semi-Final 1 (#1 vs #4)',
      teamAId: r1.teamId,
      teamBId: r4.teamId,
      status: 'Scheduled',
      matchId: null,
      result: '',
      winnerTeamId: null
    },
    {
      id: generateId(),
      matchNumber: nextNum++,
      roundLabel: 'Semi-Final 2 (#2 vs #3)',
      teamAId: r2.teamId,
      teamBId: r3.teamId,
      status: 'Scheduled',
      matchId: null,
      result: '',
      winnerTeamId: null
    }
  );

  await saveAllTournaments(tournaments);
  showToast('Semi-Finals seeded from Top 4 Standings!');
  renderTournamentsView();
}

async function seedTournamentGrandFinal(tournId) {
  const tournaments = await getAllTournaments();
  const tIdx = tournaments.findIndex(t => t.id === tournId);
  if (tIdx === -1) return;
  const tourn = tournaments[tIdx];

  const completedSemis = (tourn.fixtures || []).filter(f =>
    (f.roundLabel || '').toLowerCase().includes('semi-final') && f.status === 'Completed' && f.winnerTeamId
  );
  if (completedSemis.length < 2) {
    alert('Both Semi-Finals must have a completed winner before generating the Grand Final.');
    return;
  }

  const finalistA = completedSemis[0].winnerTeamId;
  const finalistB = completedSemis[1].winnerTeamId;
  tourn.fixtures.push({
    id: generateId(),
    matchNumber: (tourn.fixtures?.length || 0) + 1,
    roundLabel: '👑 Grand Final',
    teamAId: finalistA,
    teamBId: finalistB,
    status: 'Scheduled',
    matchId: null,
    result: '',
    winnerTeamId: null
  });

  await saveAllTournaments(tournaments);
  showToast('👑 Grand Final scheduled!');
  renderTournamentsView();
}

async function renderTournamentsView() {
  const container = document.getElementById('tournamentsContainer');
  if (!container) return;

  const [tournaments, teams, allMatches] = await Promise.all([
    getAllTournaments(),
    dbGetAll('teams'),
    dbGetAll('matches')
  ]);

  const teamsMap = {};
  teams.forEach(t => { teamsMap[t.id] = t.name; });

  if (!tournaments.length) {
    container.innerHTML = `
      <div class="empty-state" style="padding:26px 16px;">
        <div style="font-size:34px; margin-bottom:8px;">🏆</div>
        <h3 style="margin-bottom:6px;">No Tournaments Created Yet</h3>
        <p class="muted" style="margin-bottom:14px;">Create a league or knockout cup, add competing teams, auto-generate match schedules, and track live points, NRR &amp; Orange/Purple Caps.</p>
        <button class="btn btn-primary" onclick="openCreateTournamentModal()">＋ Create Your First Tournament</button>
      </div>
    `;
    return;
  }

  if (!selectedTournamentId || !tournaments.some(t => t.id === selectedTournamentId)) {
    selectedTournamentId = tournaments[0].id;
  }

  const activeTourn = tournaments.find(t => t.id === selectedTournamentId) || tournaments[0];
  const standings = computeTournamentStandings(activeTourn, teamsMap, allMatches);
  const caps = computeTournamentPlayerCaps(activeTourn, teamsMap, allMatches);
  const completedCount = (activeTourn.fixtures || []).filter(f => f.status === 'Completed').length;
  const totalFixtures = (activeTourn.fixtures || []).length;

  container.innerHTML = `
    <!-- Tournament Switcher Pills -->
    <div class="tourn-selector-strip">
      ${tournaments.map(t => `
        <button type="button" class="tourn-pill-tab ${t.id === activeTourn.id ? 'active' : ''}" onclick="selectActiveTournament('${t.id}')">
          🏆 ${escapeHTML(t.name)}
        </button>
      `).join('')}
    </div>

    <!-- Active Tournament Hero Card -->
    <div class="tourn-hero-card">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px;">
        <div>
          <div class="eyebrow" style="color:var(--primary); margin-bottom:3px;">${escapeHTML(activeTourn.format || 'T20')} · ${escapeHTML(activeTourn.stageType === 'knockout' ? 'KNOCKOUT CUP' : 'ROUND-ROBIN LEAGUE')}</div>
          <h2 style="font-size:19px; font-weight:950; margin:0 0 4px;">${escapeHTML(activeTourn.name)}</h2>
          <p class="muted" style="font-size:12px; margin:0;">${(activeTourn.teamIds || []).length} Teams · ${completedCount}/${totalFixtures} Matches Played · ${activeTourn.overs || 20} Overs/side</p>
        </div>
        <div style="display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end;">
          <button type="button" class="btn btn-primary" style="padding:6px 10px; font-size:11px;" onclick="sharePublicTournamentLink('${activeTourn.id}')">📤 Share Hub</button>
          <button type="button" class="btn btn-secondary" style="padding:6px 10px; font-size:11px;" onclick="openAddTeamToTournamentModal('${activeTourn.id}')">＋ Team</button>
          <button type="button" class="btn btn-secondary" style="padding:6px 10px; font-size:11px; color:var(--danger);" onclick="deleteTournamentPrompt('${activeTourn.id}')">🗑️</button>
        </div>
      </div>

      <div class="tourn-team-chip-row">
        ${(activeTourn.teamIds || []).map(tid => `
          <span class="tourn-team-chip">🛡️ ${escapeHTML(teamsMap[tid] || 'Team')}</span>
        `).join('')}
      </div>
    </div>

    <!-- Sub-Tabs: Standings / Orange Cap / Purple Cap / MVP -->
    <div class="tourn-subtabs-grid">
      <button type="button" class="tourn-subtab-btn ${activeTournamentSubTab === 'standings' ? 'active' : ''}" onclick="switchTournamentSubTab('standings')">📊 Standings</button>
      <button type="button" class="tourn-subtab-btn ${activeTournamentSubTab === 'orange' ? 'active' : ''}" onclick="switchTournamentSubTab('orange')">🧢 Orange Cap</button>
      <button type="button" class="tourn-subtab-btn ${activeTournamentSubTab === 'purple' ? 'active' : ''}" onclick="switchTournamentSubTab('purple')">🟣 Purple Cap</button>
      <button type="button" class="tourn-subtab-btn ${activeTournamentSubTab === 'mvp' ? 'active' : ''}" onclick="switchTournamentSubTab('mvp')">🌟 MVP</button>
    </div>

    ${buildTournamentLeaderboardHTML(activeTournamentSubTab, standings, caps, activeTourn.fixtures || [], teamsMap, allMatches, true, activeTourn.id)}
  `;
}

function selectActiveTournament(tournId) {
  selectedTournamentId = tournId;
  renderTournamentsView();
}

async function openCreateTournamentModal() {
  const teams = await dbGetAll('teams');
  const html = `
    <form id="createTournamentForm">
      <div class="form-group" style="margin-bottom:11px;">
        <label>Tournament Name *</label>
        <input type="text" id="tfName" required placeholder="e.g. Premier Cricket Cup 2026">
      </div>

      <div class="field-grid" style="margin-bottom:11px;">
        <div class="form-group">
          <label>Format</label>
          <select id="tfFormat">
            <option value="T20">T20 (20 Overs)</option>
            <option value="T10">T10 (10 Overs)</option>
            <option value="ODI">ODI (50 Overs)</option>
            <option value="Custom">Custom Overs</option>
          </select>
        </div>
        <div class="form-group">
          <label>Overs Per Side</label>
          <input type="number" id="tfOvers" min="1" max="50" value="20">
        </div>
      </div>

      <div class="form-group" style="margin-bottom:11px;">
        <label>Schedule Structure</label>
        <select id="tfStageType">
          <option value="round_robin">Single Round-Robin League (Every team plays once)</option>
          <option value="double_round_robin">Double Round-Robin League (Home &amp; Away)</option>
          <option value="knockout">Knockout Bracket</option>
        </select>
      </div>

      <div class="form-group" style="margin-bottom:10px;">
        <label>Select Competing Teams (Minimum 2) *</label>
        <div id="tfTeamSelectGrid" class="tourn-team-select-grid">
          ${teams.map(t => `
            <label class="tourn-team-check-item">
              <input type="checkbox" name="tfTeamIds" value="${t.id}" checked>
              <span>${escapeHTML(t.name)}</span>
            </label>
          `).join('')}
        </div>
      </div>

      <div class="form-group" style="margin-bottom:4px;">
        <label>Quick-Add New Teams (Comma-separated, optional)</label>
        <input type="text" id="tfNewTeamsInput" placeholder="e.g. Royal Strikers, Metro Kings">
      </div>
    </form>
  `;

  openModal('Create New Tournament', html, async () => {
    const name = (document.getElementById('tfName')?.value || '').trim();
    if (!name) {
      showToast('Please enter a tournament name.');
      return false;
    }

    const format = document.getElementById('tfFormat')?.value || 'T20';
    const overs = Math.max(1, parseInt(document.getElementById('tfOvers')?.value || '20', 10));
    const stageType = document.getElementById('tfStageType')?.value || 'round_robin';

    const selectedIds = Array.from(document.querySelectorAll('input[name="tfTeamIds"]:checked')).map(cb => cb.value);

    // Create any quick-added teams directly in IndexedDB `teams` store
    const newTeamRaw = (document.getElementById('tfNewTeamsInput')?.value || '').trim();
    if (newTeamRaw) {
      const names = newTeamRaw.split(',').map(s => s.trim()).filter(Boolean);
      for (const tName of names) {
        const newId = generateId();
        await dbPut('teams', { id: newId, name: tName, created: Date.now() });
        selectedIds.push(newId);
      }
    }

    const uniqueTeamIds = Array.from(new Set(selectedIds));
    if (uniqueTeamIds.length < 2) {
      alert('Please select or add at least 2 competing teams.');
      return false;
    }

    const fixtures = stageType === 'knockout'
      ? generateKnockoutFixtures(uniqueTeamIds)
      : generateRoundRobinFixtures(uniqueTeamIds, stageType === 'double_round_robin');

    const newTourn = {
      id: generateId(),
      name,
      format,
      overs,
      stageType,
      teamIds: uniqueTeamIds,
      fixtures,
      created: Date.now()
    };

    const existing = await getAllTournaments();
    existing.unshift(newTourn);
    await saveAllTournaments(existing);

    selectedTournamentId = newTourn.id;
    showToast(`Tournament "${name}" created with ${fixtures.length} scheduled matches!`);
    renderTournamentsView();
    renderDashboard();
    return true;
  });
}

async function openAddTeamToTournamentModal(tournId) {
  const [tournaments, allTeams] = await Promise.all([getAllTournaments(), dbGetAll('teams')]);
  const tourn = tournaments.find(t => t.id === tournId);
  if (!tourn) return;

  const availableTeams = allTeams.filter(t => !(tourn.teamIds || []).includes(t.id));

  const html = `
    <div>
      ${availableTeams.length ? `
        <div class="form-group" style="margin-bottom:12px;">
          <label>Select Existing Team</label>
          <select id="attExistingTeam">
            <option value="">-- Choose Team --</option>
            ${availableTeams.map(t => `<option value="${t.id}">${escapeHTML(t.name)}</option>`).join('')}
          </select>
        </div>
      ` : ''}
      <div class="form-group" style="margin-bottom:10px;">
        <label>Or Create &amp; Add New Team</label>
        <input type="text" id="attNewTeamName" placeholder="e.g. Thunderbolts XI">
      </div>
      <label class="checklist-item" style="cursor:pointer;">
        <input type="checkbox" id="attAutoSchedule" checked style="width:16px; height:16px; accent-color:var(--primary);">
        <span>Auto-generate fixtures against existing tournament teams</span>
      </label>
    </div>
  `;

  openModal(`Add Team to ${tourn.name}`, html, async () => {
    let chosenId = document.getElementById('attExistingTeam')?.value || '';
    const newName = (document.getElementById('attNewTeamName')?.value || '').trim();
    const autoSched = !!document.getElementById('attAutoSchedule')?.checked;

    if (newName) {
      chosenId = generateId();
      await dbPut('teams', { id: chosenId, name: newName, created: Date.now() });
    }

    if (!chosenId) {
      showToast('Select an existing team or enter a new team name.');
      return false;
    }

    if (!tourn.teamIds.includes(chosenId)) {
      const prevTeams = [...tourn.teamIds];
      tourn.teamIds.push(chosenId);
      if (autoSched) {
        let nextNum = (tourn.fixtures?.length || 0) + 1;
        prevTeams.forEach(oppId => {
          tourn.fixtures.push({
            id: generateId(),
            matchNumber: nextNum++,
            roundLabel: tourn.stageType === 'knockout' ? 'Knockout Stage' : 'League Stage',
            teamAId: oppId,
            teamBId: chosenId,
            status: 'Scheduled',
            matchId: null,
            result: '',
            winnerTeamId: null
          });
        });
      }
      await saveAllTournaments(tournaments);
      showToast('Team added to tournament!');
      renderTournamentsView();
      renderDashboard();
    }
    return true;
  });
}

async function openAddFixtureModal(tournId) {
  const [tournaments, allTeams] = await Promise.all([getAllTournaments(), dbGetAll('teams')]);
  const tourn = tournaments.find(t => t.id === tournId);
  if (!tourn) return;
  const tTeams = allTeams.filter(t => (tourn.teamIds || []).includes(t.id));

  const html = `
    <div>
      <div class="form-group" style="margin-bottom:10px;">
        <label>Round / Stage Label</label>
        <input type="text" id="afRoundLabel" value="Playoff / Final">
      </div>
      <div class="field-grid">
        <div class="form-group">
          <label>Team A</label>
          <select id="afTeamA">
            ${tTeams.map(t => `<option value="${t.id}">${escapeHTML(t.name)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Team B</label>
          <select id="afTeamB">
            ${tTeams.map((t, idx) => `<option value="${t.id}" ${idx === 1 ? 'selected' : ''}>${escapeHTML(t.name)}</option>`).join('')}
          </select>
        </div>
      </div>
    </div>
  `;

  openModal('Add Custom Fixture', html, async () => {
    const teamAId = document.getElementById('afTeamA')?.value;
    const teamBId = document.getElementById('afTeamB')?.value;
    const roundLabel = (document.getElementById('afRoundLabel')?.value || 'League Stage').trim();
    if (!teamAId || !teamBId || teamAId === teamBId) {
      alert('Please choose two different teams.');
      return false;
    }
    tourn.fixtures.push({
      id: generateId(),
      matchNumber: (tourn.fixtures?.length || 0) + 1,
      roundLabel,
      teamAId,
      teamBId,
      status: 'Scheduled',
      matchId: null,
      result: '',
      winnerTeamId: null
    });
    await saveAllTournaments(tournaments);
    showToast('Fixture added to schedule!');
    renderTournamentsView();
    return true;
  });
}

async function launchTournamentFixture(tournId, fixtureId) {
  const [tournaments, allTeams, allPlayers, allMatches] = await Promise.all([
    getAllTournaments(),
    dbGetAll('teams'),
    dbGetAll('players'),
    dbGetAll('matches')
  ]);
  const tourn = tournaments.find(t => t.id === tournId);
  if (!tourn) return;
  const fx = (tourn.fixtures || []).find(f => f.id === fixtureId);
  if (!fx) return;

  // Resume if match already exists
  if (fx.matchId) {
    const existingMatch = allMatches.find(m => m.id === fx.matchId);
    if (existingMatch) {
      activeMatch = existingMatch;
      navigate('live-scorer');
      return;
    }
  }

  const teamA = allTeams.find(t => t.id === fx.teamAId);
  const teamB = allTeams.find(t => t.id === fx.teamBId);
  const squadA = allPlayers.filter(p => p.teamId === fx.teamAId);
  const squadB = allPlayers.filter(p => p.teamId === fx.teamBId);

  const html = `
    <div>
      <div class="extra-modal-banner" style="margin-bottom:12px;">
        <span>🏆 ${escapeHTML(tourn.name)} · Match #${fx.matchNumber}</span>
        <span class="extra-total-pill">${tourn.overs || 20} Overs</span>
      </div>
      <div class="field-grid" style="margin-bottom:10px;">
        <div class="form-group">
          <label>Toss Won By</label>
          <select id="ltfTossWinner">
            <option value="${fx.teamAId}">${escapeHTML(teamA?.name || 'Team A')}</option>
            <option value="${fx.teamBId}">${escapeHTML(teamB?.name || 'Team B')}</option>
          </select>
        </div>
        <div class="form-group">
          <label>Decision</label>
          <select id="ltfTossDecision">
            <option value="bat">Bat First</option>
            <option value="bowl">Bowl First</option>
          </select>
        </div>
      </div>
      <p class="muted" style="font-size:11.5px;">Tip: You can assign or type batters &amp; bowlers directly on the Scorer screen if squads aren't pre-filled.</p>
    </div>
  `;

  openModal(`Start ${teamA?.name || 'Team A'} vs ${teamB?.name || 'Team B'}`, html, async () => {
    const tossWinner = document.getElementById('ltfTossWinner')?.value || fx.teamAId;
    const tossDecision = document.getElementById('ltfTossDecision')?.value || 'bat';
    const battingTeamId = (tossWinner === fx.teamAId && tossDecision === 'bat') || (tossWinner === fx.teamBId && tossDecision === 'bowl')
      ? fx.teamAId
      : fx.teamBId;
    const bowlingTeamId = battingTeamId === fx.teamAId ? fx.teamBId : fx.teamAId;

    const batSquad = battingTeamId === fx.teamAId ? squadA : squadB;
    const bowlSquad = battingTeamId === fx.teamAId ? squadB : squadA;

    const newMatch = {
      id: generateId(),
      title: `${tourn.name} - Match #${fx.matchNumber} (${fx.roundLabel || 'League'})`,
      tournament: tourn.name,
      tournamentId: tourn.id,
      tournamentFixtureId: fx.id,
      format: tourn.format || 'T20',
      overs: tourn.overs || 20,
      a: fx.teamAId,
      b: fx.teamBId,
      tossWinner,
      tossDecision,
      status: 'Live',
      target: null,
      innings: [
        {
          inningsNum: 1,
          batting: battingTeamId,
          bowling: bowlingTeamId,
          squad: batSquad,
          bowlingSquad: bowlSquad,
          strikerId: batSquad[0]?.id || null,
          nonStrikerId: batSquad[1]?.id || null,
          bowlerId: bowlSquad[0]?.id || null,
          balls: [],
          base: { runs: 0, wickets: 0, legal: 0, ballCount: 0 }
        }
      ],
      created: Date.now(),
      updated: Date.now()
    };

    await dbPut('matches', newMatch);
    fx.status = 'Live';
    fx.matchId = newMatch.id;
    await saveAllTournaments(tournaments);

    activeMatch = newMatch;
    showToast('Tournament fixture started!');
    navigate('live-scorer');
    return true;
  });
}

async function deleteTournamentPrompt(tournId) {
  if (!confirm('Delete this tournament schedule and points table? Existing completed match scorecards in Match History will remain safe.')) return;
  const tournaments = await getAllTournaments();
  const filtered = tournaments.filter(t => t.id !== tournId);
  await saveAllTournaments(filtered);
  selectedTournamentId = filtered[0]?.id || null;
  showToast('Tournament removed');
  renderTournamentsView();
  renderDashboard();
}


// ==========================================
// SUPABASE CLOUD AUTH, PROFILE SETUP & PUBLIC LIVE SYNC
// ==========================================
const SUPABASE_URL = 'https://fdsvwotdhmvudkwuuceb.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_QbRKDXz3ymBWCyRlUBEljA_ihM-GYbL';

let sbClient = null;
let currentCloudUser = null;
let currentCloudProfile = null;
let cloudSyncDebounceTimer = null;
let spectatorWatchMatchId = null;
let spectatorMatchData = null;
let spectatorRealtimeChannel = null;
let publicFeedMatchesCache = [];

function initSupabaseCloud() {
  try {
    if (!window.supabase || !window.supabase.createClient) {
      console.warn('[Cloud] Supabase SDK unavailable (offline mode active).');
      updateCloudAuthUI();
      return;
    }
    sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

    sbClient.auth.getSession().then(async ({ data }) => {
      currentCloudUser = data?.session?.user || null;
      if (currentCloudUser) {
        await loadOrPromptCloudProfile();
        syncAllLocalDataToCloud(true);
      }
      updateCloudAuthUI();
      refreshPublicLiveCenter();
    });

    sbClient.auth.onAuthStateChange(async (event, session) => {
      currentCloudUser = session?.user || null;
      if (currentCloudUser) {
        await loadOrPromptCloudProfile();
        if (event === 'SIGNED_IN') {
          await syncAllLocalDataToCloud(false);
        }
      } else {
        currentCloudProfile = null;
      }
      updateCloudAuthUI();
      refreshPublicLiveCenter();
    });

    window.addEventListener('online', () => {
      if (currentCloudUser) {
        syncAllLocalDataToCloud(true);
      }
      refreshPublicLiveCenter();
    });
  } catch (err) {
    console.warn('[Cloud] Init error:', err);
  }
}

async function loadOrPromptCloudProfile() {
  if (!sbClient || !currentCloudUser) return;
  try {
    const { data, error } = await sbClient
      .from('profiles')
      .select('*')
      .eq('id', currentCloudUser.id)
      .maybeSingle();

    if (data) {
      currentCloudProfile = data;
      updateCloudAuthUI();
    } else if (!error) {
      // First-time user setup modal
      openProfileSetupModal(true);
    }
  } catch (e) {
    console.warn('[Cloud] Profile fetch skipped:', e);
  }
}

function updateCloudAuthUI() {
  const pill = document.getElementById('cloudAuthHeaderBtn');
  if (pill) {
    if (currentCloudUser) {
      const name = currentCloudProfile?.display_name || currentCloudUser.user_metadata?.full_name || currentCloudUser.email?.split('@')[0] || 'Synced';
      pill.textContent = `☁️ ${name}`;
      pill.classList.add('signed-in');
    } else {
      pill.textContent = '☁️ Sign In';
      pill.classList.remove('signed-in');
    }
  }

  getCloudSyncQueue().then(q => updateSyncStatusPill(q.length)).catch(() => updateSyncStatusPill(0));
  const card = document.getElementById('settingsCloudAccountCard');
  if (card) {
    if (currentCloudUser) {
      const dispName = currentCloudProfile?.display_name || currentCloudUser.email || 'Authenticated User';
      const role = currentCloudProfile?.role || 'Scorer';
      const city = currentCloudProfile?.city || 'Not set';
      card.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px; margin-bottom:10px;">
          <div>
            <div style="font-size:14px; font-weight:900; color:var(--primary);">✅ ${escapeHTML(dispName)}</div>
            <div class="muted" style="font-size:11.5px;">${escapeHTML(currentCloudUser.email || '')}</div>
            <div style="margin-top:4px; font-size:11.5px;">Role: <strong>${escapeHTML(role)}</strong> · City/Club: <strong>${escapeHTML(city)}</strong></div>
          </div>
          <button type="button" class="btn btn-secondary" style="padding:6px 10px; font-size:11px;" onclick="openProfileSetupModal(false)">Edit Profile</button>
        </div>
        <div style="display:flex; flex-wrap:wrap; gap:8px;">
          <button type="button" class="btn btn-primary" style="flex:1; font-size:12px;" onclick="syncAllLocalDataToCloud(false)">🔄 Sync Now</button>
          <button type="button" class="btn btn-secondary" style="font-size:12px; color:var(--danger);" onclick="signOutCloudUser()">Sign Out</button>
        </div>
      `;
    } else {
      card.innerHTML = `
        <div style="margin-bottom:10px;">
          <strong style="font-size:13.5px;">Back Up &amp; Broadcast Your Matches</strong>
          <p class="muted" style="font-size:12px; margin-top:3px;">Guest mode works 100% offline. Sign in to sync teams, tournaments &amp; live scoreboards to the Public Live Match Center so anyone can watch.</p>
        </div>
        <button type="button" class="btn btn-primary" style="width:100%;" onclick="openCloudAuthModal()">☁️ Sign In / Create Profile</button>
      `;
    }
  }
}

function handleCloudAuthHeaderClick() {
  if (currentCloudUser) {
    navigate('settings');
  } else {
    openCloudAuthModal();
  }
}

let currentAuthTabMode = 'signin';

function openCloudAuthModal() {
  currentAuthTabMode = 'signin';
  const html = `
    <div>
      <button type="button" class="google-oauth-btn" onclick="signInWithGoogleCloud()">
        <span style="font-size:16px;">G</span>
        <span>Continue with Google (1-Tap)</span>
      </button>

      <div style="text-align:center; font-size:11px; color:var(--text-muted); margin-bottom:10px;">— OR USE EMAIL &amp; PASSWORD —</div>

      <div class="auth-mode-tabs">
        <button type="button" class="auth-tab-btn active" id="authTabSignIn" onclick="switchCloudAuthTab('signin')">Sign In</button>
        <button type="button" class="auth-tab-btn" id="authTabSignUp" onclick="switchCloudAuthTab('signup')">Create Account</button>
      </div>

      <div class="form-group" style="margin-bottom:10px;">
        <label>Email Address *</label>
        <input type="email" id="cloudAuthEmail" placeholder="scorer@example.com" required>
      </div>

      <div class="form-group" style="margin-bottom:10px;">
        <label>Password * <small class="muted">(Min 6 characters)</small></label>
        <input type="password" id="cloudAuthPassword" placeholder="••••••••" required>
      </div>

      <div style="display:flex; justify-content:flex-end;">
        <button type="button" class="link-btn" style="font-size:11.5px;" onclick="sendMagicLinkCloud()">✨ Send Passwordless Magic Link instead</button>
      </div>
    </div>
  `;

  openModal('Sign In to CricScorer Cloud', html, async () => {
    if (!sbClient) {
      showToast('Cloud service offline. Check internet connection.');
      return false;
    }
    const email = (document.getElementById('cloudAuthEmail')?.value || '').trim();
    const password = document.getElementById('cloudAuthPassword')?.value || '';
    if (!email || password.length < 6) {
      alert('Please enter a valid email and a password of at least 6 characters.');
      return false;
    }

    if (currentAuthTabMode === 'signup') {
      const { data, error } = await sbClient.auth.signUp({ email, password });
      if (error) {
        alert(error.message);
        return false;
      }
      if (data?.session) {
        showToast('Account created & signed in!');
        return true;
      } else {
        alert('Check your email inbox to confirm your account, then sign in!');
        return true;
      }
    } else {
      const { error } = await sbClient.auth.signInWithPassword({ email, password });
      if (error) {
        alert(error.message);
        return false;
      }
      showToast('Signed in to CricScorer Cloud!');
      return true;
    }
  });
}

function switchCloudAuthTab(mode) {
  currentAuthTabMode = mode;
  document.getElementById('authTabSignIn')?.classList.toggle('active', mode === 'signin');
  document.getElementById('authTabSignUp')?.classList.toggle('active', mode === 'signup');
}

async function signInWithGoogleCloud() {
  if (!sbClient) return;
  const redirectTo = window.location.origin + window.location.pathname;
  const { error } = await sbClient.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo }
  });
  if (error) alert('Google Sign-In error: ' + error.message);
}

async function sendMagicLinkCloud() {
  if (!sbClient) return;
  const email = (document.getElementById('cloudAuthEmail')?.value || '').trim();
  if (!email) {
    alert('Enter your email address first to receive a Magic Link.');
    return;
  }
  const redirectTo = window.location.origin + window.location.pathname;
  const { error } = await sbClient.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: redirectTo }
  });
  if (error) {
    alert(error.message);
  } else {
    alert(`Magic Login Link sent to ${email}! Open the link in your email to log in.`);
    closeModal();
  }
}

function openProfileSetupModal(isFirstTime = false) {
  if (!currentCloudUser) return;
  const defaultName = currentCloudProfile?.display_name || currentCloudUser.user_metadata?.full_name || currentCloudUser.email?.split('@')[0] || '';
  const defaultRole = currentCloudProfile?.role || 'Scorer';
  const defaultCity = currentCloudProfile?.city || '';

  const html = `
    <div>
      <p class="muted" style="font-size:12px; margin-bottom:12px;">
        ${isFirstTime ? 'Welcome! Set up your public scorer/player profile so teams and spectators recognize your matches.' : 'Update your public CricScorer profile details.'}
      </p>
      <div class="form-group" style="margin-bottom:10px;">
        <label>Display Name *</label>
        <input type="text" id="profDisplayName" value="${escapeHTML(defaultName)}" placeholder="e.g. Rohit Sharma" required>
      </div>
      <div class="form-group" style="margin-bottom:10px;">
        <label>Primary Role</label>
        <select id="profRole">
          <option value="Scorer" ${defaultRole === 'Scorer' ? 'selected' : ''}>Scorer / Organizer</option>
          <option value="All-Rounder" ${defaultRole === 'All-Rounder' ? 'selected' : ''}>All-Rounder</option>
          <option value="Batter" ${defaultRole === 'Batter' ? 'selected' : ''}>Batter</option>
          <option value="Bowler" ${defaultRole === 'Bowler' ? 'selected' : ''}>Bowler</option>
        </select>
      </div>
      <div class="form-group">
        <label>Home City / Cricket Club</label>
        <input type="text" id="profCity" value="${escapeHTML(defaultCity)}" placeholder="e.g. Pune / Striker CC">
      </div>
    </div>
  `;

  openModal(isFirstTime ? 'Complete Your Profile Setup' : 'Edit Public Profile', html, async () => {
    const displayName = (document.getElementById('profDisplayName')?.value || '').trim();
    if (!displayName) {
      showToast('Please enter a display name.');
      return false;
    }
    const role = document.getElementById('profRole')?.value || 'Scorer';
    const city = (document.getElementById('profCity')?.value || '').trim();

    const payload = {
      id: currentCloudUser.id,
      display_name: displayName,
      role,
      city,
      updated_at: new Date().toISOString()
    };

    const { error } = await sbClient.from('profiles').upsert(payload);
    if (error) {
      alert('Could not save profile: ' + error.message);
      return false;
    }
    currentCloudProfile = payload;
    updateCloudAuthUI();
    showToast('Profile saved to cloud!');
    return true;
  });
}

async function signOutCloudUser() {
  if (!sbClient) return;
  await sbClient.auth.signOut();
  currentCloudUser = null;
  currentCloudProfile = null;
  updateCloudAuthUI();
  showToast('Signed out (Local offline data preserved)');
}

// ==========================================
// OFFLINE-FIRST BACKGROUND SYNC TO SUPABASE
// ==========================================
function queueCloudMatchSync(matchObj) {
  if (!sbClient || !currentCloudUser || !navigator.onLine || !matchObj) return;
  clearTimeout(cloudSyncDebounceTimer);
  cloudSyncDebounceTimer = setTimeout(() => {
    pushSingleMatchToCloud(matchObj);
  }, 1200);
}

async function pushSingleMatchToCloud(matchObj) {
  if (!sbClient || !currentCloudUser || !navigator.onLine || !matchObj) return;
  try {
    const teams = await dbGetAll('teams');
    const teamAName = teams.find(t => t.id === matchObj.a)?.name || 'Team A';
    const teamBName = teams.find(t => t.id === matchObj.b)?.name || 'Team B';
    const enrichedMatch = {
      ...matchObj,
      teamAName,
      teamBName,
      ownerName: currentCloudProfile?.display_name || currentCloudUser.email?.split('@')[0] || 'Scorer'
    };

    await sbClient.from('matches').upsert({
      id: matchObj.id,
      owner_id: currentCloudUser.id,
      tournament_id: matchObj.tournamentId || null,
      title: matchObj.title || `${teamAName} vs ${teamBName}`,
      status: matchObj.status || 'Live',
      result: matchObj.result || '',
      match_json: enrichedMatch,
      updated_at: new Date().toISOString()
    });
  } catch (e) {
    console.warn('[Cloud] Match background sync deferred:', e);
  }
}

async function queueCloudTournamentsSync(tournsList) {
  if (!sbClient || !currentCloudUser || !navigator.onLine || !Array.isArray(tournsList)) return;
  try {
    const teams = await dbGetAll('teams');
    const teamsMap = {};
    teams.forEach(t => { teamsMap[t.id] = t.name; });

    for (const t of tournsList) {
      await sbClient.from('tournaments').upsert({
        id: t.id,
        owner_id: currentCloudUser.id,
        name: t.name,
        format: t.format || 'T20',
        overs: t.overs || 20,
        stage_type: t.stageType || 'round_robin',
        data_json: { ...t, teamsMap },
        updated_at: new Date().toISOString()
      });
    }
  } catch (e) {
    console.warn('[Cloud] Tournament sync deferred:', e);
  }
}

async function syncAllLocalDataToCloud(silent = false) {
  if (!sbClient || !currentCloudUser || !navigator.onLine || !db) return;
  try {
    const [teams, players, matches, tourns] = await Promise.all([
      dbGetAll('teams'),
      dbGetAll('players'),
      dbGetAll('matches'),
      getAllTournaments()
    ]);

    for (const tm of teams) {
      const roster = players.filter(p => p.teamId === tm.id);
      await sbClient.from('teams').upsert({
        id: tm.id,
        owner_id: currentCloudUser.id,
        name: tm.name,
        city: currentCloudProfile?.city || '',
        roster_json: roster,
        updated_at: new Date().toISOString()
      });
    }

    for (const m of matches) {
      await pushSingleMatchToCloud(m);
    }

    await queueCloudTournamentsSync(tourns);
    if (!silent) showToast('All local teams, matches & tournaments synced to cloud!');
    refreshPublicLiveCenter();
  } catch (e) {
    if (!silent) showToast('Sync will retry when connection stabilizes.');
  }
}

// ==========================================
// PUBLIC LIVE MATCH CENTER & REAL-TIME SPECTATOR VIEW
// ==========================================
async function refreshPublicLiveCenter(manual = false) {
  const container = document.getElementById('publicLiveCenterList');
  if (!container) return;

  if (!sbClient || !navigator.onLine) {
    container.innerHTML = `<div class="empty-state" style="padding:12px;">Connect to the internet to browse public live matches from all scorers.</div>`;
    return;
  }

  if (manual || !publicFeedMatchesCache.length) {
    container.innerHTML = `<div class="skeleton-shimmer-card"></div><div class="skeleton-shimmer-card"></div>`;
  }

  try {
    const { data: matches, error } = await sbClient
      .from('matches')
      .select('id, title, status, result, match_json, updated_at')
      .order('updated_at', { ascending: false })
      .limit(12);

    if (error) throw error;
    publicFeedMatchesCache = matches || [];

    if (!publicFeedMatchesCache.length) {
      container.innerHTML = `<div class="empty-state" style="padding:14px;">No public cloud matches yet. Sign in and score a match to broadcast live!</div>`;
      return;
    }

    container.innerHTML = publicFeedMatchesCache.map(row => {
      const m = row.match_json || {};
      const innList = m.innings || [];
      const curInn = innList[innList.length - 1];
      let scoreSummary = 'Match Scheduled';
      let batName = m.teamAName || 'Team A';
      let bowlName = m.teamBName || 'Team B';

      if (curInn) {
        const st = CricketEngine.calculateInnings(curInn, curInn.squad || [], curInn.bowlingSquad || []);
        batName = curInn.batting === m.a ? (m.teamAName || 'Team A') : (m.teamBName || 'Team B');
        bowlName = curInn.bowling === m.a ? (m.teamAName || 'Team A') : (m.teamBName || 'Team B');
        scoreSummary = `${st.totalRuns}/${st.wickets} (${st.oversFormatted} ov)`;
      }

      const isLive = row.status === 'Live';
      return `
        <div class="public-match-card ${isLive ? 'is-live' : ''}">
          <div class="pmc-top">
            <span>${escapeHTML(m.format || 'T20')} · By ${escapeHTML(m.ownerName || 'Scorer')}</span>
            ${isLive
              ? `<span class="pmc-live-badge"><span class="pmc-live-dot"></span> LIVE</span>`
              : `<span class="tourn-status-badge completed">COMPLETED</span>`}
          </div>
          <div style="font-size:13.5px; font-weight:900;">${escapeHTML(batName)} vs ${escapeHTML(bowlName)}</div>
          <div class="pmc-score-row">
            <div>
              <div class="pmc-score-big">${scoreSummary}</div>
              <div class="muted" style="font-size:11px;">${escapeHTML(row.result || m.title || '')}</div>
            </div>
            <button type="button" class="btn btn-primary" style="padding:7px 12px; font-size:11.5px;" onclick="openSpectatorLiveMatch('${row.id}')">
              📺 Watch Live
            </button>
          </div>
        </div>
      `;
    }).join('');

    if (manual) showToast('Public Live Match Center updated');
  } catch (e) {
    container.innerHTML = `<div class="empty-state" style="padding:12px;">Unable to reach Public Live Center right now.</div>`;
  }
}

function shareLiveMatchLink(matchId) {
  if (activeMatch && currentCloudUser) {
    pushSingleMatchToCloud(activeMatch);
  }
  const shareUrl = `${window.location.origin}${window.location.pathname}#watch=${encodeURIComponent(matchId)}`;
  const shareText = activeMatch
    ? `🏏 Watch LIVE Cricket Score: ${activeMatch.title || 'CricScorer Match'}
${shareUrl}`
    : `🏏 Watch LIVE Cricket Score on CricScorer:
${shareUrl}`;

  if (navigator.share) {
    navigator.share({
      title: 'CricScorer Live Scoreboard',
      text: shareText,
      url: shareUrl
    }).catch(() => {});
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(shareUrl).then(() => {
      alert(`Live Spectator Link copied!

${shareUrl}

Share this link on WhatsApp so players & fans can watch ball-by-ball updates live.`);
    }).catch(() => {
      prompt('Copy and share this Live Spectator Link:', shareUrl);
    });
  } else {
    prompt('Copy and share this Live Spectator Link:', shareUrl);
  }
}

async function openSpectatorLiveMatch(matchId) {
  spectatorWatchMatchId = matchId;
  try {
    history.replaceState(null, '', '#watch=' + encodeURIComponent(matchId));
  } catch (e) {}
  navigate('watch-live');
}

function exitSpectatorMode() {
  if (spectatorRealtimeChannel && sbClient) {
    sbClient.removeChannel(spectatorRealtimeChannel);
    spectatorRealtimeChannel = null;
  }
  spectatorWatchMatchId = null;
  navigate('dashboard');
}

async function renderSpectatorView() {
  const container = document.getElementById('spectatorLiveContainer');
  if (!container) return;

  if (!spectatorWatchMatchId) {
    container.innerHTML = `<div class="empty-state">No live broadcast selected. Pick a match from the Public Live Match Center on Home.</div>`;
    return;
  }

  if (!sbClient) {
    container.innerHTML = `<div class="empty-state">Connecting to broadcast server...</div>`;
    return;
  }

  const { data, error } = await sbClient
    .from('matches')
    .select('*')
    .eq('id', spectatorWatchMatchId)
    .maybeSingle();

  if (error || !data) {
    container.innerHTML = `<div class="empty-state">Match not found or not yet synced to cloud by the scorer.</div>`;
    return;
  }

  spectatorMatchData = data;
  paintSpectatorScoreboard(data);

  // Subscribe to real-time updates for this match
  if (spectatorRealtimeChannel) {
    sbClient.removeChannel(spectatorRealtimeChannel);
  }
  spectatorRealtimeChannel = sbClient
    .channel('watch-match-' + spectatorWatchMatchId)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'matches',
      filter: `id=eq.${spectatorWatchMatchId}`
    }, (payload) => {
      if (payload.new) {
        spectatorMatchData = payload.new;
        paintSpectatorScoreboard(payload.new);
      }
    })
    .subscribe();
}

function paintSpectatorScoreboard(row) {
  const container = document.getElementById('spectatorLiveContainer');
  if (!container || !row) return;
  const m = row.match_json || {};
  const innList = m.innings || [];
  const inn = innList[innList.length - 1];
  if (!inn) {
    container.innerHTML = `<div class="empty-state">Waiting for first ball to be bowled...</div>`;
    return;
  }

  const stats = CricketEngine.calculateInnings(inn, inn.squad || [], inn.bowlingSquad || []);
  const batName = inn.batting === m.a ? (m.teamAName || 'Batting Team') : (m.teamBName || 'Bowling Team');
  const bowlName = inn.bowling === m.a ? (m.teamAName || 'Batting Team') : (m.teamBName || 'Bowling Team');
  const crr = stats.legalDeliveries > 0 ? ((stats.totalRuns / stats.legalDeliveries) * 6).toFixed(2) : '0.00';
  const striker = stats.batters.find(b => b.id === inn.strikerId);
  const nonStriker = stats.batters.find(b => b.id === inn.nonStrikerId);
  const bowler = stats.bowlers.find(b => b.id === inn.bowlerId);
  const recentBalls = (inn.balls || []).slice(-10);

  container.innerHTML = `
    <div class="spectator-banner">
      <span>🔴 LIVE BROADCAST</span>
      <div style="display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end;">
        <button type="button" class="pill-btn" style="padding:3px 9px; font-size:10.5px;" onclick="copyObsOverlayUrl('${row.id}')" title="Copy transparent YouTube/OBS Browser Source URL">📺 OBS Overlay</button>
        ${row.status === 'Live' ? `<button type="button" class="pill-btn" style="padding:3px 9px; font-size:10.5px;" onclick="openClaimCoScorerModal('${row.id}')">🔑 Co-Scorer PIN</button>` : ''}
        <button type="button" class="pill-btn" style="padding:3px 9px; font-size:10.5px;" onclick="shareLiveMatchLink('${row.id}')">📤 Share</button>
      </div>
    </div>

    <div class="scorer-broadcast-hero">
      <div class="hlh-top-row">
        <span style="font-size:11px; font-weight:800; color:var(--text-muted);">${escapeHTML(m.format || 'T20')} · ${escapeHTML(m.title || 'Live Match')}</span>
        <span class="scorer-live-pill"><span class="scorer-live-dot"></span> ${escapeHTML((row.status || 'LIVE').toUpperCase())}</span>
      </div>
      <div class="hlh-teams-score-row">
        <div class="hlh-team-col">
          ${buildHomeTeamShieldSVG(batName, 'a')}
          <span class="hlh-team-label">${escapeHTML(batName)}</span>
        </div>
        <div class="hlh-score-center">
          <div class="hlh-big-score">${stats.totalRuns} / ${stats.wickets}</div>
          <div class="hlh-overs-label">(${stats.oversFormatted} / ${m.overs || 20} ov)</div>
        </div>
        <div class="hlh-team-col">
          ${buildHomeTeamShieldSVG(bowlName, 'b')}
          <span class="hlh-team-label">${escapeHTML(bowlName)}</span>
        </div>
      </div>
      <div class="hlh-metrics-strip" style="grid-template-columns: repeat(3, 1fr);">
        <div class="hlh-m-cell"><span>CRR</span><strong>${crr}</strong></div>
        <div class="hlh-m-cell"><span>Target</span><strong>${m.target || '--'}</strong></div>
        <div class="hlh-m-cell"><span>Extras</span><strong>${stats.extras.total || 0}</strong></div>
      </div>
      ${row.result ? `<div class="scorer-phase-strip" style="justify-content:center; font-weight:900; color:var(--primary);">🏆 ${escapeHTML(row.result)}</div>` : ''}
    </div>

    <div class="card" style="padding:10px; margin-bottom:12px;">
      <table class="crease-table">
        <thead><tr><th>Batter</th><th>R</th><th>B</th><th>4s</th><th>6s</th><th>SR</th></tr></thead>
        <tbody>
          ${striker ? `<tr><td>★ <strong>${escapeHTML(striker.name)}</strong>${renderBatterMilestoneBadges(striker.runs)}</td><td><strong>${striker.runs}</strong></td><td>${striker.balls}</td><td>${striker.fours}</td><td>${striker.sixes}</td><td>${striker.strikeRate}</td></tr>` : ''}
          ${nonStriker ? `<tr><td>&nbsp;&nbsp;${escapeHTML(nonStriker.name)}${renderBatterMilestoneBadges(nonStriker.runs)}</td><td><strong>${nonStriker.runs}</strong></td><td>${nonStriker.balls}</td><td>${nonStriker.fours}</td><td>${nonStriker.sixes}</td><td>${nonStriker.strikeRate}</td></tr>` : ''}
        </tbody>
      </table>
      ${bowler ? `
        <table class="crease-table" style="margin-top:10px;">
          <thead><tr><th>Bowler</th><th>O</th><th>R</th><th>W</th><th>ECON</th></tr></thead>
          <tbody>
            <tr><td>⚡ <strong>${escapeHTML(bowler.name)}</strong>${bowler.wickets >= 5 ? `<span class="sc-5w-badge">5W🔥</span>` : ''}</td><td>${bowler.oversFormatted}</td><td>${bowler.runsConceded}</td><td><strong style="color:var(--danger);">${bowler.wickets}</strong></td><td>${bowler.economy}</td></tr>
          </tbody>
        </table>
      ` : ''}
    </div>

    <div class="card" style="padding:10px 14px;">
      <div class="eyebrow" style="margin-bottom:4px;">Recent Balls</div>
      <div class="timeline-strip">
        ${recentBalls.length ? recentBalls.map(b => `
          <div class="timeline-ball ${b.batRuns === 4 ? 'four' : b.batRuns === 6 ? 'six' : b.wicket ? 'wicket' : b.extraType ? 'extra' : ''}">
            ${b.wicket ? 'W' : b.extraType ? b.extraType.slice(0,2).toUpperCase() : b.batRuns}
          </div>
        `).join('') : '<span class="muted" style="font-size:12px;">Waiting for deliveries...</span>'}
      </div>
    </div>
  `;
}


// ==========================================
// V2.29: 1080x1080 HTML5 CANVAS MATCH POSTER & PUBLIC TOURNAMENT HUB
// ==========================================
let publicWatchTournamentId = null;
let publicTournamentRealtimeChannel = null;
let activePosterMatchObj = null;
let activePosterTeamsList = [];
let activePosterPlayersMap = {};
let currentPosterTheme = 'dark';

function viewMatchScorecardModal(matchId) {
  return viewDetailedScorecard(matchId);
}

function drawRoundedRectCanvas(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawTeamShieldOnCanvas(ctx, cx, cy, teamName, primaryColor, accentColor) {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(cx, cy - 52);
  ctx.lineTo(cx + 46, cy - 34);
  ctx.lineTo(cx + 46, cy + 4);
  ctx.bezierCurveTo(cx + 46, cy + 34, cx + 22, cy + 50, cx, cy + 58);
  ctx.bezierCurveTo(cx - 22, cy + 50, cx - 46, cy + 34, cx - 46, cy + 4);
  ctx.lineTo(cx - 46, cy - 34);
  ctx.closePath();
  ctx.fillStyle = primaryColor;
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = accentColor;
  ctx.stroke();

  const initial = (teamName || 'T').trim().charAt(0).toUpperCase();
  ctx.fillStyle = '#ffffff';
  ctx.font = '900 44px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(initial, cx, cy + 4);
  ctx.restore();
}

function renderMatchSummaryPosterToCanvas(canvas, matchObj, teamsList, playersMap, theme = 'dark') {
  if (!canvas || !matchObj) return;
  const ctx = canvas.getContext('2d');
  const W = 1080;
  const H = 1080;
  canvas.width = W;
  canvas.height = H;

  const isLight = theme === 'light';
  const inn1 = matchObj.innings?.[0];
  const inn2 = matchObj.innings?.[1];

  const t1Id = inn1 ? inn1.batting : matchObj.a;
  const t2Id = inn1 ? inn1.bowling : matchObj.b;
  const team1Name = teamsList.find(t => t.id === t1Id)?.name || matchObj.teamAName || 'Team 1';
  const team2Name = teamsList.find(t => t.id === t2Id)?.name || matchObj.teamBName || 'Team 2';

  const st1 = inn1 ? CricketEngine.calculateInnings(inn1, inn1.squad || [], inn1.bowlingSquad || []) : { totalRuns: 0, wickets: 0, oversFormatted: '0.0', batters: [], bowlers: [] };
  const st2 = inn2 ? CricketEngine.calculateInnings(inn2, inn2.squad || [], inn2.bowlingSquad || []) : null;

  // Gather top batter & top bowler across innings
  const allBatters = [];
  const allBowlers = [];
  [st1, st2].filter(Boolean).forEach(st => {
    (st.batters || []).forEach(b => { if (b.runs > 0 || b.balls > 0) allBatters.push(b); });
    (st.bowlers || []).forEach(bo => { if (bo.legalBalls > 0 || bo.wickets > 0) allBowlers.push(bo); });
  });
  allBatters.sort((a, b) => (b.runs - a.runs) || (a.balls - b.balls));
  allBowlers.sort((a, b) => (b.wickets - a.wickets) || (a.runsConceded - b.runsConceded));

  const topBatter = allBatters[0] || null;
  const topBowler = allBowlers[0] || null;
  const mvp = calculateMatchMVP(matchObj, playersMap);

  // Background Gradient
  const bgGrad = ctx.createLinearGradient(0, 0, W, H);
  if (isLight) {
    bgGrad.addColorStop(0, '#ecfdf5');
    bgGrad.addColorStop(0.55, '#ffffff');
    bgGrad.addColorStop(1, '#f0fdf4');
  } else {
    bgGrad.addColorStop(0, '#071318');
    bgGrad.addColorStop(0.5, '#0b2922');
    bgGrad.addColorStop(1, '#09111a');
  }
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, H);

  // Outer Stadium Border Frame
  drawRoundedRectCanvas(ctx, 34, 34, W - 68, H - 68, 36);
  ctx.lineWidth = 4;
  ctx.strokeStyle = isLight ? '#059669' : '#10b981';
  ctx.stroke();

  // Top Brand Pill
  drawRoundedRectCanvas(ctx, 360, 66, 360, 48, 24);
  ctx.fillStyle = isLight ? '#059669' : 'rgba(16, 185, 129, 0.2)';
  ctx.fill();
  ctx.fillStyle = isLight ? '#ffffff' : '#34d399';
  ctx.font = '900 21px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('🏏 CRICSCORER OFFICIAL', W / 2, 97);

  // Match Title & Format
  ctx.fillStyle = isLight ? '#064e3b' : '#94a3b8';
  ctx.font = '800 24px system-ui, -apple-system, sans-serif';
  ctx.fillText(`${(matchObj.format || 'T20').toUpperCase()} · ${(matchObj.title || 'MATCH SUMMARY').toUpperCase().slice(0, 38)}`, W / 2, 162);

  // Team 1 & Team 2 Shields + Scores
  drawTeamShieldOnCanvas(ctx, 250, 275, team1Name, '#0284c7', '#38bdf8');
  drawTeamShieldOnCanvas(ctx, 830, 275, team2Name, '#dc2626', '#f87171');

  ctx.fillStyle = isLight ? '#0f172a' : '#f8fafc';
  ctx.font = '900 32px system-ui, -apple-system, sans-serif';
  ctx.fillText(team1Name.slice(0, 18), 250, 375);
  ctx.fillText(team2Name.slice(0, 18), 830, 375);

  ctx.fillStyle = isLight ? '#059669' : '#34d399';
  ctx.font = '900 54px system-ui, -apple-system, sans-serif';
  ctx.fillText(`${st1.totalRuns}/${st1.wickets}`, 250, 442);
  ctx.fillText(st2 ? `${st2.totalRuns}/${st2.wickets}` : 'DNB', 830, 442);

  ctx.fillStyle = isLight ? '#475569' : '#94a3b8';
  ctx.font = '700 24px system-ui, -apple-system, sans-serif';
  ctx.fillText(`(${st1.oversFormatted} ov)`, 250, 482);
  ctx.fillText(st2 ? `(${st2.oversFormatted} ov)` : '', 830, 482);

  // Center VS Emblem
  drawRoundedRectCanvas(ctx, W / 2 - 42, 265, 84, 52, 16);
  ctx.fillStyle = isLight ? '#d1fae5' : 'rgba(255,255,255,0.08)';
  ctx.fill();
  ctx.fillStyle = isLight ? '#065f46' : '#34d399';
  ctx.font = '900 26px system-ui, -apple-system, sans-serif';
  ctx.fillText('VS', W / 2, 300);

  // Result Banner
  drawRoundedRectCanvas(ctx, 84, 528, W - 168, 76, 20);
  ctx.fillStyle = isLight ? '#059669' : '#10b981';
  ctx.fill();
  ctx.fillStyle = isLight ? '#ffffff' : '#052e16';
  ctx.font = '900 30px system-ui, -apple-system, sans-serif';
  ctx.fillText(`🏆 ${(matchObj.result || 'MATCH COMPLETED').slice(0, 42)}`, W / 2, 576);

  // Two Performer Cards (Top Batter & Top Bowler)
  const cardBg = isLight ? '#f8fafc' : 'rgba(255, 255, 255, 0.06)';
  const cardBorder = isLight ? '#cbd5e1' : 'rgba(255, 255, 255, 0.14)';

  // Left Card: Top Batter
  drawRoundedRectCanvas(ctx, 84, 636, 436, 178, 22);
  ctx.fillStyle = cardBg;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = cardBorder;
  ctx.stroke();

  ctx.textAlign = 'left';
  ctx.fillStyle = isLight ? '#0369a1' : '#38bdf8';
  ctx.font = '900 20px system-ui, -apple-system, sans-serif';
  ctx.fillText('🏏 TOP BATTER', 114, 680);

  ctx.fillStyle = isLight ? '#0f172a' : '#ffffff';
  ctx.font = '900 30px system-ui, -apple-system, sans-serif';
  ctx.fillText(topBatter ? topBatter.name.slice(0, 18) : 'N/A', 114, 730);

  ctx.fillStyle = isLight ? '#059669' : '#34d399';
  ctx.font = '900 32px system-ui, -apple-system, sans-serif';
  ctx.fillText(topBatter ? `${topBatter.runs}${topBatter.isOut ? '' : '*'} (${topBatter.balls}b · ${topBatter.fours}x4, ${topBatter.sixes}x6)` : '--', 114, 778);

  // Right Card: Top Bowler
  drawRoundedRectCanvas(ctx, 560, 636, 436, 178, 22);
  ctx.fillStyle = cardBg;
  ctx.fill();
  ctx.strokeStyle = cardBorder;
  ctx.stroke();

  ctx.fillStyle = isLight ? '#b91c1c' : '#f87171';
  ctx.font = '900 20px system-ui, -apple-system, sans-serif';
  ctx.fillText('⚡ TOP BOWLER', 590, 680);

  ctx.fillStyle = isLight ? '#0f172a' : '#ffffff';
  ctx.font = '900 30px system-ui, -apple-system, sans-serif';
  ctx.fillText(topBowler ? topBowler.name.slice(0, 18) : 'N/A', 590, 730);

  ctx.fillStyle = isLight ? '#d97706' : '#fbbf24';
  ctx.font = '900 32px system-ui, -apple-system, sans-serif';
  ctx.fillText(topBowler ? `${topBowler.wickets}/${topBowler.runsConceded} (${topBowler.oversFormatted} ov)` : '--', 590, 778);

  // MVP Spotlight Strip
  drawRoundedRectCanvas(ctx, 84, 842, W - 168, 114, 22);
  ctx.fillStyle = isLight ? '#fef3c7' : 'rgba(245, 158, 11, 0.16)';
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = isLight ? '#f59e0b' : 'rgba(251, 191, 36, 0.55)';
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.fillStyle = isLight ? '#92400e' : '#fbbf24';
  ctx.font = '900 20px system-ui, -apple-system, sans-serif';
  ctx.fillText('🌟 PLAYER OF THE MATCH (MVP)', W / 2, 884);

  ctx.fillStyle = isLight ? '#0f172a' : '#ffffff';
  ctx.font = '900 34px system-ui, -apple-system, sans-serif';
  const mvpLine = mvp ? `${mvp.name} — ${mvp.highlights.slice(0, 2).join(' · ')}` : 'All-Round Team Effort';
  ctx.fillText(mvpLine.slice(0, 42), W / 2, 930);

  // Footer Watermark
  ctx.fillStyle = isLight ? '#64748b' : '#64748b';
  ctx.font = '700 20px system-ui, -apple-system, sans-serif';
  ctx.fillText('Scored Live on CricScorer PWA', W / 2, 1005);
}

async function openMatchPosterModal(matchId) {
  const [matches, teams, players] = await Promise.all([
    dbGetAll('matches'),
    dbGetAll('teams'),
    dbGetAll('players')
  ]);
  const matchObj = matches.find(m => m.id === matchId) || (activeMatch && activeMatch.id === matchId ? activeMatch : null);
  if (!matchObj) {
    showToast('Match not found.');
    return;
  }

  activePosterMatchObj = matchObj;
  activePosterTeamsList = teams;
  activePosterPlayersMap = {};
  (players || []).forEach(p => { activePosterPlayersMap[p.id] = p.name; });
  currentPosterTheme = document.body.getAttribute('data-theme') === 'light' ? 'light' : 'dark';

  const html = `
    <div class="poster-preview-wrap">
      <div class="poster-theme-pills">
        <button type="button" class="poster-theme-btn ${currentPosterTheme === 'dark' ? 'active' : ''}" id="posterThemeDarkBtn" onclick="switchPosterTheme('dark')">🌙 Stadium Dark</button>
        <button type="button" class="poster-theme-btn ${currentPosterTheme === 'light' ? 'active' : ''}" id="posterThemeLightBtn" onclick="switchPosterTheme('light')">☀️ Sunlit Emerald</button>
      </div>
      <div class="poster-canvas-frame">
        <canvas id="matchSummaryPosterCanvas"></canvas>
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; width:100%;">
        <button type="button" class="btn btn-secondary" onclick="downloadMatchPosterPNG()">⬇️ Download PNG</button>
        <button type="button" class="btn btn-primary" onclick="shareMatchPosterImage()">📤 Share Poster</button>
      </div>
    </div>
  `;

  openModal('1080×1080 Match Result Poster', html, null, false);
  setTimeout(() => {
    const cvs = document.getElementById('matchSummaryPosterCanvas');
    renderMatchSummaryPosterToCanvas(cvs, activePosterMatchObj, activePosterTeamsList, activePosterPlayersMap, currentPosterTheme);
  }, 40);
}

function switchPosterTheme(theme) {
  currentPosterTheme = theme;
  document.getElementById('posterThemeDarkBtn')?.classList.toggle('active', theme === 'dark');
  document.getElementById('posterThemeLightBtn')?.classList.toggle('active', theme === 'light');
  const cvs = document.getElementById('matchSummaryPosterCanvas');
  renderMatchSummaryPosterToCanvas(cvs, activePosterMatchObj, activePosterTeamsList, activePosterPlayersMap, currentPosterTheme);
}

function downloadMatchPosterPNG() {
  const cvs = document.getElementById('matchSummaryPosterCanvas');
  if (!cvs) return;
  const link = document.createElement('a');
  const slug = (activePosterMatchObj?.title || 'cricscorer-match').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  link.download = `${slug}-poster.png`;
  link.href = cvs.toDataURL('image/png');
  link.click();
  showToast('1080×1080 Match Poster downloaded!');
}

async function shareMatchPosterImage() {
  const cvs = document.getElementById('matchSummaryPosterCanvas');
  if (!cvs) return;
  cvs.toBlob(async (blob) => {
    if (!blob) return;
    const file = new File([blob], 'cricscorer-match-summary.png', { type: 'image/png' });
    const shareText = `🏏 ${activePosterMatchObj?.title || 'Match Result'} — ${activePosterMatchObj?.result || 'Scored on CricScorer'}`;
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({
          title: 'CricScorer Match Summary',
          text: shareText,
          files: [file]
        });
        return;
      } catch (e) {}
    }
    downloadMatchPosterPNG();
  }, 'image/png');
}

// Public Tournament Link Sharing & Read-Only Spectator Hub (#tournament=<id>)
async function sharePublicTournamentLink(tournId) {
  const tourns = await getAllTournaments();
  if (currentCloudUser && tourns.length) {
    await queueCloudTournamentsSync(tourns);
  }
  const tObj = tourns.find(t => t.id === tournId);
  const shareUrl = `${window.location.origin}${window.location.pathname}#tournament=${encodeURIComponent(tournId)}`;
  const shareText = `🏆 Follow Live Points Table, NRR & Fixtures for ${tObj?.name || 'our Cricket Tournament'}:
${shareUrl}`;

  if (navigator.share) {
    navigator.share({
      title: tObj?.name || 'CricScorer Tournament Hub',
      text: shareText,
      url: shareUrl
    }).catch(() => {});
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(shareUrl).then(() => {
      alert(`Public Tournament Hub Link copied!

${shareUrl}

Share this link in your tournament WhatsApp group so all teams can view live Points Table & Fixtures.`);
    }).catch(() => {
      prompt('Copy and share this Tournament Hub Link:', shareUrl);
    });
  } else {
    prompt('Copy and share this Tournament Hub Link:', shareUrl);
  }
}

function exitPublicTournamentMode() {
  if (publicTournamentRealtimeChannel && sbClient) {
    sbClient.removeChannel(publicTournamentRealtimeChannel);
    publicTournamentRealtimeChannel = null;
  }
  publicWatchTournamentId = null;
  navigate('dashboard');
}

let publicTournamentSubTab = 'standings';

function switchPublicTournamentSubTab(tab) {
  publicTournamentSubTab = tab;
  renderPublicTournamentHub();
}

async function renderPublicTournamentHub() {
  const container = document.getElementById('publicTournamentHubContainer');
  if (!container) return;

  if (!publicWatchTournamentId) {
    container.innerHTML = `<div class="empty-state">No tournament ID specified in link.</div>`;
    return;
  }

  let tournData = null;
  let teamsMap = {};
  let cloudMatches = [];

  if (sbClient && navigator.onLine) {
    try {
      const [{ data: tRow }, { data: mRows }] = await Promise.all([
        sbClient.from('tournaments').select('*').eq('id', publicWatchTournamentId).maybeSingle(),
        sbClient.from('matches').select('*').eq('tournament_id', publicWatchTournamentId)
      ]);
      if (tRow && tRow.data_json) {
        tournData = tRow.data_json;
        teamsMap = tournData.teamsMap || {};
      }
      cloudMatches = (mRows || []).map(r => r.match_json || r);
    } catch (e) {}
  }

  if (!tournData && db) {
    const [localTourns, localTeams, localMatches] = await Promise.all([
      getAllTournaments(),
      dbGetAll('teams'),
      dbGetAll('matches')
    ]);
    tournData = localTourns.find(t => t.id === publicWatchTournamentId) || null;
    localTeams.forEach(t => { teamsMap[t.id] = t.name; });
    cloudMatches = localMatches.filter(m => m.tournamentId === publicWatchTournamentId);
  }

  if (!tournData) {
    container.innerHTML = `<div class="empty-state">Tournament not found or not yet synced to cloud by the organizer.</div>`;
    return;
  }

  const standings = computeTournamentStandings(tournData, teamsMap, cloudMatches);
  const caps = computeTournamentPlayerCaps(tournData, teamsMap, cloudMatches);
  const fixtures = tournData.fixtures || [];

  container.innerHTML = `
    <div class="spectator-banner" style="background:rgba(245,158,11,0.14); border-color:rgba(245,158,11,0.45);">
      <span>🏆 PUBLIC TOURNAMENT HUB · Live Standings &amp; Caps</span>
      <button type="button" class="pill-btn" style="padding:3px 9px; font-size:10.5px;" onclick="sharePublicTournamentLink('${tournData.id}')">📤 Share</button>
    </div>

    <div class="tourn-hero-card">
      <div class="eyebrow" style="color:var(--primary); margin-bottom:3px;">${escapeHTML(tournData.format || 'T20')} · ${tournData.overs || 20} OVERS</div>
      <h2 style="font-size:20px; font-weight:950; margin:0 0 4px;">${escapeHTML(tournData.name)}</h2>
      <p class="muted" style="font-size:12px; margin:0;">${(tournData.teamIds || []).length} Competing Teams · ${fixtures.length} Scheduled Matches</p>
    </div>

    <div class="tourn-subtabs-grid">
      <button type="button" class="tourn-subtab-btn ${publicTournamentSubTab === 'standings' ? 'active' : ''}" onclick="switchPublicTournamentSubTab('standings')">📊 Standings</button>
      <button type="button" class="tourn-subtab-btn ${publicTournamentSubTab === 'orange' ? 'active' : ''}" onclick="switchPublicTournamentSubTab('orange')">🧢 Orange Cap</button>
      <button type="button" class="tourn-subtab-btn ${publicTournamentSubTab === 'purple' ? 'active' : ''}" onclick="switchPublicTournamentSubTab('purple')">🟣 Purple Cap</button>
      <button type="button" class="tourn-subtab-btn ${publicTournamentSubTab === 'mvp' ? 'active' : ''}" onclick="switchPublicTournamentSubTab('mvp')">🌟 MVP</button>
    </div>

    ${buildTournamentLeaderboardHTML(publicTournamentSubTab, standings, caps, fixtures, teamsMap, cloudMatches, false, tournData.id)}
  `;

  if (sbClient && !publicTournamentRealtimeChannel) {
    publicTournamentRealtimeChannel = sbClient
      .channel('watch-tourn-' + publicWatchTournamentId)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'tournaments',
        filter: `id=eq.${publicWatchTournamentId}`
      }, () => {
        renderPublicTournamentHub();
      })
      .subscribe();
  }
}


// ==========================================
// V2.30: INDEXEDDB CLOUD SYNC RETRY QUEUE & SPECTATOR PRESENCE / REACTIONS
// ==========================================
const CLOUD_SYNC_QUEUE_KEY = 'cricscorer_sync_queue_v1';
let spectatorViewerCount = 1;

async function getCloudSyncQueue() {
  if (!db) return [];
  try {
    const item = await dbGet('settings', CLOUD_SYNC_QUEUE_KEY);
    return Array.isArray(item?.val) ? item.val : [];
  } catch (e) {
    return [];
  }
}

async function setCloudSyncQueue(queue) {
  if (!db) return;
  try {
    await dbPut('settings', { key: CLOUD_SYNC_QUEUE_KEY, val: queue });
  } catch (e) {}
  updateSyncStatusPill(queue.length);
}

async function enqueueCloudSyncItem(kind, payloadId) {
  const q = await getCloudSyncQueue();
  const exists = q.some(item => item.kind === kind && item.id === payloadId);
  if (!exists) {
    q.push({ kind, id: payloadId, queuedAt: Date.now() });
    await setCloudSyncQueue(q);
  } else {
    updateSyncStatusPill(q.length);
  }
}

async function flushCloudSyncQueue(silent = true) {
  if (!sbClient || !currentCloudUser || !navigator.onLine || !db) {
    const q = await getCloudSyncQueue();
    updateSyncStatusPill(q.length);
    return;
  }

  const q = await getCloudSyncQueue();
  if (!q.length) {
    updateSyncStatusPill(0);
    return;
  }

  const [matches, tourns] = await Promise.all([dbGetAll('matches'), getAllTournaments()]);
  const remaining = [];

  for (const item of q) {
    try {
      if (item.kind === 'match') {
        const mObj = matches.find(m => m.id === item.id);
        if (mObj) await pushSingleMatchToCloud(mObj);
      } else if (item.kind === 'tournaments') {
        await queueCloudTournamentsSync(tourns);
      }
    } catch (e) {
      remaining.push(item);
    }
  }

  await setCloudSyncQueue(remaining);
  if (!silent && remaining.length === 0) {
    showToast('All queued offline updates synced to cloud!');
  }
}

function updateSyncStatusPill(queuedCount = 0) {
  const pill = document.getElementById('syncStatusPill');
  if (!pill) return;

  pill.classList.remove('synced', 'queued', 'offline');
  if (!currentCloudUser) {
    pill.classList.add('offline');
    pill.textContent = '⚪ Local';
    return;
  }
  if (!navigator.onLine) {
    pill.classList.add('queued');
    pill.textContent = queuedCount > 0 ? `🟡 Offline (${queuedCount})` : '🟡 Offline';
    return;
  }
  if (queuedCount > 0) {
    pill.classList.add('queued');
    pill.textContent = `🟡 ${queuedCount} Queued`;
  } else {
    pill.classList.add('synced');
    pill.textContent = '🟢 Synced';
  }
}

function handleSyncStatusPillClick() {
  if (!currentCloudUser) {
    openCloudAuthModal();
    return;
  }
  if (!navigator.onLine) {
    showToast('Offline at ground — your scores are safely saved in IndexedDB and will auto-sync once back online.');
    return;
  }
  flushCloudSyncQueue(false);
  syncAllLocalDataToCloud(false);
}

// Wrap queueCloudMatchSync so offline updates are always persisted in IndexedDB queue
const _origQueueCloudMatchSync = queueCloudMatchSync;
queueCloudMatchSync = function(matchObj) {
  if (matchObj && matchObj.id) {
    enqueueCloudSyncItem('match', matchObj.id);
  }
  if (!sbClient || !currentCloudUser || !navigator.onLine || !matchObj) return;
  clearTimeout(cloudSyncDebounceTimer);
  cloudSyncDebounceTimer = setTimeout(async () => {
    await pushSingleMatchToCloud(matchObj);
    const q = await getCloudSyncQueue();
    const filtered = q.filter(item => !(item.kind === 'match' && item.id === matchObj.id));
    await setCloudSyncQueue(filtered);
  }, 1200);
};

window.addEventListener('online', () => {
  flushCloudSyncQueue(true);
});

window.addEventListener('offline', async () => {
  const q = await getCloudSyncQueue();
  updateSyncStatusPill(q.length);
});

// Spectator Presence & Live Floating Reactions
function spawnFloatingCheer(emoji) {
  let stage = document.getElementById('floatingCheerStage');
  if (!stage) {
    stage = document.createElement('div');
    stage.id = 'floatingCheerStage';
    stage.className = 'floating-cheer-stage';
    document.body.appendChild(stage);
  }
  const el = document.createElement('div');
  el.className = 'floating-cheer-bubble';
  el.textContent = emoji;
  stage.appendChild(el);
  setTimeout(() => el.remove(), 1850);
}

function sendSpectatorCheer(emoji) {
  spawnFloatingCheer(emoji);
  if (spectatorRealtimeChannel) {
    spectatorRealtimeChannel.send({
      type: 'broadcast',
      event: 'cheer',
      payload: { emoji, ts: Date.now() }
    }).catch(() => {});
  }
}

// Enhance Spectator View with Presence tracking & Broadcast Emoji Cheers
const _origRenderSpectatorView = renderSpectatorView;
renderSpectatorView = async function() {
  await _origRenderSpectatorView();
  if (spectatorRealtimeChannel && spectatorWatchMatchId) {
    const presenceKey = 'fan-' + Math.random().toString(36).slice(2, 9);
    spectatorRealtimeChannel
      .on('presence', { event: 'sync' }, () => {
        const state = spectatorRealtimeChannel.presenceState();
        spectatorViewerCount = Math.max(1, Object.keys(state).length);
        const countEl = document.getElementById('spectatorLiveViewerCount');
        if (countEl) countEl.textContent = `👁️ ${spectatorViewerCount} watching live`;
      })
      .on('broadcast', { event: 'cheer' }, ({ payload }) => {
        if (payload?.emoji) spawnFloatingCheer(payload.emoji);
      });

    spectatorRealtimeChannel.track({
      user: presenceKey,
      online_at: new Date().toISOString()
    }).catch(() => {});
  }
};

const _origPaintSpectatorScoreboard = paintSpectatorScoreboard;
paintSpectatorScoreboard = function(row) {
  _origPaintSpectatorScoreboard(row);
  const container = document.getElementById('spectatorLiveContainer');
  if (!container || !row) return;
  const presenceBarHTML = `
    <div class="spectator-presence-row">
      <span id="spectatorLiveViewerCount">👁️ ${spectatorViewerCount} watching live</span>
      <div class="spectator-reaction-bar">
        <button type="button" class="reaction-chip-btn" onclick="sendSpectatorCheer('👏')" title="Applaud">👏</button>
        <button type="button" class="reaction-chip-btn" onclick="sendSpectatorCheer('🔥')" title="Fire">🔥</button>
        <button type="button" class="reaction-chip-btn" onclick="sendSpectatorCheer('🏏')" title="Shot!">🏏</button>
        <button type="button" class="reaction-chip-btn" onclick="sendSpectatorCheer('💯')" title="Century Cheer">💯</button>
      </div>
    </div>
  `;
  container.insertAdjacentHTML('afterbegin', presenceBarHTML);
};


// ==========================================
// V2.34: CO-SCORER PIN, DLS REVISION, 8-ZONE WAGON WHEEL & PWA INSTALL
// ==========================================
let shotWheelEnabled = false;
try {
  shotWheelEnabled = localStorage.getItem('cricscorer_shot_wheel') === '1';
} catch (e) {}

const WAGON_WHEEL_ZONES = [
  { id: 'third_man', label: 'Third Man', angleDeg: -135 },
  { id: 'point', label: 'Point / Gully', angleDeg: -90 },
  { id: 'cover', label: 'Extra Cover', angleDeg: -45 },
  { id: 'long_off', label: 'Long-Off', angleDeg: -15 },
  { id: 'long_on', label: 'Long-On', angleDeg: 15 },
  { id: 'mid_wicket', label: 'Mid-Wicket', angleDeg: 55 },
  { id: 'square_leg', label: 'Square Leg', angleDeg: 95 },
  { id: 'fine_leg', label: 'Fine Leg', angleDeg: 135 }
];

function toggleShotWheelPreference(enabled) {
  shotWheelEnabled = !!enabled;
  try {
    localStorage.setItem('cricscorer_shot_wheel', shotWheelEnabled ? '1' : '0');
  } catch (e) {}
  const el = document.getElementById('settingShotWheel');
  if (el) el.checked = shotWheelEnabled;
  showToast(shotWheelEnabled ? '🎯 8-Zone Boundary Wagon Wheel enabled' : '8-Zone Wagon Wheel turned off');
  if (document.getElementById('live-scorer')?.classList.contains('active')) {
    renderLiveScorerView();
  }
}

const _origRecordBallEventV34 = recordBallEvent;
recordBallEvent = async function(runs) {
  await _origRecordBallEventV34(runs);
  if (shotWheelEnabled && (runs === 4 || runs === 6) && activeMatch) {
    const inn = activeMatch.innings[activeMatch.innings.length - 1];
    const lastBall = inn?.balls?.[inn.balls.length - 1];
    if (lastBall && lastBall.batRuns === runs) {
      openShotZonePickerModal(lastBall.id, runs);
    }
  }
};

const RADIAL_WHEEL_SECTORS = [
  { id: 'long_off', label: 'Long-Off', startDeg: -22.5, endDeg: 22.5 },
  { id: 'cover', label: 'Cover', startDeg: 22.5, endDeg: 67.5 },
  { id: 'point', label: 'Point', startDeg: 67.5, endDeg: 112.5 },
  { id: 'third_man', label: 'Third Man', startDeg: 112.5, endDeg: 157.5 },
  { id: 'fine_leg', label: 'Fine Leg', startDeg: 157.5, endDeg: 202.5 },
  { id: 'square_leg', label: 'Square Leg', startDeg: 202.5, endDeg: 247.5 },
  { id: 'mid_wicket', label: 'Mid-Wicket', startDeg: 247.5, endDeg: 292.5 },
  { id: 'long_on', label: 'Long-On', startDeg: 292.5, endDeg: 337.5 }
];

function polarToCartesianWheel(cx, cy, r, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: cx + r * Math.cos(rad),
    y: cy + r * Math.sin(rad)
  };
}

function buildSectorWedgePath(cx, cy, rInner, rOuter, startDeg, endDeg) {
  const p1 = polarToCartesianWheel(cx, cy, rOuter, startDeg);
  const p2 = polarToCartesianWheel(cx, cy, rOuter, endDeg);
  const p3 = polarToCartesianWheel(cx, cy, rInner, endDeg);
  const p4 = polarToCartesianWheel(cx, cy, rInner, startDeg);
  const largeArc = (endDeg - startDeg) > 180 ? 1 : 0;
  return [
    `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`,
    `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`,
    `L ${p3.x.toFixed(1)} ${p3.y.toFixed(1)}`,
    `A ${rInner} ${rInner} 0 ${largeArc} 0 ${p4.x.toFixed(1)} ${p4.y.toFixed(1)}`,
    'Z'
  ].join(' ');
}

function previewRadialSectorHover(zoneId, label, midDeg) {
  const ray = document.getElementById('radialWheelPreviewRay');
  const txt = document.getElementById('radialWheelSelectedReadout');
  if (ray) {
    const endPt = polarToCartesianWheel(150, 150, 128, midDeg);
    ray.setAttribute('x2', endPt.x.toFixed(1));
    ray.setAttribute('y2', endPt.y.toFixed(1));
    ray.setAttribute('opacity', '1');
  }
  if (txt) {
    txt.textContent = `Selected: ${label}`;
  }
}

function openShotZonePickerModal(ballId, runs) {
  const cx = 150;
  const cy = 150;
  const rInner = 34;
  const rOuter = 136;
  const accentStroke = runs === 6 ? '#00e676' : '#38bdf8';

  const sectorsSVG = RADIAL_WHEEL_SECTORS.map((sec, idx) => {
    const pathD = buildSectorWedgePath(cx, cy, rInner, rOuter, sec.startDeg, sec.endDeg);
    const midDeg = (sec.startDeg + sec.endDeg) / 2;
    const lblPt = polarToCartesianWheel(cx, cy, 94, midDeg);
    const fillAlt = idx % 2 === 0 ? 'rgba(16, 185, 129, 0.14)' : 'rgba(16, 185, 129, 0.07)';
    return `
      <g onclick="assignShotZoneToBall('${ballId}', '${sec.id}')"
         onmouseenter="previewRadialSectorHover('${sec.id}', '${sec.label}', ${midDeg})">
        <path class="wagon-sector-wedge" d="${pathD}" fill="${fillAlt}" stroke="rgba(255,255,255,0.22)" stroke-width="1.3" />
        <text class="wagon-sector-label" x="${lblPt.x.toFixed(1)}" y="${lblPt.y.toFixed(1)}">${escapeHTML(sec.label)}</text>
      </g>
    `;
  }).join('');

  const html = `
    <div class="radial-wheel-modal-wrap">
      <div class="muted" style="font-size:11.5px; text-align:center;">
        Tap any slice of the ground where the <strong style="color:${accentStroke};">${runs}</strong> went:
      </div>
      <div class="radial-wheel-svg-box">
        <svg viewBox="0 0 300 300" aria-label="8-Zone Cricket Ground Wagon Wheel">
          <circle cx="150" cy="150" r="142" fill="#071f17" stroke="${accentStroke}" stroke-width="2.5" />
          ${sectorsSVG}
          <circle cx="150" cy="150" r="68" fill="none" stroke="rgba(255,255,255,0.18)" stroke-dasharray="4 4" pointer-events="none" />
          <line id="radialWheelPreviewRay" x1="150" y1="150" x2="150" y2="30" stroke="${accentStroke}" stroke-width="3.2" stroke-linecap="round" opacity="0" pointer-events="none" />
          <circle cx="150" cy="150" r="32" fill="#0b1714" stroke="rgba(255,255,255,0.24)" stroke-width="1.5" pointer-events="none" />
          <rect x="144" y="132" width="12" height="36" rx="2" fill="#d97706" pointer-events="none" />
          <text x="150" y="125" font-size="8" font-weight="900" fill="#94a3b8" text-anchor="middle" pointer-events="none">BOWLER</text>
          <text x="150" y="179" font-size="8" font-weight="900" fill="#94a3b8" text-anchor="middle" pointer-events="none">KEEPER</text>
        </svg>
      </div>
      <div class="radial-wheel-footer">
        <span id="radialWheelSelectedReadout" style="font-size:11.5px; font-weight:800; color:var(--primary);">Tap a ground slice</span>
        <button type="button" class="btn btn-secondary" style="padding:6px 12px; font-size:11.5px;" onclick="closeModal()">Skip Zone</button>
      </div>
    </div>
  `;
  openModal(`🎯 ${runs} Runs — Tap Ground Direction`, html, null, false);
}

async function assignShotZoneToBall(ballId, zoneId) {
  if (!activeMatch) return;
  const inn = activeMatch.innings[activeMatch.innings.length - 1];
  const ball = (inn?.balls || []).find(b => b.id === ballId);
  if (ball) {
    ball.shotZone = zoneId;
    await saveActiveMatch();
    const zObj = WAGON_WHEEL_ZONES.find(z => z.id === zoneId);
    showToast(`Recorded ${ball.batRuns} to ${zObj?.label || zoneId}`);
  }
  closeModal();
}

function buildMatchWagonWheelSVG(matchObj) {
  if (!matchObj || !Array.isArray(matchObj.innings)) return '';
  const zonedBalls = [];
  matchObj.innings.forEach(inn => {
    (inn.balls || []).forEach(b => {
      if (b.shotZone && (b.batRuns === 4 || b.batRuns === 6)) {
        zonedBalls.push(b);
      }
    });
  });
  if (!zonedBalls.length) return '';

  const zoneCounts = {};
  zonedBalls.forEach(b => {
    zoneCounts[b.shotZone] = (zoneCounts[b.shotZone] || 0) + b.batRuns;
  });
  const topZoneId = Object.keys(zoneCounts).sort((a, b) => zoneCounts[b] - zoneCounts[a])[0];
  const topZoneLabel = WAGON_WHEEL_ZONES.find(z => z.id === topZoneId)?.label || topZoneId;

  const linesSVG = zonedBalls.map((b, idx) => {
    const z = WAGON_WHEEL_ZONES.find(item => item.id === b.shotZone);
    if (!z) return '';
    const jitter = ((idx % 5) - 2) * 4;
    const rad = ((z.angleDeg + jitter - 90) * Math.PI) / 180;
    const len = b.batRuns === 6 ? 88 : 74;
    const x2 = (110 + Math.cos(rad) * len).toFixed(1);
    const y2 = (110 + Math.sin(rad) * len).toFixed(1);
    const stroke = b.batRuns === 6 ? '#00e676' : '#38bdf8';
    return `<line x1="110" y1="110" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="2.4" stroke-linecap="round" opacity="0.88" />
            <circle cx="${x2}" cy="${y2}" r="3.2" fill="${stroke}" />`;
  }).join('');

  return `
    <div class="card" style="margin-top:12px; padding:12px; text-align:center;">
      <div class="eyebrow" style="margin-bottom:4px;">🎯 BOUNDARY WAGON WHEEL (${zonedBalls.length} TAGGED SHOTS)</div>
      <div style="font-size:12px; font-weight:800; color:var(--primary); margin-bottom:8px;">Strongest Zone: ${escapeHTML(topZoneLabel)} (${zoneCounts[topZoneId]} runs)</div>
      <svg viewBox="0 0 220 220" width="210" height="210" style="max-width:100%; display:block; margin:0 auto;">
        <circle cx="110" cy="110" r="98" fill="rgba(16,185,129,0.12)" stroke="rgba(16,185,129,0.45)" stroke-width="2" />
        <circle cx="110" cy="110" r="54" fill="none" stroke="rgba(255,255,255,0.14)" stroke-dasharray="4 3" />
        <rect x="105" y="96" width="10" height="28" rx="2" fill="#d97706" />
        ${linesSVG}
      </svg>
      <div class="muted" style="font-size:11px; margin-top:6px;">
        <span style="color:#38bdf8; font-weight:800;">● 4s</span> &nbsp;·&nbsp; <span style="color:#00e676; font-weight:800;">● 6s</span>
      </div>
    </div>
  `;
}

// ==========================================
// CO-SCORER 4-DIGIT HANDOVER PIN
// ==========================================
async function openCoScorerPinModal() {
  if (!activeMatch) return;
  if (!activeMatch.handoverPin) {
    activeMatch.handoverPin = String(Math.floor(1000 + Math.random() * 9000));
    await saveActiveMatch();
  }
  if (currentCloudUser) {
    await pushSingleMatchToCloud(activeMatch);
  }

  const shareUrl = `${window.location.origin}${window.location.pathname}#watch=${encodeURIComponent(activeMatch.id)}`;
  const html = `
    <div>
      <div class="handover-pin-box">
        <div class="eyebrow" style="margin:0;">4-DIGIT CO-SCORER HANDOVER PIN</div>
        <div class="handover-pin-digits">${activeMatch.handoverPin}</div>
        <div class="muted" style="font-size:11.5px;">Share this PIN with a teammate on the field so they can claim live scoring control on their phone.</div>
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
        <button type="button" class="btn btn-secondary" onclick="regenerateCoScorerPin()">🔄 New PIN</button>
        <button type="button" class="btn btn-primary" onclick="copyCoScorerInvite('${shareUrl}', '${activeMatch.handoverPin}')">📋 Copy Invite</button>
      </div>
    </div>
  `;
  openModal('Co-Scorer Handover', html, null, false);
}

async function regenerateCoScorerPin() {
  if (!activeMatch) return;
  activeMatch.handoverPin = String(Math.floor(1000 + Math.random() * 9000));
  await saveActiveMatch();
  if (currentCloudUser) await pushSingleMatchToCloud(activeMatch);
  closeModal();
  openCoScorerPinModal();
}

function copyCoScorerInvite(url, pin) {
  const msg = `🏏 Co-Scorer Handover for ${activeMatch?.title || 'Live Match'}\n1. Open Live Match: ${url}\n2. Tap "🔑 Co-Scorer PIN" and enter PIN: ${pin}`;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(msg).then(() => showToast('Co-Scorer invite & PIN copied!'));
  } else {
    prompt('Copy Co-Scorer invite:', msg);
  }
}

async function openClaimCoScorerModal(matchId) {
  const html = `
    <div>
      <p class="muted" style="font-size:12px; margin-bottom:10px;">Enter the 4-digit Handover PIN shown on the primary scorer's phone to take over live scoring for this match.</p>
      <div class="form-group">
        <label>4-Digit Match PIN *</label>
        <input type="text" id="claimPinInput" maxlength="4" inputmode="numeric" placeholder="e.g. 4829" style="font-size:20px; text-align:center; letter-spacing:6px; font-weight:900;">
      </div>
    </div>
  `;

  openModal('Claim Co-Scorer Control', html, async () => {
    const entered = (document.getElementById('claimPinInput')?.value || '').trim();
    if (!/^\d{4}$/.test(entered)) {
      alert('Please enter the 4-digit numeric PIN.');
      return false;
    }

    let targetMatch = spectatorMatchData?.match_json || null;
    if (!targetMatch && sbClient) {
      const { data } = await sbClient.from('matches').select('match_json').eq('id', matchId).maybeSingle();
      targetMatch = data?.match_json || null;
    }

    if (!targetMatch || !targetMatch.handoverPin) {
      alert('The primary scorer has not generated a Handover PIN for this match yet.');
      return false;
    }

    if (entered !== String(targetMatch.handoverPin)) {
      alert('Incorrect PIN. Check the 4-digit PIN on the primary scorer screen.');
      return false;
    }

    await dbPut('matches', targetMatch);
    activeMatch = targetMatch;
    if (spectatorRealtimeChannel && sbClient) {
      sbClient.removeChannel(spectatorRealtimeChannel);
      spectatorRealtimeChannel = null;
    }
    spectatorWatchMatchId = null;
    showToast('✅ Co-Scorer control claimed! You can now score deliveries.');
    navigate('live-scorer');
    return true;
  });
}

// ==========================================
// DLS / RAIN-CURTAILED OVERS & TARGET REVISION
// ==========================================
function openDlsRevisionModal() {
  if (!activeMatch) return;
  const curOvers = activeMatch.overs || 20;
  const inn1 = activeMatch.innings?.[0];
  const inn1Runs = inn1 ? CricketEngine.calculateInnings(inn1, inn1.squad, inn1.bowlingSquad).totalRuns : 0;
  const curTarget = activeMatch.target || (inn1Runs ? inn1Runs + 1 : '');

  const html = `
    <div>
      <p class="muted" style="font-size:12px; margin-bottom:10px;">Adjust total match overs (e.g., rain or fading light) and set a revised DLS target.</p>
      <div class="field-grid" style="margin-bottom:10px;">
        <div class="form-group">
          <label>Revised Overs Per Side *</label>
          <input type="number" id="dlsRevisedOvers" min="1" max="50" value="${curOvers}" oninput="recalcDlsSuggestion(${curOvers}, ${inn1Runs})">
        </div>
        <div class="form-group">
          <label>Target Runs ${activeMatch.innings.length < 2 ? '(1st Inn)' : '*'}</label>
          <input type="number" id="dlsRevisedTarget" min="1" value="${curTarget}" ${activeMatch.innings.length < 2 ? 'placeholder="Auto after 1st inn"' : ''}>
        </div>
      </div>
      <div id="dlsSuggestionNote" class="muted" style="font-size:11.5px;"></div>
    </div>
  `;

  openModal('🌧️ DLS / Revise Match Overs & Target', html, async () => {
    const newOvers = Math.max(1, parseInt(document.getElementById('dlsRevisedOvers')?.value || String(curOvers), 10));
    const targetRaw = (document.getElementById('dlsRevisedTarget')?.value || '').trim();
    activeMatch.overs = newOvers;
    if (activeMatch.innings.length >= 2 && targetRaw) {
      activeMatch.target = Math.max(1, parseInt(targetRaw, 10));
    }
    await saveActiveMatch();
    showToast(`Match revised to ${newOvers} overs${activeMatch.target ? ` · Target ${activeMatch.target}` : ''}`);
    renderLiveScorerView();
    return true;
  });
}

function recalcDlsSuggestion(origOvers, inn1Runs) {
  const newOv = parseInt(document.getElementById('dlsRevisedOvers')?.value || '0', 10);
  const noteEl = document.getElementById('dlsSuggestionNote');
  const targetInput = document.getElementById('dlsRevisedTarget');
  if (!newOv || !origOvers || !inn1Runs || !noteEl) return;
  const proRataTarget = Math.max(1, Math.round((inn1Runs * newOv) / origOvers) + 1);
  noteEl.innerHTML = `Suggested pro-rata DLS target for ${newOv} overs: <strong>${proRataTarget} runs</strong>`;
  if (targetInput && activeMatch?.innings?.length >= 2) {
    targetInput.value = proRataTarget;
  }
}

// ==========================================
// SMART IN-APP PWA INSTALL & ANDROID APK GUIDE ($0 FREE)
// ==========================================
let deferredPwaInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPwaInstallPrompt = e;
  try {
    if (localStorage.getItem('cricscorer_pwa_banner_dismissed') === '1') return;
  } catch (err) {}
  const banner = document.getElementById('pwaInstallBanner');
  if (banner) banner.style.display = 'flex';
});

window.addEventListener('appinstalled', () => {
  deferredPwaInstallPrompt = null;
  const banner = document.getElementById('pwaInstallBanner');
  if (banner) banner.style.display = 'none';
  showToast('🎉 CricScorer installed on your home screen!');
});

function dismissPwaInstallBanner() {
  const banner = document.getElementById('pwaInstallBanner');
  if (banner) banner.style.display = 'none';
  try {
    localStorage.setItem('cricscorer_pwa_banner_dismissed', '1');
  } catch (e) {}
}

async function triggerPwaInstallPrompt() {
  if (deferredPwaInstallPrompt) {
    deferredPwaInstallPrompt.prompt();
    const choice = await deferredPwaInstallPrompt.userChoice;
    if (choice?.outcome === 'accepted') {
      dismissPwaInstallBanner();
    }
    deferredPwaInstallPrompt = null;
    return;
  }

  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const msg = isIos
    ? 'To install CricScorer on iPhone/iPad:\n\n1. Tap the Share button (□↑) at the bottom of Safari.\n2. Scroll down and tap "Add to Home Screen".'
    : 'To install CricScorer as a full-screen app:\n\n1. Open your browser menu (⋮ in Chrome/Edge).\n2. Tap "Install app" or "Add to Home screen".';
  alert(msg);
}

function openAndroidApkGuideModal() {
  const liveUrl = window.location.origin + window.location.pathname;
  const html = `
    <div style="font-size:12.5px; line-height:1.55;">
      <p style="margin-bottom:8px;">You can generate a free, standalone Android <code>.apk</code> package for <strong>CricScorer</strong> in 2 minutes with <strong>$0 fees</strong> using Microsoft's open-source <strong>PWABuilder</strong>:</p>
      <ol style="padding-left:18px; display:flex; flex-direction:column; gap:6px; margin-bottom:12px;">
        <li>Copy your live URL: <code>${escapeHTML(liveUrl)}</code></li>
        <li>Open <strong>pwabuilder.com</strong> in your desktop browser and paste your URL.</li>
        <li>Click <strong>Package for Stores → Android → Generate Package</strong> (select <em>Signing Key: New</em>).</li>
        <li>Download the ZIP containing your signed <code>.apk</code> and share it directly in your cricket club WhatsApp group!</li>
      </ol>
      <button type="button" class="btn btn-primary" style="width:100%;" onclick="navigator.clipboard?.writeText('${liveUrl}').then(() => showToast('Live PWA URL copied!'))">📋 Copy Live App URL</button>
    </div>
  `;
  openModal('📦 Free Android APK Packaging Guide ($0)', html, null, false);
}


// ==========================================
// V2.36: CUSTOM GROUND RULES (ADD / EDIT / TOGGLE), FREE HIT, OBS OVERLAY & PLAYER CAREER
// ==========================================
const CUSTOM_RULES_STORAGE_KEY = 'cricscorer_custom_ground_rules_v1';

const DEFAULT_CUSTOM_GROUND_RULES = [
  {
    id: 'rule_last_man',
    name: 'Last Man Stands (1-Batter Rule)',
    desc: '9th wicket down keeps last batter batting solo with strike retention.',
    effectType: 'last_man',
    runsDelta: 0,
    enabled: false
  },
  {
    id: 'rule_box_bonus',
    name: 'Box Roof / Back-Wall Bonus',
    desc: 'Award +2 bonus runs when ball hits designated box wall.',
    effectType: 'add_runs',
    runsDelta: 2,
    enabled: false
  },
  {
    id: 'rule_wicket_penalty',
    name: 'Wicket Run Penalty (-3 Runs)',
    desc: 'Deduct 3 runs from batting total whenever a wicket falls.',
    effectType: 'wicket_penalty',
    runsDelta: -3,
    enabled: false
  }
];

function loadCustomGroundRules() {
  try {
    const raw = localStorage.getItem(CUSTOM_RULES_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) {}
  return JSON.parse(JSON.stringify(DEFAULT_CUSTOM_GROUND_RULES));
}

function saveCustomGroundRules(rulesList) {
  try {
    localStorage.setItem(CUSTOM_RULES_STORAGE_KEY, JSON.stringify(rulesList));
  } catch (e) {}
}

function getActiveCustomGroundRules() {
  return loadCustomGroundRules().filter(r => !!r.enabled);
}

function isLastManStandsEnabled() {
  return getActiveCustomGroundRules().some(r => r.effectType === 'last_man');
}

function buildFreeHitBannerHTML(inn) {
  if (!inn || !Array.isArray(inn.balls) || !inn.balls.length) return '';
  const lastBall = inn.balls[inn.balls.length - 1];
  if (lastBall && lastBall.extraType === 'noBall') {
    return `
      <div class="free-hit-banner">
        <span>🔥 FREE HIT ACTIVE — Next Delivery</span>
        <span style="font-size:10px; opacity:0.92;">Run Out / Stumped Only</span>
      </div>
    `;
  }
  return '';
}

function buildActiveRuleQuickTriggersHTML() {
  const activeRunRules = getActiveCustomGroundRules().filter(r => r.effectType === 'add_runs' || r.effectType === 'deduct_runs');
  if (!activeRunRules.length) return '';
  return `
    <div class="active-rules-trigger-bar">
      ${activeRunRules.map(r => {
        const delta = Number(r.runsDelta) || 0;
        const isPenalty = delta < 0 || r.effectType === 'deduct_runs';
        const signed = delta >= 0 ? `+${delta}` : `${delta}`;
        return `<button type="button" class="rule-quick-btn ${isPenalty ? 'penalty' : ''}" onclick="applyCustomGroundRuleAction('${r.id}')">⚡ ${escapeHTML(r.name)} (${signed})</button>`;
      }).join('')}
    </div>
  `;
}

async function applyCustomGroundRuleAction(ruleId) {
  if (!activeMatch) return;
  const rule = loadCustomGroundRules().find(r => r.id === ruleId);
  if (!rule) return;
  const inn = activeMatch.innings[activeMatch.innings.length - 1];
  const delta = Number(rule.runsDelta) || 0;

  inn.balls.push({
    id: generateId(),
    batterId: inn.strikerId || null,
    nonStrikerId: inn.nonStrikerId || null,
    bowlerId: inn.bowlerId || null,
    batRuns: 0,
    extraType: 'penalty',
    extraRuns: delta,
    extraTotal: delta,
    wicket: false,
    dismissal: 'none',
    customRuleLabel: rule.name,
    timestamp: Date.now()
  });

  await saveActiveMatch();
  showToast(`⚡ Applied "${rule.name}" (${delta >= 0 ? '+' : ''}${delta} runs)`);
  renderLiveScorerView();
}

function openCustomGroundRulesModal() {
  const rules = loadCustomGroundRules();
  const effectLabels = {
    last_man: 'Last Man Stands',
    add_runs: 'Bonus Runs (+)',
    deduct_runs: 'Penalty Runs (-)',
    wicket_penalty: 'Wicket Penalty (-)',
    note: 'Umpire Note'
  };

  const html = `
    <div>
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:10px;">
        <p class="muted" style="font-size:11.5px; margin:0;">Toggle local gully/box rules ON or OFF, or create your own custom ground rules.</p>
        <button type="button" class="btn btn-primary" style="padding:6px 10px; font-size:11px; white-space:nowrap;" onclick="openAddOrEditGroundRuleModal(null)">＋ Add Rule</button>
      </div>

      <div style="max-height:330px; overflow-y:auto;">
        ${rules.map(r => {
          const deltaBadge = (r.effectType === 'add_runs' || r.effectType === 'deduct_runs' || r.effectType === 'wicket_penalty')
            ? ` (${Number(r.runsDelta) >= 0 ? '+' : ''}${r.runsDelta} runs)`
            : '';
          return `
            <div class="custom-rule-row ${r.enabled ? 'enabled' : ''}">
              <div style="min-width:0; flex:1;">
                <div style="font-size:12.5px; font-weight:900;">${escapeHTML(r.name)}</div>
                <div class="muted" style="font-size:11px;">${escapeHTML(r.desc || '')}</div>
                <div style="font-size:10px; font-weight:800; color:var(--primary); margin-top:2px;">${effectLabels[r.effectType] || 'Custom'}${deltaBadge}</div>
              </div>
              <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
                <button type="button" class="icon-btn" style="width:28px; height:28px; font-size:13px;" onclick="openAddOrEditGroundRuleModal('${r.id}')" title="Edit Rule">✏️</button>
                <button type="button" class="icon-btn" style="width:28px; height:28px; font-size:13px; color:var(--danger);" onclick="deleteCustomGroundRule('${r.id}')" title="Delete Rule">🗑️</button>
                <label class="switch" aria-label="Toggle ${escapeHTML(r.name)}">
                  <input type="checkbox" ${r.enabled ? 'checked' : ''} onchange="toggleCustomGroundRuleEnabled('${r.id}', this.checked)">
                  <span class="slider"></span>
                </label>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;

  openModal('⚡ Custom Gully / Box Ground Rules', html, null, false);
}

function toggleCustomGroundRuleEnabled(ruleId, enabled) {
  const rules = loadCustomGroundRules();
  const target = rules.find(r => r.id === ruleId);
  if (!target) return;
  target.enabled = !!enabled;
  saveCustomGroundRules(rules);
  showToast(`${target.name}: ${target.enabled ? 'ON' : 'OFF'}`);
  if (document.getElementById('live-scorer')?.classList.contains('active')) {
    renderLiveScorerView();
  }
  openCustomGroundRulesModal();
}

function deleteCustomGroundRule(ruleId) {
  if (!confirm('Delete this custom ground rule?')) return;
  const rules = loadCustomGroundRules().filter(r => r.id !== ruleId);
  saveCustomGroundRules(rules);
  showToast('Custom rule deleted');
  if (document.getElementById('live-scorer')?.classList.contains('active')) {
    renderLiveScorerView();
  }
  openCustomGroundRulesModal();
}

function openAddOrEditGroundRuleModal(ruleId = null) {
  const rules = loadCustomGroundRules();
  const existing = ruleId ? rules.find(r => r.id === ruleId) : null;
  const curType = existing?.effectType || 'add_runs';
  const curDelta = existing ? existing.runsDelta : 2;

  const html = `
    <div>
      <div class="form-group" style="margin-bottom:10px;">
        <label>Rule Title *</label>
        <input type="text" id="cgrNameInput" value="${escapeHTML(existing?.name || '')}" placeholder="e.g. One-Tip One-Hand Out or Roof +4">
      </div>
      <div class="field-grid" style="margin-bottom:10px;">
        <div class="form-group">
          <label>Rule Action Type</label>
          <select id="cgrTypeInput">
            <option value="add_runs" ${curType === 'add_runs' ? 'selected' : ''}>Add Bonus Runs (+Runs)</option>
            <option value="deduct_runs" ${curType === 'deduct_runs' ? 'selected' : ''}>Deduct Penalty Runs (-Runs)</option>
            <option value="wicket_penalty" ${curType === 'wicket_penalty' ? 'selected' : ''}>Wicket Run Penalty (-Runs on Out)</option>
            <option value="last_man" ${curType === 'last_man' ? 'selected' : ''}>Last Man Stands (Solo 9th-Wkt)</option>
            <option value="note" ${curType === 'note' ? 'selected' : ''}>Custom Ground Note / Umpire Rule</option>
          </select>
        </div>
        <div class="form-group">
          <label>Run Value (if applicable)</label>
          <input type="number" id="cgrDeltaInput" value="${curDelta}" placeholder="e.g. 2 or -3">
        </div>
      </div>
      <div class="form-group" style="margin-bottom:10px;">
        <label>Rule Description</label>
        <input type="text" id="cgrDescInput" value="${escapeHTML(existing?.desc || '')}" placeholder="Short explanation shown to scorers">
      </div>
      <label class="checklist-item" style="cursor:pointer; padding:4px 0;">
        <input type="checkbox" id="cgrEnabledInput" ${existing ? (existing.enabled ? 'checked' : '') : 'checked'} style="width:16px; height:16px; accent-color:var(--primary);">
        <span>Enable rule immediately</span>
      </label>
    </div>
  `;

  openModal(existing ? '✏️ Edit Custom Ground Rule' : '＋ Add Custom Ground Rule', html, async () => {
    const name = (document.getElementById('cgrNameInput')?.value || '').trim();
    if (!name) {
      alert('Please enter a rule title.');
      return false;
    }
    const effectType = document.getElementById('cgrTypeInput')?.value || 'note';
    let runsDelta = parseInt(document.getElementById('cgrDeltaInput')?.value || '0', 10) || 0;
    if ((effectType === 'deduct_runs' || effectType === 'wicket_penalty') && runsDelta > 0) {
      runsDelta = -runsDelta;
    }
    const desc = (document.getElementById('cgrDescInput')?.value || '').trim();
    const enabled = !!document.getElementById('cgrEnabledInput')?.checked;

    const list = loadCustomGroundRules();
    if (existing) {
      const idx = list.findIndex(r => r.id === existing.id);
      if (idx !== -1) list[idx] = { ...list[idx], name, effectType, runsDelta, desc, enabled };
    } else {
      list.push({ id: 'rule_' + generateId(), name, effectType, runsDelta, desc, enabled });
    }
    saveCustomGroundRules(list);
    showToast(existing ? 'Custom rule updated!' : 'Custom ground rule added!');
    if (document.getElementById('live-scorer')?.classList.contains('active')) {
      renderLiveScorerView();
    }
    setTimeout(() => openCustomGroundRulesModal(), 60);
    return true;
  });
}

// Enhance openWicketModal: enforce Free Hit dismissal rules & apply Wicket Run Penalty if enabled
const _origOpenWicketModalV36 = openWicketModal;
openWicketModal = function() {
  _origOpenWicketModalV36();
  if (!activeMatch) return;
  const inn = activeMatch.innings[activeMatch.innings.length - 1];
  const lastBall = inn?.balls?.[inn.balls.length - 1];
  const isFreeHit = !!(lastBall && lastBall.extraType === 'noBall');
  const typeSel = document.getElementById('wfType');
  if (isFreeHit && typeSel) {
    const blockedOnFreeHit = new Set(['caught', 'bowled', 'lbw', 'caughtAndBowled', 'hitWicket']);
    Array.from(typeSel.options).forEach(opt => {
      if (blockedOnFreeHit.has(opt.value)) {
        opt.disabled = true;
        opt.textContent += ' (Blocked on Free Hit)';
      }
    });
    typeSel.value = 'runOut';
    if (typeof onDismissalTypeChange === 'function') onDismissalTypeChange('runOut');
  }

  // Apply Wicket Run Penalty automatically when modal confirms if enabled
  const confirmBtn = document.getElementById('modalConfirmBtn');
  if (confirmBtn) {
    const prevOnclick = confirmBtn.onclick;
    confirmBtn.onclick = async function(ev) {
      const preWkts = inn.balls.filter(b => b.wicket).length;
      const res = prevOnclick ? await prevOnclick.call(this, ev) : true;
      const postWkts = inn.balls.filter(b => b.wicket).length;
      if (postWkts > preWkts) {
        const wktPenaltyRule = getActiveCustomGroundRules().find(r => r.effectType === 'wicket_penalty' && Number(r.runsDelta) !== 0);
        if (wktPenaltyRule) {
          const delta = Number(wktPenaltyRule.runsDelta);
          inn.balls.push({
            id: generateId(),
            batterId: inn.strikerId || null,
            nonStrikerId: inn.nonStrikerId || null,
            bowlerId: inn.bowlerId || null,
            batRuns: 0,
            extraType: 'penalty',
            extraRuns: delta,
            extraTotal: delta,
            wicket: false,
            dismissal: 'none',
            customRuleLabel: wktPenaltyRule.name,
            timestamp: Date.now()
          });
          await saveActiveMatch();
          showToast(`⚡ ${wktPenaltyRule.name}: ${delta} runs applied`);
          renderLiveScorerView();
        }
      }
      return res;
    };
  }
};

// ==========================================
// TRANSPARENT YOUTUBE / OBS BROADCAST SCOREBOARD OVERLAY (#overlay=<matchId>)
// ==========================================
let obsOverlayMatchId = null;
let obsOverlayChannel = null;

function copyObsOverlayUrl(matchId) {
  const url = `${window.location.origin}${window.location.pathname}#overlay=${encodeURIComponent(matchId)}`;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(() => {
      alert(`📺 Transparent YouTube / OBS Browser Source URL copied!

${url}

Paste this URL as a Browser Source (1280x720) in OBS Studio or PRISM Live Studio for a transparent TV-style lower-third scoreboard.`);
    });
  } else {
    prompt('Copy OBS / YouTube Overlay URL:', url);
  }
}

async function renderBroadcastOverlayView() {
  const stage = document.getElementById('obsOverlayStage');
  if (!stage) return;

  let matchRow = null;
  if (sbClient && navigator.onLine && obsOverlayMatchId) {
    const { data } = await sbClient.from('matches').select('*').eq('id', obsOverlayMatchId).maybeSingle();
    if (data) matchRow = data;
  }

  if (!matchRow && db && obsOverlayMatchId) {
    const localMatches = await dbGetAll('matches');
    const found = localMatches.find(m => m.id === obsOverlayMatchId);
    if (found) matchRow = { id: found.id, status: found.status, match_json: found };
  }

  if (!matchRow) {
    stage.innerHTML = `<div class="obs-score-bug">Waiting for live match broadcast (#overlay)...</div>`;
    return;
  }

  paintObsOverlayBug(matchRow);

  if (sbClient && !obsOverlayChannel && obsOverlayMatchId) {
    obsOverlayChannel = sbClient
      .channel('obs-overlay-' + obsOverlayMatchId)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'matches',
        filter: `id=eq.${obsOverlayMatchId}`
      }, (payload) => {
        if (payload.new) paintObsOverlayBug(payload.new);
      })
      .subscribe();
  }
}

function paintObsOverlayBug(row) {
  const stage = document.getElementById('obsOverlayStage');
  if (!stage || !row) return;
  const m = row.match_json || {};
  const inn = (m.innings || [])[m.innings.length - 1];
  if (!inn) return;

  const st = CricketEngine.calculateInnings(inn, inn.squad || [], inn.bowlingSquad || []);
  const batName = inn.batting === m.a ? (m.teamAName || 'BAT') : (m.teamBName || 'BAT');
  const bowlName = inn.bowling === m.a ? (m.teamAName || 'BOWL') : (m.teamBName || 'BOWL');
  const striker = st.batters.find(b => b.id === inn.strikerId);
  const nonStriker = st.batters.find(b => b.id === inn.nonStrikerId);
  const bowler = st.bowlers.find(b => b.id === inn.bowlerId);
  const targetNote = m.target ? ` · TARGET ${m.target}` : '';

  stage.innerHTML = `
    <div class="obs-score-bug">
      <div class="obs-team-pill">
        <div>
          <div style="font-size:11px; font-weight:900; letter-spacing:0.6px; color:#94a3b8;">${escapeHTML(batName.toUpperCase())} vs ${escapeHTML(bowlName.toUpperCase())}${targetNote}</div>
          <div class="obs-score-main">${st.totalRuns}/${st.wickets} <span class="obs-overs-tag">(${st.oversFormatted}/${m.overs || 20} ov)</span></div>
        </div>
      </div>

      <div class="obs-crease-strip">
        <div>▶ <strong>${escapeHTML(striker?.name || 'Striker')}</strong> ${striker?.runs ?? 0} (${striker?.balls ?? 0})</div>
        <div>${escapeHTML(nonStriker?.name || 'Non-Striker')} ${nonStriker?.runs ?? 0} (${nonStriker?.balls ?? 0})</div>
      </div>

      <div class="obs-bowler-col">
        <div style="color:#38bdf8;">⚡ ${escapeHTML(bowler?.name || 'Bowler')}</div>
        <div>${bowler?.wickets ?? 0}-${bowler?.runsConceded ?? 0} (${bowler?.oversFormatted ?? '0.0'})</div>
      </div>
    </div>
  `;
}

// ==========================================
// DUPLICATE PLAYER MERGE & 1080x1080 CAREER STATS POSTER
// ==========================================
async function openDuplicatePlayerMergeModal() {
  const players = await dbGetAll('players');
  if (players.length < 2) {
    alert('You need at least 2 players in your registry to merge duplicates.');
    return;
  }

  players.sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
  const optionsHTML = players.map(p => `<option value="${p.id}">${escapeHTML(p.name)} (${escapeHTML(p.role || 'Batter')})</option>`).join('');

  const html = `
    <div>
      <p class="muted" style="font-size:12px; margin-bottom:10px;">Merge a duplicate player profile into a primary player without losing any historical runs, wickets, or match appearances.</p>
      <div class="form-group" style="margin-bottom:10px;">
        <label>Keep Primary Player *</label>
        <select id="mergeKeepPlayerSel">${optionsHTML}</select>
      </div>
      <div class="form-group" style="margin-bottom:10px;">
        <label>Merge &amp; Remove Duplicate Player *</label>
        <select id="mergeDropPlayerSel">${optionsHTML}</select>
      </div>
    </div>
  `;

  openModal('🔀 Merge Duplicate Players', html, async () => {
    const keepId = document.getElementById('mergeKeepPlayerSel')?.value;
    const dropId = document.getElementById('mergeDropPlayerSel')?.value;
    if (!keepId || !dropId || keepId === dropId) {
      alert('Select two different players to merge.');
      return false;
    }

    const [allPlayers, allTeams, allMatches] = await Promise.all([
      dbGetAll('players'),
      dbGetAll('teams'),
      dbGetAll('matches')
    ]);
    const keepPlayer = allPlayers.find(p => p.id === keepId);
    const dropPlayer = allPlayers.find(p => p.id === dropId);
    if (!keepPlayer || !dropPlayer) return false;

    if (!confirm(`Merge "${dropPlayer.name}" into "${keepPlayer.name}"? All historical stats will be transferred to "${keepPlayer.name}".`)) {
      return false;
    }

    for (const tm of allTeams) {
      if (Array.isArray(tm.playerIds) && tm.playerIds.includes(dropId)) {
        tm.playerIds = Array.from(new Set(tm.playerIds.map(id => (id === dropId ? keepId : id))));
        await dbPut('teams', tm);
      }
    }

    for (const m of allMatches) {
      let changed = false;
      (m.innings || []).forEach(inn => {
        if (inn.strikerId === dropId) { inn.strikerId = keepId; changed = true; }
        if (inn.nonStrikerId === dropId) { inn.nonStrikerId = keepId; changed = true; }
        if (inn.bowlerId === dropId) { inn.bowlerId = keepId; changed = true; }
        ['squad', 'bowlingSquad'].forEach(key => {
          if (Array.isArray(inn[key])) {
            inn[key].forEach(sp => {
              if (sp.id === dropId) {
                sp.id = keepId;
                sp.name = keepPlayer.name;
                changed = true;
              }
            });
          }
        });
        (inn.balls || []).forEach(b => {
          if (b.batterId === dropId) { b.batterId = keepId; changed = true; }
          if (b.nonStrikerId === dropId) { b.nonStrikerId = keepId; changed = true; }
          if (b.bowlerId === dropId) { b.bowlerId = keepId; changed = true; }
          if (b.wicketPlayerId === dropId) { b.wicketPlayerId = keepId; changed = true; }
          if (b.dismissalDetails?.fielderId === dropId) { b.dismissalDetails.fielderId = keepId; changed = true; }
        });
      });
      if (changed) await dbPut('matches', m);
    }

    await dbDelete('players', dropId);
    showToast(`🔀 Merged "${dropPlayer.name}" into "${keepPlayer.name}"!`);
    renderPlayers();
    return true;
  });
}

async function generatePlayerCareerPosterModal(playerId) {
  const [players, careerMap] = await Promise.all([dbGetAll('players'), computeAllPlayersCareerMap()]);
  const player = players.find(p => p.id === playerId);
  if (!player) return;
  const c = careerMap[playerId] || { matches: 0, runs: 0, balls: 0, highScore: 0, wickets: 0, legalBalls: 0, runsConceded: 0, bestW: 0, bestR: 0 };
  const sr = c.balls > 0 ? ((c.runs / c.balls) * 100).toFixed(1) : '0.0';
  const econ = c.legalBalls > 0 ? ((c.runsConceded / c.legalBalls) * 6).toFixed(2) : '0.00';

  const canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 1080;
  const ctx = canvas.getContext('2d');

  const grad = ctx.createLinearGradient(0, 0, 1080, 1080);
  grad.addColorStop(0, '#04120d');
  grad.addColorStop(0.55, '#0b2b20');
  grad.addColorStop(1, '#04141c');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1080, 1080);

  ctx.strokeStyle = 'rgba(0, 230, 118, 0.45)';
  ctx.lineWidth = 6;
  ctx.strokeRect(36, 36, 1008, 1008);

  ctx.fillStyle = '#00e676';
  ctx.font = '900 30px system-ui, sans-serif';
  ctx.fillText('CRICSCORER CAREER CARD', 84, 115);

  ctx.fillStyle = '#ffffff';
  ctx.font = '900 72px system-ui, sans-serif';
  ctx.fillText(player.name.toUpperCase().slice(0, 20), 84, 215);

  ctx.fillStyle = '#94a3b8';
  ctx.font = '700 32px system-ui, sans-serif';
  ctx.fillText(`${player.role || 'All-Rounder'} · ${c.matches} Matches Played`, 84, 268);

  const tiles = [
    { label: 'CAREER RUNS', val: String(c.runs), accent: '#00e676' },
    { label: 'HIGH SCORE', val: String(c.highScore), accent: '#38bdf8' },
    { label: 'STRIKE RATE', val: sr, accent: '#fbbf24' },
    { label: 'WICKETS', val: String(c.wickets), accent: '#f43f5e' },
    { label: 'ECONOMY', val: econ, accent: '#a855f7' },
    { label: 'MATCHES', val: String(c.matches), accent: '#34d399' }
  ];

  tiles.forEach((t, idx) => {
    const col = idx % 2;
    const row = Math.floor(idx / 2);
    const x = 84 + col * 470;
    const y = 330 + row * 195;
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(x, y, 442, 168);
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, 442, 168);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '800 24px system-ui, sans-serif';
    ctx.fillText(t.label, x + 28, y + 52);

    ctx.fillStyle = t.accent;
    ctx.font = '900 66px system-ui, sans-serif';
    ctx.fillText(t.val, x + 28, y + 132);
  });

  ctx.fillStyle = '#64748b';
  ctx.font = '700 26px system-ui, sans-serif';
  ctx.fillText('Generated with CricScorer · Live Cricket & Tournament Hub', 84, 995);

  const dataUrl = canvas.toDataURL('image/png');
  const html = `
    <div style="text-align:center;">
      <img src="${dataUrl}" alt="${escapeHTML(player.name)} Career Card" style="width:100%; max-width:340px; border-radius:14px; border:1px solid var(--border); margin-bottom:10px;" />
      <div>
        <a href="${dataUrl}" download="${escapeHTML(player.name.replace(/\s+/g, '_'))}_Career_Card.png" class="btn btn-primary" style="display:inline-block; text-decoration:none; width:100%;">⬇️ Download 1080×1080 Career PNG</a>
      </div>
    </div>
  `;
  openModal(`🪪 ${player.name} — Career Stats Card`, html, null, false);
}
