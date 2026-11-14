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

function navigate(tabId) {
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === tabId));
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.nav === tabId));

  window.scrollTo({ top: 0, behavior: 'smooth' });

  if (tabId === 'dashboard') renderDashboard();
  if (tabId === 'live-scorer') renderLiveScorerView();
  if (tabId === 'create-match') renderCreateMatchView();
  if (tabId === 'teams') renderTeams();
  if (tabId === 'players') renderPlayers();
  if (tabId === 'history') renderHistory();
  if (tabId === 'statistics') renderStatistics();
  if (tabId === 'settings') renderSettings();
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
        ${m.status === 'Completed' ? `<button class="btn btn-secondary" style="font-size:12px; padding:7px 12px;" onclick="viewDetailedScorecard('${m.id}')">Scorecard</button>` : ''}
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

async function renderPlayers() {
  const players = await dbGetAll('players');
  const container = document.getElementById('playersContainer');
  const search = (document.getElementById('playerSearchInput')?.value || '').toLowerCase();
  const roleFilter = document.getElementById('playerRoleFilter')?.value || '';

  let filtered = players.filter(p => {
    const matchName = (p.name || '').toLowerCase().includes(search);
    const matchRole = !roleFilter || p.role === roleFilter;
    return matchName && matchRole;
  });

  // Sort players alphabetically A-Z
  filtered.sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));

  if (!filtered.length) {
    container.className = 'stack-list empty-state';
    container.textContent = 'No players found matching criteria. Tap "+ Add Player" to add players.';
    return;
  }

  container.className = 'stack-list';
  container.innerHTML = filtered.map(p => `
    <div class="player-item">
      <div class="item-info">
        <h3>${escapeHTML(p.name)}</h3>
        <p>Role: <strong>${escapeHTML(p.role || 'Batter')}</strong> · ${escapeHTML(p.battingStyle || 'Right-hand bat')}</p>
      </div>
      <div class="item-actions">
        <button class="btn btn-secondary" onclick="openPlayerModal('${p.id}')">Edit</button>
        <button class="btn btn-outline" onclick="deletePlayerPrompt('${p.id}')">Remove</button>
      </div>
    </div>
  `).join('');
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

  // Current over balls (last deliveries of current over)
  const recentBalls = inn.balls.slice(-8);

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
        <span class="scorer-live-pill"><span class="scorer-live-dot"></span> ${escapeHTML(activeMatch.status.toUpperCase())}</span>
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

      <div class="hlh-metrics-strip">
        <div class="hlh-m-cell"><span>CRR</span><strong>${crr}</strong></div>
        <div class="hlh-m-cell"><span>RRR</span><strong>${rrr}</strong></div>
        <div class="hlh-m-cell"><span>Target</span><strong>${activeMatch.target || '--'}</strong></div>
        <div class="hlh-m-cell"><span>Runs Req.</span><strong>${runsReq}</strong></div>
        <div class="hlh-m-cell"><span>Balls Rem.</span><strong>${ballsRem}</strong></div>
      </div>

      <div class="scorer-phase-strip">${phaseLabel}</div>
      ${winProbHTML}
    </div>

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
            <td><span class="striker-indicator">★</span> <strong>${escapeHTML(striker?.name || 'Striker')}</strong></td>
            <td><strong>${strikerStats.runs}</strong></td>
            <td>${strikerStats.balls}</td>
            <td>${strikerStats.fours}</td>
            <td>${strikerStats.sixes}</td>
            <td>${strikerStats.strikeRate}</td>
          </tr>
          <tr>
            <td>&nbsp;&nbsp;${escapeHTML(nonStriker?.name || 'Non-Striker')}</td>
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
              ⚡ <strong>${escapeHTML(bowler?.name || 'Bowler')}</strong>
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

    <!-- Over Timeline Strip -->
    <div class="card" style="padding:10px 14px;">
      <div class="eyebrow" style="margin-bottom:4px;">Recent Deliveries</div>
      <div class="timeline-strip">
        ${recentBalls.length ? recentBalls.map(b => `
          <div class="timeline-ball ${b.batRuns === 4 ? 'four' : b.batRuns === 6 ? 'six' : b.wicket ? 'wicket' : b.extraType ? 'extra' : ''}">
            ${b.wicket ? 'W' : b.extraType ? b.extraType.slice(0,2).toUpperCase() : b.batRuns}
          </div>
        `).join('') : '<span class="muted" style="font-size:12px;">Over in progress...</span>'}
      </div>
    </div>

    <!-- Scoring Touch Keypad -->
    <div class="card scoring-keypad-panel">
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
  `;
}

// Ball Recording Logic
async function recordBallEvent(runs) {
  if (!activeMatch) return;
  const inn = activeMatch.innings[activeMatch.innings.length - 1];

  if (!inn.strikerId || !inn.nonStrikerId || !inn.bowlerId) {
    alert('Please set Striker, Non-Striker, and Bowler using the dropdowns above before scoring deliveries.');
    return;
  }

  const ball = {
    id: generateId(),
    batterId: inn.strikerId,
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

    inn.balls.push(ball);
    triggerHaptic(addRuns >= 4 ? 'boundary' : 'normal');

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

  if (stats.wickets >= maxWickets) {
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
  triggerAutoBackup();
  showToast('Match marked as Completed.');
  navigate('history');
}

async function saveActiveMatch() {
  if (activeMatch) {
    await dbPut('matches', activeMatch);
    triggerAutoBackup();
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
        <button type="button" class="btn btn-primary" style="font-size:11px; padding:6px 10px; white-space:nowrap;" onclick="shareMatchSummaryText('${m.id}')">📲 Share</button>
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
                      <strong>${escapeHTML(b.name)}</strong>${(!b.isOut && (b.id === inn.strikerId || b.id === inn.nonStrikerId)) ? '*' : ''}
                      <br><small class="muted">${formatDismissalText(b, playersMap, playersMap)}</small>
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
                    <td><strong>${escapeHTML(bo.name)}</strong></td>
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

// App Launch
document.addEventListener('DOMContentLoaded', () => {
  // themeToggleBtn handled directly via onclick in index.html

  openDatabase()
    .then(async () => {
      await loadSavedSettings();
      renderDashboard();
      triggerAutoBackup();
    })
    .catch((err) => {
      console.error('Database launch error:', err);
      showToast('Running in local storage fallback mode.');
    });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
});
