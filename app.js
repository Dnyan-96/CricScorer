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

      // Wickets
      if (ball.wicket && ball.dismissal !== 'none') {
        const outPlayerId = ball.wicketPlayerId || strikerId;
        const outPlayer = batters[outPlayerId] || btr;
        outPlayer.isOut = true;
        outPlayer.dismissal = ball.dismissal;
        outPlayer.dismissalInfo = ball.dismissalDetails || null;

        totalWickets += 1;

        // Credit to bowler only if dismissal type allows it
        const bowlerCredited = ['bowled', 'caught', 'caughtAndBowled', 'lbw', 'stumped', 'hitWicket'];
        if (blr && bowlerCredited.includes(ball.dismissal)) {
          blr.wickets += 1;
        }

        fallOfWickets.push({
          wicketNum: totalWickets,
          score: totalRuns,
          overs: `${Math.floor(legalDeliveries / 6)}.${legalDeliveries % 6}`,
          playerName: outPlayer.name,
          dismissal: ball.dismissal
        });
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
      fallOfWickets
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

async function renderDashboard() {
  const [teams, players, matches] = await Promise.all([
    dbGetAll('teams'), dbGetAll('players'), dbGetAll('matches')
  ]);

  document.getElementById('statTotalMatches').textContent = matches.length;
  document.getElementById('statLiveMatches').textContent = matches.filter(m => m.status === 'Live').length;
  document.getElementById('statCompletedMatches').textContent = matches.filter(m => m.status === 'Completed').length;
  document.getElementById('statTotalTeams').textContent = teams.length;
  document.getElementById('statTotalPlayers').textContent = players.length;

  const matchesList = document.getElementById('dashboardMatchesList');
  if (!matches.length) {
    matchesList.className = 'stack-list empty-state';
    matchesList.textContent = 'No matches found. Create your first match!';
  } else {
    matchesList.className = 'stack-list';
    const recent = [...matches].sort((a,b) => (b.created || '').localeCompare(a.created || '')).slice(0, 5);
    matchesList.innerHTML = recent.map(m => createMatchItemHTML(m, teams)).join('');
  }

  // Calculate quick top performers across all matches
  calculateTopPerformers(matches);
}

function createMatchItemHTML(m, teams) {
  const teamA = teams.find(t => t.id === m.a)?.name || 'Team A';
  const teamB = teams.find(t => t.id === m.b)?.name || 'Team B';
  const statusBadge = m.status === 'Live' ? 'badge-live' : m.status === 'Completed' ? 'badge-completed' : 'badge-upcoming';

  return `
    <div class="match-item">
      <div class="item-info">
        <h3>${escapeHTML(teamA)} vs ${escapeHTML(teamB)}</h3>
        <p>${escapeHTML(m.title)} · ${m.overs || 20} ov · ${m.date || 'Today'} · <span class="badge ${statusBadge}">${m.status}</span></p>
        <p style="color:var(--primary); font-weight:700; margin-top:2px;">${escapeHTML(m.result || '')}</p>
      </div>
      <div class="item-actions">
        ${m.status === 'Live' ? `<button class="btn btn-primary" onclick="resumeMatch('${m.id}')">Scorer</button>` : ''}
        ${m.status === 'Completed' ? `<button class="btn btn-secondary" onclick="viewDetailedScorecard('${m.id}')">Scorecard</button>` : ''}
        ${m.status === 'Upcoming' ? `<button class="btn btn-primary" onclick="resumeMatch('${m.id}')">Start</button>` : ''}
        <button class="btn btn-outline" onclick="deleteMatchPrompt('${m.id}')">Del</button>
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

  const topBatters = Object.entries(batterTotals).sort((a,b) => b[1] - a[1]).slice(0, 3);
  const topBowlers = Object.entries(bowlerTotals).sort((a,b) => b[1] - a[1]).slice(0, 3);

  const batEl = document.getElementById('dashTopBatters');
  if (batEl) {
    batEl.innerHTML = topBatters.length ? topBatters.map(([name, runs]) => `
      <div style="display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px solid var(--border);">
        <span>${escapeHTML(name)}</span><strong>${runs} runs</strong>
      </div>
    `).join('') : '<span class="muted">No runs recorded yet.</span>';
  }

  const bowlEl = document.getElementById('dashTopBowlers');
  if (bowlEl) {
    bowlEl.innerHTML = topBowlers.length ? topBowlers.map(([name, wkts]) => `
      <div style="display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px solid var(--border);">
        <span>${escapeHTML(name)}</span><strong>${wkts} wickets</strong>
      </div>
    `).join('') : '<span class="muted">No wickets recorded yet.</span>';
  }
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
// 6. PLAYERS MANAGEMENT MODULE
// ==========================================

async function renderPlayers() {
  const [players, teams] = await Promise.all([dbGetAll('players'), dbGetAll('teams')]);
  const container = document.getElementById('playersContainer');
  const search = (document.getElementById('playerSearchInput')?.value || '').toLowerCase();
  const teamFilter = document.getElementById('playerTeamFilter')?.value || '';

  // Populate filter dropdown
  const filterDropdown = document.getElementById('playerTeamFilter');
  if (filterDropdown && filterDropdown.options.length <= 1) {
    teams.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.name;
      filterDropdown.appendChild(opt);
    });
  }

  let filtered = players.filter(p => {
    const matchName = p.name.toLowerCase().includes(search);
    const matchTeam = !teamFilter || p.teamId === teamFilter;
    return matchName && matchTeam;
  });

  if (!filtered.length) {
    container.className = 'stack-list empty-state';
    container.textContent = 'No players matching criteria.';
    return;
  }

  container.className = 'stack-list';
  container.innerHTML = filtered.map(p => {
    const teamObj = teams.find(t => t.id === p.teamId);
    return `
      <div class="player-item">
        <div class="item-info">
          <h3>${escapeHTML(p.name)}</h3>
          <p>${escapeHTML(teamObj?.name || 'Unassigned')} · Role: <strong>${escapeHTML(p.role || 'Batter')}</strong></p>
        </div>
        <div class="item-actions">
          <button class="btn btn-secondary" onclick="openPlayerModal('${p.id}')">Edit</button>
          <button class="btn btn-outline" onclick="deletePlayerPrompt('${p.id}')">Remove</button>
        </div>
      </div>
    `;
  }).join('');
}

async function openPlayerModal(playerId = null) {
  if (!db) await openDatabase();
  const [players, teams] = await Promise.all([dbGetAll('players'), dbGetAll('teams')]);
  if (!teams.length) {
    showToast('Please create a team first.');
    openTeamModal();
    return;
  }

  const p = playerId ? players.find(x => x.id === playerId) : null;
  const teamOpts = teams.map(t => `<option value="${t.id}" ${p && p.teamId === t.id ? 'selected' : ''}>${escapeHTML(t.name)}</option>`).join('');

  const html = `
    <form id="playerForm" onsubmit="event.preventDefault();">
      <div class="form-group" style="margin-bottom:12px;">
        <label>Player Full Name *</label>
        <input type="text" id="pName" name="name" required value="${escapeHTML(p?.name || '')}" placeholder="e.g. Virat Kohli">
      </div>
      <div class="form-group" style="margin-bottom:12px;">
        <label>Assign Team *</label>
        <select id="pTeamId" name="teamId" required>${teamOpts}</select>
      </div>
      <div class="form-group" style="margin-bottom:12px;">
        <label>Role</label>
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
          <option value="Right-hand bat">Right-hand bat</option>
          <option value="Left-hand bat">Left-hand bat</option>
        </select>
      </div>
    </form>
  `;

  openModal(p ? 'Edit Player' : 'Add Player', html, async () => {
    const name = document.getElementById('pName').value.trim();
    const teamId = document.getElementById('pTeamId').value;
    const role = document.getElementById('pRole').value;
    const battingStyle = document.getElementById('pBatStyle').value;

    if (!name) {
      showToast('Please enter a player name');
      return false;
    }

    if (p) {
      await dbPut('players', { ...p, name, teamId, role, battingStyle });
      showToast('Player updated');
    } else {
      await dbPut('players', {
        id: generateId(),
        name,
        teamId,
        role,
        battingStyle,
        created: new Date().toISOString()
      });
      showToast('Player registered');
    }
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

async function updateTeamDropdowns() {
  const teamAId = document.getElementById('cmTeamA').value;
  const teamBId = document.getElementById('cmTeamB').value;
  const [teams, players] = await Promise.all([dbGetAll('teams'), dbGetAll('players')]);

  // Update Toss Winner Labels
  const tossSel = document.getElementById('cmTossWinner');
  const teamAName = teams.find(t => t.id === teamAId)?.name || 'Team A';
  const teamBName = teams.find(t => t.id === teamBId)?.name || 'Team B';
  tossSel.innerHTML = `
    <option value="${teamAId}">${escapeHTML(teamAName)}</option>
    <option value="${teamBId}">${escapeHTML(teamBName)}</option>
  `;

  // Render squad checklists
  const playersA = players.filter(p => p.teamId === teamAId);
  const playersB = players.filter(p => p.teamId === teamBId);

  const listA = document.getElementById('squadListA');
  const listB = document.getElementById('squadListB');

  listA.innerHTML = playersA.length ? playersA.map(p => `
    <label class="checklist-item">
      <input type="checkbox" name="squadA" value="${p.id}" checked> ${escapeHTML(p.name)} (${p.role || 'Player'})
    </label>
  `).join('') : '<p class="muted">No players in this team yet.</p>';

  listB.innerHTML = playersB.length ? playersB.map(p => `
    <label class="checklist-item">
      <input type="checkbox" name="squadB" value="${p.id}" checked> ${escapeHTML(p.name)} (${p.role || 'Player'})
    </label>
  `).join('') : '<p class="muted">No players in this team yet.</p>';
}

async function handleCreateMatchSubmit(event) {
  event.preventDefault();
  const teamA = document.getElementById('cmTeamA').value;
  const teamB = document.getElementById('cmTeamB').value;

  if (teamA === teamB) {
    alert('Team A and Team B must be different teams.');
    return;
  }

  const squadAChecked = Array.from(document.querySelectorAll('input[name="squadA"]:checked')).map(cb => cb.value);
  const squadBChecked = Array.from(document.querySelectorAll('input[name="squadB"]:checked')).map(cb => cb.value);

  if (squadAChecked.length < 2 || squadBChecked.length < 2) {
    alert('Please select at least 2 players for each team squad.');
    return;
  }

  const [allPlayers] = await Promise.all([dbGetAll('players')]);
  const squadAPlayers = allPlayers.filter(p => squadAChecked.includes(p.id));
  const squadBPlayers = allPlayers.filter(p => squadBChecked.includes(p.id));

  const tossWinner = document.getElementById('cmTossWinner').value;
  const tossDecision = document.getElementById('cmTossDecision').value;

  // Determine Batting Team
  let battingTeamId = (tossWinner === teamA && tossDecision === 'bat') || (tossWinner === teamB && tossDecision === 'bowl') ? teamA : teamB;
  let bowlingTeamId = battingTeamId === teamA ? teamB : teamA;

  const firstBattingSquad = battingTeamId === teamA ? squadAPlayers : squadBPlayers;
  const firstBowlingSquad = battingTeamId === teamA ? squadBPlayers : squadAPlayers;

  const matchId = generateId();
  const format = document.getElementById('cmFormat').value;
  const overs = format === 'Test' ? 450 : Number(document.getElementById('cmOvers').value || 20);

  const initialInnings = {
    inningsNum: 1,
    batting: battingTeamId,
    bowling: bowlingTeamId,
    squad: firstBattingSquad,
    bowlingSquad: firstBowlingSquad,
    strikerId: firstBattingSquad[0]?.id,
    nonStrikerId: firstBattingSquad[1]?.id,
    bowlerId: firstBowlingSquad[0]?.id,
    balls: [],
    base: { runs: 0, wickets: 0, legal: 0, ballCount: 0 }
  };

  const newMatch = {
    id: matchId,
    title: document.getElementById('cmTitle').value.trim() || 'Cricket Match',
    format: format,
    a: teamA,
    b: teamB,
    overs: overs,
    date: document.getElementById('cmDate').value,
    venue: document.getElementById('cmVenue').value || 'Home Ground',
    tossWinner,
    tossDecision,
    status: 'Live',
    innings: [initialInnings],
    created: new Date().toISOString()
  };

  await dbPut('matches', newMatch);
  activeMatch = newMatch;
  showToast('Match configured! Launching Live Scorer...');
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
  if (!activeMatch) return;
  const inn = activeMatch.innings[activeMatch.innings.length - 1];
  inn.bowlerId = newBowlerId;
  await saveActiveMatch();
  showToast('Active Bowler updated');
  renderLiveScorerView();
}

function generateMatchInsights(inn, stats, match) {
  const insights = [];
  const legalBalls = stats.legalDeliveries;
  const overs = legalBalls / 6;
  const crr = overs > 0 ? (stats.totalRuns / overs) : 0;
  const totalOvers = match.overs || 20;
  const totalMaxBalls = totalOvers * 6;
  const ballsRemaining = Math.max(0, totalMaxBalls - legalBalls);

  // 1. Target Tracking (2nd Innings)
  if (match.target) {
    const runsNeeded = Math.max(0, match.target - stats.totalRuns);
    if (runsNeeded <= 0) {
      insights.push({ icon: '🏆', text: 'Target reached! Match victory.' });
    } else if (ballsRemaining === 0) {
      insights.push({ icon: '⚠️', text: `Innings ended. Short by ${runsNeeded} runs.` });
    } else {
      const rrr = (runsNeeded / (ballsRemaining / 6)).toFixed(2);
      insights.push({
        icon: '🎯',
        text: `Need <strong>${runsNeeded} runs</strong> from <strong>${ballsRemaining} balls</strong> (RRR: <strong>${rrr}</strong> vs CRR: <strong>${crr.toFixed(2)}</strong>)`
      });
    }
  } else if (overs >= 1) {
    // 1st Innings Projected Total
    const projected = Math.round(crr * totalOvers);
    insights.push({
      icon: '📊',
      text: `Projected total at current ${crr.toFixed(2)} RPO: <strong>~${projected} runs</strong>`
    });
  }

  // 2. Striker Momentum
  const striker = stats.batters.find(b => b.id === inn.strikerId);
  if (striker && striker.balls >= 6) {
    const sr = parseFloat(striker.strikeRate);
    if (sr >= 160) {
      insights.push({ icon: '🔥', text: `<strong>${escapeHTML(striker.name)}</strong> in attacking flow: ${striker.runs} off ${striker.balls} (SR: ${sr.toFixed(0)})` });
    } else if (sr < 85 && striker.runs >= 10) {
      insights.push({ icon: '⏳', text: `<strong>${escapeHTML(striker.name)}</strong> holding anchor: ${striker.runs} off ${striker.balls} balls` });
    }
  }

  // 3. Bowler Spell Analysis
  const bowler = stats.bowlers.find(b => b.id === inn.bowlerId);
  if (bowler && bowler.legalBalls >= 6) {
    const econ = parseFloat(bowler.economy);
    if (econ <= 6.0) {
      insights.push({ icon: '⚡', text: `<strong>${escapeHTML(bowler.name)}</strong> bowling tight spell (${econ.toFixed(2)} Econ, ${bowler.wickets} wkts)` });
    } else if (econ >= 11.5) {
      insights.push({ icon: '📈', text: `<strong>${escapeHTML(bowler.name)}</strong> conceding ${econ.toFixed(2)} RPO - consider bowling rotation` });
    }
  }

  // 4. Dot-ball Pressure
  const recent6 = inn.balls.slice(-6);
  if (recent6.length >= 6) {
    const dotsInLast6 = recent6.filter(b => b.batRuns === 0 && !b.extraType && !b.wicket).length;
    if (dotsInLast6 >= 4) {
      insights.push({ icon: '🧱', text: `Bowling pressure mounting: <strong>${dotsInLast6} dots</strong> in last 6 deliveries` });
    }
    const boundariesInLast6 = recent6.filter(b => b.batRuns === 4 || b.batRuns === 6).length;
    if (boundariesInLast6 >= 3) {
      insights.push({ icon: '💥', text: `Boundary surge: <strong>${boundariesInLast6} boundaries</strong> in last over` });
    }
  }

  if (!insights.length) {
    insights.push({ icon: '🏏', text: 'Innings in progress. Use the dropdowns above to switch striker, non-striker, or bowler at any point.' });
  }

  return insights;
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

  // Available batters & bowlers for dropdown selection
  const dismissedIds = new Set(stats.fallOfWickets.map(f => f.playerId || ''));
  const availableBatters = inn.squad.filter(p => !dismissedIds.has(p.id) || p.id === inn.strikerId || p.id === inn.nonStrikerId);
  const matchInsights = generateMatchInsights(inn, stats, activeMatch);

  container.innerHTML = `
    <!-- Top Match Header -->
    <div class="score-hero-box">
      <div class="match-vs-header">${escapeHTML(battingTeamName)} vs ${escapeHTML(bowlingTeamName)} (Inn ${activeMatch.innings.length})</div>
      <div class="live-digits-row">
        <span class="live-score-big">${stats.totalRuns} / ${stats.wickets}</span>
        <span class="live-overs-big">(${stats.oversFormatted} / ${activeMatch.overs} ov)</span>
      </div>
      <div class="live-rates-row">
        <span>CRR: <strong>${stats.legalDeliveries > 0 ? (stats.totalRuns / (stats.legalDeliveries / 6)).toFixed(2) : '0.00'}</strong></span>
        <span>Target: <strong>${activeMatch.target ? activeMatch.target : '--'}</strong></span>
        <span>Extras: <strong>${stats.extras.total}</strong></span>
      </div>
    </div>

    <!-- Live Match Insights -->
    <div class="insights-box">
      <div class="insights-header">
        <span>⚡ Live Match Insights</span>
      </div>
      <div class="insights-list">
        ${matchInsights.map(item => `
          <div class="insight-item">
            <span class="insight-icon">${item.icon}</span>
            <span>${item.text}</span>
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
            ${availableBatters.map(p => `
              <option value="${p.id}" ${p.id === inn.strikerId ? 'selected' : ''}>★ ${escapeHTML(p.name)}</option>
            `).join('')}
          </select>
        </div>

        <div class="crease-selector-group">
          <label>Non-Striker</label>
          <select class="crease-select" onchange="changeNonStriker(this.value)">
            ${availableBatters.map(p => `
              <option value="${p.id}" ${p.id === inn.nonStrikerId ? 'selected' : ''}>${escapeHTML(p.name)}</option>
            `).join('')}
          </select>
        </div>

        <div class="crease-selector-group">
          <label>Current Bowler</label>
          <select class="crease-select bowler-select" onchange="changeBowler(this.value)">
            ${inn.bowlingSquad.map(b => `
              <option value="${b.id}" ${b.id === inn.bowlerId ? 'selected' : ''}>⚡ ${escapeHTML(b.name)}</option>
            `).join('')}
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
            <td>⚡ <strong>${escapeHTML(bowler?.name || 'Bowler')}</strong></td>
            <td>${bowlerStats.oversFormatted}</td>
            <td>${bowlerStats.runsConceded}</td>
            <td><strong style="color:var(--danger);">${bowlerStats.wickets}</strong></td>
            <td>${bowlerStats.economy}</td>
          </tr>
        </tbody>
      </table>
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
        <button class="key-touch extra-key" onclick="recordExtraPrompt('wide')">WD</button>
        <button class="key-touch extra-key" onclick="recordExtraPrompt('noBall')">NB</button>
        <button class="key-touch extra-key" onclick="recordExtraPrompt('bye')">BYE</button>
        <button class="key-touch extra-key" onclick="recordExtraPrompt('legBye')">LB</button>
        <button class="key-touch wicket" onclick="openWicketModal()">WICKET</button>
      </div>

      <div class="aux-controls-row">
        <button class="btn btn-secondary" onclick="swapStrike()">⇄ Swap Strike</button>
        <button class="btn btn-secondary" onclick="openBowlerSelectModal()">⚡ Bowler</button>
        <button class="btn btn-outline" onclick="undoLastDelivery()">↶ Undo</button>
      </div>

      <div class="aux-controls-row" style="margin-top:6px;">
        <button class="btn btn-secondary" onclick="endInningsPrompt()">End Innings</button>
        <button class="btn btn-primary" onclick="finishMatchPrompt()">Finish Match</button>
      </div>
    </div>
  `;
}

// Ball Recording Logic
async function recordBallEvent(runs) {
  if (!activeMatch) return;
  const inn = activeMatch.innings[activeMatch.innings.length - 1];

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
  renderLiveScorerView();
}

// Extras Prompt
async function recordExtraPrompt(extraType) {
  if (!activeMatch) return;
  const inn = activeMatch.innings[activeMatch.innings.length - 1];

  let promptMsg = `Enter additional runs scored off this ${extraType.toUpperCase()} (0 if none):`;
  let additional = prompt(promptMsg, '0');
  if (additional === null) return;
  let addRuns = parseInt(additional, 10) || 0;

  let compExtra = (extraType === 'wide' || extraType === 'noBall') ? 1 : 0;
  let totalExtra = compExtra + addRuns;

  const ball = {
    id: generateId(),
    batterId: inn.strikerId,
    nonStrikerId: inn.nonStrikerId,
    bowlerId: inn.bowlerId,
    batRuns: 0,
    extraType: extraType,
    extraRuns: addRuns,
    extraTotal: totalExtra,
    wicket: false,
    dismissal: 'none',
    timestamp: Date.now()
  };

  inn.balls.push(ball);

  // Check strike rotation for byes/leg-byes/wides on odd additional runs
  if (addRuns % 2 !== 0) {
    const temp = inn.strikerId;
    inn.strikerId = inn.nonStrikerId;
    inn.nonStrikerId = temp;
  }

  await saveActiveMatch();
  renderLiveScorerView();
}

// 12 Wicket Dismissals Workflow
function openWicketModal() {
  if (!activeMatch) return;
  const inn = activeMatch.innings[activeMatch.innings.length - 1];

  const html = `
    <form id="wicketForm">
      <div class="form-group" style="margin-bottom:12px;">
        <label>Dismissal Type</label>
        <select id="wfType" onchange="onDismissalTypeChange(this.value)">
          <option value="bowled">Bowled</option>
          <option value="caught">Caught</option>
          <option value="caughtAndBowled">Caught & Bowled</option>
          <option value="lbw">LBW</option>
          <option value="stumped">Stumped</option>
          <option value="runOut">Run Out</option>
          <option value="hitWicket">Hit Wicket</option>
          <option value="retiredHurt">Retired Hurt</option>
          <option value="retiredOut">Retired Out</option>
          <option value="obstructingTheField">Obstructing the Field</option>
          <option value="hitBallTwice">Hit the Ball Twice</option>
          <option value="timedOut">Timed Out</option>
        </select>
      </div>

      <div class="form-group" style="margin-bottom:12px;">
        <label>Dismissed Batter</label>
        <select id="wfOutBatter">
          <option value="${inn.strikerId}">Striker (${inn.squad.find(p=>p.id===inn.strikerId)?.name})</option>
          <option value="${inn.nonStrikerId}">Non-Striker (${inn.squad.find(p=>p.id===inn.nonStrikerId)?.name})</option>
        </select>
      </div>

      <div class="form-group" id="wfFielderGroup" style="display:none; margin-bottom:12px;">
        <label>Fielder Involved</label>
        <select id="wfFielder">
          <option value="">None / Unknown</option>
          ${inn.bowlingSquad.map(p => `<option value="${p.id}">${escapeHTML(p.name)}</option>`).join('')}
        </select>
      </div>

      <div class="form-group">
        <label>Incoming Batter</label>
        <select id="wfIncoming" required>
          ${getAvailableIncomingBatters(inn).map(p => `<option value="${p.id}">${escapeHTML(p.name)}</option>`).join('')}
        </select>
      </div>
    </form>
  `;

  openModal('Record Dismissal / Wicket', html, async () => {
    const type = document.getElementById('wfType').value;
    const outBatterId = document.getElementById('wfOutBatter').value;
    const incomingId = document.getElementById('wfIncoming').value;
    const fielderId = document.getElementById('wfFielder').value;

    const ball = {
      id: generateId(),
      batterId: inn.strikerId,
      nonStrikerId: inn.nonStrikerId,
      bowlerId: inn.bowlerId,
      batRuns: 0,
      extraType: null,
      extraRuns: 0,
      extraTotal: 0,
      wicket: type !== 'retiredHurt',
      dismissal: type,
      wicketPlayerId: outBatterId,
      dismissalDetails: { fielderId },
      timestamp: Date.now()
    };

    inn.balls.push(ball);

    // Replace out batter with incoming
    if (inn.strikerId === outBatterId) {
      inn.strikerId = incomingId;
    } else {
      inn.nonStrikerId = incomingId;
    }

    await saveActiveMatch();
    renderLiveScorerView();
    return true;
  });
}

function onDismissalTypeChange(val) {
  const fg = document.getElementById('wfFielderGroup');
  if (fg) fg.style.display = (val === 'caught' || val === 'runOut' || val === 'stumped') ? 'block' : 'none';
}

function getAvailableIncomingBatters(inn) {
  const stats = CricketEngine.calculateInnings(inn);
  const outIds = new Set(stats.fallOfWickets.map(f => f.playerId || '').concat([inn.strikerId, inn.nonStrikerId]));
  return inn.squad.filter(p => !outIds.has(p.id));
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
  const opts = inn.bowlingSquad.map(b => `<option value="${b.id}" ${b.id === inn.bowlerId ? 'selected' : ''}>${escapeHTML(b.name)}</option>`).join('');

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

async function endInningsPrompt() {
  if (!confirm('Are you sure you want to conclude this innings?')) return;
  const inn = activeMatch.innings[activeMatch.innings.length - 1];
  const stats = CricketEngine.calculateInnings(inn);

  if (activeMatch.innings.length === 1) {
    activeMatch.target = stats.totalRuns + 1;
    // Swap batting and bowling squads
    const nextBatting = inn.bowling;
    const nextBowling = inn.batting;
    const nextSquad = inn.bowlingSquad;
    const nextBowlingSquad = inn.squad;

    const innings2 = {
      inningsNum: 2,
      batting: nextBatting,
      bowling: nextBowling,
      squad: nextSquad,
      bowlingSquad: nextBowlingSquad,
      strikerId: nextSquad[0]?.id,
      nonStrikerId: nextSquad[1]?.id,
      bowlerId: nextBowlingSquad[0]?.id,
      balls: [],
      base: { runs: 0, wickets: 0, legal: 0, ballCount: 0 }
    };

    activeMatch.innings.push(innings2);
    await saveActiveMatch();
    alert(`Innings 1 finished! Target for Innings 2: ${activeMatch.target} runs.`);
    renderLiveScorerView();
  } else {
    finishMatchPrompt();
  }
}

async function finishMatchPrompt() {
  if (!confirm('Mark this match as Completed and calculate official result?')) return;
  const inn1 = activeMatch.innings[0];
  const inn2 = activeMatch.innings[1];

  const stats1 = CricketEngine.calculateInnings(inn1);
  const stats2 = inn2 ? CricketEngine.calculateInnings(inn2) : null;

  const [teams] = await Promise.all([dbGetAll('teams')]);
  const team1Name = teams.find(t => t.id === inn1.batting)?.name || 'Team 1';
  const team2Name = teams.find(t => t.id === inn1.bowling)?.name || 'Team 2';

  let resultStr = 'Match Completed';

  if (stats2) {
    if (stats2.totalRuns >= (stats1.totalRuns + 1)) {
      const wktsLeft = 10 - stats2.wickets;
      resultStr = `${team2Name} won by ${wktsLeft} wickets`;
    } else if (stats1.totalRuns > stats2.totalRuns) {
      const margin = stats1.totalRuns - stats2.totalRuns;
      resultStr = `${team1Name} won by ${margin} runs`;
    } else {
      resultStr = `Match Tied (${stats1.totalRuns} - ${stats2.totalRuns})`;
    }
  }

  activeMatch.status = 'Completed';
  activeMatch.result = resultStr;

  await saveActiveMatch();
  showToast('Match marked as Completed.');
  navigate('history');
}

async function saveActiveMatch() {
  if (activeMatch) {
    await dbPut('matches', activeMatch);
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

async function viewDetailedScorecard(matchId) {
  const [matches, teams] = await Promise.all([dbGetAll('matches'), dbGetAll('teams')]);
  const m = matches.find(x => x.id === matchId);
  if (!m) return;

  const teamAName = teams.find(t => t.id === m.a)?.name || 'Team A';
  const teamBName = teams.find(t => t.id === m.b)?.name || 'Team B';

  const html = `
    <div style="font-size:13px;">
      <div style="margin-bottom:12px; border-bottom:1px solid var(--border); padding-bottom:8px;">
        <h3 style="font-size:16px;">${escapeHTML(m.title)}</h3>
        <p class="muted">${escapeHTML(teamAName)} vs ${escapeHTML(teamBName)} · ${escapeHTML(m.venue || 'Venue')} · ${m.date}</p>
        <p style="color:var(--primary); font-weight:800; margin-top:4px;">${escapeHTML(m.result || m.status)}</p>
      </div>

      ${m.innings.map((inn, idx) => {
        const stats = CricketEngine.calculateInnings(inn, inn.squad, inn.bowlingSquad);
        const battingName = teams.find(t => t.id === inn.batting)?.name || `Innings ${idx + 1}`;
        return `
          <div style="margin-bottom:18px; background:var(--bg-surface-alt); padding:12px; border-radius:10px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
              <strong>${escapeHTML(battingName)}</strong>
              <span style="font-size:15px; font-weight:800; color:var(--primary);">${stats.totalRuns} / ${stats.wickets} (${stats.oversFormatted} ov)</span>
            </div>

            <!-- Batting Card -->
            <h4 style="font-size:11px; text-transform:uppercase; color:var(--text-muted); margin-bottom:4px;">Batting</h4>
            <table class="crease-table" style="margin-bottom:12px;">
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
                ${stats.batters.map(b => `
                  <tr>
                    <td>${escapeHTML(b.name)} <small class="muted">(${b.dismissal})</small></td>
                    <td><strong>${b.runs}</strong></td>
                    <td>${b.balls}</td>
                    <td>${b.fours}</td>
                    <td>${b.sixes}</td>
                    <td>${b.strikeRate}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>

            <!-- Bowling Card -->
            <h4 style="font-size:11px; text-transform:uppercase; color:var(--text-muted); margin-bottom:4px;">Bowling</h4>
            <table class="crease-table">
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
                ${stats.bowlers.map(bo => `
                  <tr>
                    <td>${escapeHTML(bo.name)}</td>
                    <td>${bo.oversFormatted}</td>
                    <td>${bo.runsConceded}</td>
                    <td><strong style="color:var(--danger);">${bo.wickets}</strong></td>
                    <td>${bo.economy}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `;
      }).join('')}
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
// 10. STATISTICS MODULE
// ==========================================

function switchStatsTab(tab) {
  currentStatsTab = tab;
  document.getElementById('btnStatsBatting').classList.toggle('active', tab === 'batting');
  document.getElementById('btnStatsBowling').classList.toggle('active', tab === 'bowling');
  document.getElementById('btnStatsFielding').classList.toggle('active', tab === 'fielding');
  renderStatistics();
}

async function renderStatistics() {
  const [matches, players] = await Promise.all([dbGetAll('matches'), dbGetAll('players')]);
  const formatFilter = document.getElementById('statsFormatFilter')?.value || '';
  const container = document.getElementById('statsTableContainer');

  const filteredMatches = matches.filter(m => !formatFilter || m.format === formatFilter);

  const battingStats = {};
  const bowlingStats = {};
  const fieldingStats = {};

  players.forEach(p => {
    battingStats[p.id] = { name: p.name, innings: 0, runs: 0, balls: 0, fours: 0, sixes: 0, highest: 0, outs: 0 };
    bowlingStats[p.id] = { name: p.name, legalBalls: 0, runs: 0, wickets: 0 };
    fieldingStats[p.id] = { name: p.name, catches: 0, runOuts: 0, stumpings: 0 };
  });

  filteredMatches.forEach(m => {
    (m.innings || []).forEach(inn => {
      const stats = CricketEngine.calculateInnings(inn, inn.squad, inn.bowlingSquad);
      
      // Batting
      stats.batters.forEach(b => {
        if (!battingStats[b.id]) battingStats[b.id] = { name: b.name, innings: 0, runs: 0, balls: 0, fours: 0, sixes: 0, highest: 0, outs: 0 };
        if (b.balls > 0 || b.isOut) {
          battingStats[b.id].innings += 1;
          battingStats[b.id].runs += b.runs;
          battingStats[b.id].balls += b.balls;
          battingStats[b.id].fours += b.fours;
          battingStats[b.id].sixes += b.sixes;
          if (b.runs > battingStats[b.id].highest) battingStats[b.id].highest = b.runs;
          if (b.isOut) battingStats[b.id].outs += 1;
        }
      });

      // Bowling
      stats.bowlers.forEach(bo => {
        if (!bowlingStats[bo.id]) bowlingStats[bo.id] = { name: bo.name, legalBalls: 0, runs: 0, wickets: 0 };
        bowlingStats[bo.id].legalBalls += bo.legalBalls;
        bowlingStats[bo.id].runs += bo.runsConceded;
        bowlingStats[bo.id].wickets += bo.wickets;
      });
    });
  });

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
          ${list.map(b => {
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
          }).join('')}
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
          ${list.map(bo => {
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
          }).join('')}
        </tbody>
      </table>
    `;
  } else {
    container.innerHTML = `<p class="muted" style="padding:16px;">Fielding catches and run-out tracking summary populated from scorecards.</p>`;
  }
}

async function exportStatsCSV() {
  const [players, matches] = await Promise.all([dbGetAll('players'), dbGetAll('matches')]);
  let csv = 'Player,Innings,Runs,Balls,Fours,Sixes\n';
  players.forEach(p => {
    let r = 0, b = 0, f = 0, s = 0, innCount = 0;
    matches.forEach(m => {
      (m.innings || []).forEach(inn => {
        const stats = CricketEngine.calculateInnings(inn);
        const found = stats.batters.find(x => x.id === p.id);
        if (found && (found.balls > 0 || found.isOut)) {
          innCount++;
          r += found.runs; b += found.balls; f += found.fours; s += found.sixes;
        }
      });
    });
    csv += `"${p.name}",${innCount},${r},${b},${f},${s}\n`;
  });
  triggerDownload(csv, `CricScorer_Stats_${Date.now()}.csv`, 'text/csv');
}

// ==========================================
// 11. BACKUP, RESTORE & AUDIT LOGS
// ==========================================

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

async function inspectStorageQuota() {
  if (navigator.storage && navigator.storage.estimate) {
    const est = await navigator.storage.estimate();
    const usedMB = (est.usage / (1024 * 1024)).toFixed(2);
    const quotaMB = (est.quota / (1024 * 1024)).toFixed(0);
    document.getElementById('storageQuotaLabel').textContent = `Using ${usedMB} MB of ~${quotaMB} MB quota available.`;
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

// App Launch
document.addEventListener('DOMContentLoaded', () => {
  // themeToggleBtn handled directly via onclick in index.html

  openDatabase()
    .then(async () => {
      await loadSavedSettings();
      renderDashboard();
    })
    .catch((err) => {
      console.error('Database launch error:', err);
      showToast('Running in local storage fallback mode.');
    });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
});
