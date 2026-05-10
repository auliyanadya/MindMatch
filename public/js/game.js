/* ═══ MINDMATCH — Frontend Game Logic ════════════════════════════════════════ */
'use strict';

const socket = io();

// ─── State ────────────────────────────────────────────────────────────────────
let state = {
  playerName: '',
  roomData: null,
  myId: null,
  selectedLevel: 'easy',
  selectedTheme: 'animals',
  lbFilter: 'all',
  flippedThisTurn: [],
  isAnimating: false,
  peekTimeout: null,
  soundEnabled: true,
  theme: 'dark'
};

function myId() { return socket.id || state.myId || ''; }

// ─── DOM Helpers ──────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const showScreen = id => {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
};

function toast(msg, type = 'info', duration = 3000) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('toast-container').appendChild(el);
  setTimeout(() => el.remove(), duration);
}

function showMatchMessage(msg, color = '#FFE66D') {
  const el = $('match-message');
  el.textContent = msg; el.style.color = color;
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
}

// ═══ SOUND ENGINE (Web Audio API — no files needed) ══════════════════════════
const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;

function getAudioCtx() {
  if (!audioCtx) audioCtx = new AudioCtx();
  return audioCtx;
}

function playTone(opts) {
  if (!state.soundEnabled) return;
  try {
    const ctx = getAudioCtx();
    const { type = 'sine', freq = 440, freq2, duration = 0.15, gain = 0.3, delay = 0 } = opts;
    const osc = ctx.createOscillator();
    const gainNode = ctx.createGain();
    osc.connect(gainNode); gainNode.connect(ctx.destination);
    osc.type = type; osc.frequency.value = freq;
    if (freq2) osc.frequency.linearRampToValueAtTime(freq2, ctx.currentTime + delay + duration);
    gainNode.gain.setValueAtTime(0, ctx.currentTime + delay);
    gainNode.gain.linearRampToValueAtTime(gain, ctx.currentTime + delay + 0.01);
    gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + duration);
    osc.start(ctx.currentTime + delay);
    osc.stop(ctx.currentTime + delay + duration + 0.05);
  } catch (e) {}
}

const SFX = {
  flip() {
    playTone({ type: 'sine', freq: 600, freq2: 900, duration: 0.08, gain: 0.2 });
  },
  match() {
    playTone({ freq: 523, duration: 0.12, gain: 0.3 });
    playTone({ freq: 659, duration: 0.12, gain: 0.3, delay: 0.1 });
    playTone({ freq: 784, duration: 0.2,  gain: 0.35, delay: 0.2 });
  },
  combo() {
    [523, 659, 784, 1047].forEach((f, i) => playTone({ freq: f, duration: 0.1, gain: 0.3, delay: i * 0.08 }));
  },
  mismatch() {
    playTone({ type: 'sawtooth', freq: 220, freq2: 150, duration: 0.25, gain: 0.25 });
  },
  turn() {
    playTone({ freq: 440, duration: 0.1, gain: 0.2 });
    playTone({ freq: 550, duration: 0.1, gain: 0.2, delay: 0.1 });
  },
  powerup() {
    [880, 1100, 1320].forEach((f, i) => playTone({ freq: f, duration: 0.09, gain: 0.25, delay: i * 0.07 }));
  },
  gameOver() {
    const melody = [392, 349, 330, 294, 261];
    melody.forEach((f, i) => playTone({ freq: f, duration: 0.2, gain: 0.3, delay: i * 0.18 }));
  },
  win() {
    const melody = [523, 659, 784, 659, 784, 1047];
    melody.forEach((f, i) => playTone({ freq: f, duration: 0.15, gain: 0.3, delay: i * 0.12 }));
  },
  click() {
    playTone({ freq: 800, duration: 0.06, gain: 0.15 });
  },
  reaction() {
    playTone({ type: 'sine', freq: 700, freq2: 1000, duration: 0.1, gain: 0.18 });
  }
};

// ═══ THEME SYSTEM ════════════════════════════════════════════════════════════
function initTheme() {
  const saved = localStorage.getItem('mm_theme') || 'dark';
  setTheme(saved);
}

function setTheme(t) {
  state.theme = t;
  document.documentElement.setAttribute('data-theme', t);
  $('theme-toggle').textContent = t === 'dark' ? '☀️' : '🌙';
  localStorage.setItem('mm_theme', t);
}

function toggleTheme() {
  SFX.click();
  setTheme(state.theme === 'dark' ? 'light' : 'dark');
}

// ═══ SOUND TOGGLE ════════════════════════════════════════════════════════════
function initSoundToggle() {
  const saved = localStorage.getItem('mm_sound');
  if (saved === 'off') { state.soundEnabled = false; $('sound-toggle').textContent = '🔇'; }
  $('sound-toggle').addEventListener('click', () => {
    state.soundEnabled = !state.soundEnabled;
    $('sound-toggle').textContent = state.soundEnabled ? '🔊' : '🔇';
    localStorage.setItem('mm_sound', state.soundEnabled ? 'on' : 'off');
    if (state.soundEnabled) SFX.click();
  });
}

// ═══ EMOJI REACTION SYSTEM ═══════════════════════════════════════════════════
function showFloatingReaction(emoji, x, y) {
  const el = document.createElement('div');
  el.className = 'floating-reaction';
  el.textContent = emoji;
  // Randomize horizontal drift
  const drift = (Math.random() - 0.5) * 120;
  el.style.cssText = `left:${x + drift}px; top:${y}px;`;
  $('reaction-overlay').appendChild(el);
  setTimeout(() => el.remove(), 2000);
}

function spawnReaction(emoji) {
  SFX.reaction();
  // Spawn multiple instances scattered on screen
  for (let i = 0; i < 5; i++) {
    setTimeout(() => {
      const x = 100 + Math.random() * (window.innerWidth - 200);
      const y = window.innerHeight * (0.3 + Math.random() * 0.5);
      showFloatingReaction(emoji, x, y);
    }, i * 120);
  }
}

socket.on('reaction', ({ emoji }) => {
  spawnReaction(emoji);
});

// ═══ PARTICLES ═══════════════════════════════════════════════════════════════
function createParticles() {
  const container = $('particles');
  const colors = ['#FF6B6B','#FFE66D','#4ECDC4','#A855F7','#FF8C42','#06D6A0'];
  for (let i = 0; i < 22; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    const size = Math.random() * 18 + 7;
    p.style.cssText = `width:${size}px;height:${size}px;left:${Math.random()*100}%;background:${colors[Math.floor(Math.random()*colors.length)]};animation-duration:${Math.random()*12+8}s;animation-delay:${Math.random()*8}s;`;
    container.appendChild(p);
  }
}

function launchFireworks() {
  const container = $('fireworks');
  const colors = ['#FFD700','#FF6B6B','#4ECDC4','#A855F7','#FF8C42','#06D6A0','#FFE66D'];
  for (let w = 0; w < 8; w++) {
    setTimeout(() => {
      const cx = Math.random() * window.innerWidth;
      const cy = Math.random() * window.innerHeight * 0.6;
      for (let i = 0; i < 20; i++) {
        const p = document.createElement('div');
        const angle = (i / 20) * Math.PI * 2;
        const dist = Math.random() * 120 + 60;
        p.className = 'fw-particle';
        p.style.cssText = `left:${cx}px;top:${cy}px;width:${Math.random()*7+3}px;height:${Math.random()*7+3}px;background:${colors[Math.floor(Math.random()*colors.length)]};--dx:${Math.cos(angle)*dist}px;--dy:${Math.sin(angle)*dist}px;animation-duration:${Math.random()*0.8+0.8}s;`;
        container.appendChild(p);
        setTimeout(() => p.remove(), 1600);
      }
    }, w * 300);
  }
}

// ─── Avatar ───────────────────────────────────────────────────────────────────
function getAvatar(name) {
  const avatars = ['🦊','🐼','🦁','🐯','🐸','🦋','🐬','🦄','🐙','🦜'];
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff;
  return avatars[Math.abs(hash) % avatars.length];
}

// ─── Escape HTML ───────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ═══ LOBBY UI ════════════════════════════════════════════════════════════════
function initLobby() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      SFX.click();
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      $(`tab-${btn.dataset.tab}`).classList.add('active');
      if (btn.dataset.tab === 'leaderboard') loadLobbyLeaderboard();
    });
  });

  document.querySelectorAll('.level-card').forEach(card => {
    card.addEventListener('click', () => {
      SFX.click();
      document.querySelectorAll('.level-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      state.selectedLevel = card.dataset.level;
    });
  });

  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      SFX.click();
      document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.selectedTheme = btn.dataset.theme;
    });
  });

  $('player-name').addEventListener('input', e => {
    const name = e.target.value.trim();
    $('name-avatar').textContent = name ? getAvatar(name) : '🦊';
    // Broadcast ke server bahwa user ini online
    if (name.length >= 2) {
      clearTimeout(state._onlineDebounce);
      state._onlineDebounce = setTimeout(() => {
        socket.emit('set_online', { name });
      }, 500);
    }
  });

  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.lbFilter = btn.dataset.filter;
      loadLobbyLeaderboard();
    });
  });

  $('btn-create-room').addEventListener('click', () => {
    const name = $('player-name').value.trim();
    if (!name) { toast('Masukkan nama kamu dulu!', 'error'); return; }
    state.playerName = name;
    SFX.click();
    socket.emit('create_room', { name, level: state.selectedLevel, theme: state.selectedTheme });
  });

  $('btn-join-room').addEventListener('click', () => {
    const name = $('player-name').value.trim();
    const code = $('room-code-input').value.trim().toUpperCase();
    if (!name) { toast('Masukkan nama kamu dulu!', 'error'); return; }
    if (code.length !== 6) { toast('Kode room harus 6 karakter!', 'error'); return; }
    state.playerName = name;
    SFX.click();
    socket.emit('join_room', { name, code });
  });

  $('room-code-input').addEventListener('keyup', e => { if (e.key === 'Enter') $('btn-join-room').click(); });
  $('player-name').addEventListener('keyup', e => { if (e.key === 'Enter') $('btn-create-room').click(); });
}

function loadLobbyLeaderboard() {
  $('leaderboard-list').innerHTML = '<div class="lb-loading">Memuat...</div>';
  socket.emit('get_leaderboard');
}

function renderLobbyLeaderboard(data) {
  const filtered = state.lbFilter === 'all' ? data : data.filter(e => e.level === state.lbFilter);
  if (!filtered.length) { $('leaderboard-list').innerHTML = '<div class="lb-loading">Belum ada data 😢</div>'; return; }
  const medals = ['🥇','🥈','🥉'];
  const rankClass = i => i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
  const levelName = l => ({ easy:'Mudah', medium:'Sedang', hard:'Sulit' }[l] || l);
  const timeStr = s => `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
  $('leaderboard-list').innerHTML = filtered.slice(0, 15).map((e, i) => `
    <div class="lb-item">
      <div class="lb-rank ${rankClass(i)}">${medals[i] || `#${i+1}`}</div>
      <div class="lb-avatar">${e.avatar || '🎴'}</div>
      <div class="lb-info">
        <div class="lb-name">${escapeHtml(e.name)}</div>
        <div class="lb-meta">${levelName(e.level)} · ${e.matches} pasang · ${timeStr(e.time || 0)}</div>
      </div>
      <div class="lb-score">${e.score}</div>
    </div>
  `).join('');
}

// ═══ WAITING ROOM ════════════════════════════════════════════════════════════
function enterWaitingRoom(room) {
  state.roomData = room;
  $('display-room-code').textContent = room.code;
  const levelNames = { easy:'Mudah 🌱', medium:'Sedang 🌊', hard:'Sulit 🔥' };
  const themeNames = { animals:'Hewan 🐾', food:'Makanan 🍕', nature:'Alam 🌸', objects:'Objek 🎸', space:'Luar Angkasa 🌌' };
  $('display-level-badge').textContent = levelNames[room.level] || room.level;
  $('display-theme-badge').textContent = themeNames[room.theme] || room.theme;
  renderWaitingPlayers(room);
  showScreen('screen-waiting');
}

function renderWaitingPlayers(room) {
  const me = myId();
  const isHost = room.host === me;
  $('btn-start-game').style.display = isHost ? 'inline-flex' : 'none';
  $('players-grid').innerHTML = room.players.map(p => `
    <div class="player-slot filled ${p.id === room.host ? 'host-slot' : ''} ${p.connected === false ? 'offline-slot' : ''}">
      <span class="slot-status"></span>
      <span class="slot-avatar">${p.avatar}</span>
      <div class="slot-name">${escapeHtml(p.name)}</div>
      ${p.id === room.host ? '<span class="slot-badge">👑 Host</span>' : ''}
      ${p.id === me && p.id !== room.host ? '<span class="slot-badge" style="background:rgba(78,205,196,0.15);color:#4ECDC4">Kamu</span>' : ''}
    </div>
  `).join('');
}

// ═══ GAME UI ═════════════════════════════════════════════════════════════════
function initGame(room) {
  state.roomData = room;
  state.flippedThisTurn = [];
  state.isAnimating = false;
  renderBoard(room.board, room.level);
  renderScores(room.players, room.currentTurn);
  renderTurnDisplay(room.currentTurn, room.players);
  updatePowerupUI(room);
  $('chat-messages').innerHTML = '';
  if (room.chat) room.chat.forEach(addChatMessage);
  showScreen('screen-game');
}

function renderBoard(board, level) {
  const gameBoard = $('game-board');
  gameBoard.className = `game-board board-${level}`;
  gameBoard.innerHTML = board.map(card => `
    <div class="card ${card.flipped?'flipped':''} ${card.matched?'matched':''}" data-id="${card.id}" id="card-${card.id}">
      <div class="card-inner">
        <div class="card-face card-back"></div>
        <div class="card-face card-front">${card.emoji || ''}</div>
      </div>
    </div>
  `).join('');
  gameBoard.addEventListener('click', handleCardClick);
}

function handleCardClick(e) {
  const cardEl = e.target.closest('.card');
  if (!cardEl) return;
  const cardId = parseInt(cardEl.dataset.id);
  if (!state.roomData) return;
  if (state.roomData.currentTurn !== myId()) { toast('Bukan giliran kamu! ⏳', 'info', 1500); return; }
  if (state.isAnimating) return;
  if (cardEl.classList.contains('flipped') || cardEl.classList.contains('matched')) return;
  SFX.flip();
  socket.emit('flip_card', { cardId });
}

function flipCardUI(cardId, emoji) {
  const cardEl = $(`card-${cardId}`);
  if (!cardEl) return;
  cardEl.querySelector('.card-front').textContent = emoji;
  cardEl.classList.add('flipped');
}

function renderScores(players, currentTurn) {
  $('score-list').innerHTML = players.map(p => `
    <div class="score-item ${p.id === currentTurn ? 'current-turn' : ''}">
      <div class="score-avatar">${p.avatar}</div>
      <div class="score-info">
        <div class="score-name">${escapeHtml(p.name)}${p.id === myId() ? ' (Aku)' : ''}</div>
        <div class="score-matches">${p.matches} pasang</div>
      </div>
      <div class="score-pts">${p.score}</div>
    </div>
  `).join('');
}

function renderTurnDisplay(currentTurnId, players) {
  const player = players?.find(p => p.id === currentTurnId);
  if (!player) return;
  const isMe = currentTurnId === myId();
  $('current-turn-display').innerHTML = `${player.avatar} ${escapeHtml(player.name)}${isMe ? ' 👈' : ''}`;
  $('current-turn-display').style.color = isMe ? '#FFE66D' : 'var(--text-m)';
}

function updateTimerBar(timeLeft, maxTime = 30) {
  const pct = (timeLeft / maxTime) * 100;
  const bar = $('timer-bar');
  bar.style.width = `${pct}%`;
  bar.className = `timer-bar${timeLeft <= 10 ? ' warning' : ''}`;
  $('timer-text').textContent = timeLeft;
  $('timer-text').style.color = timeLeft <= 10 ? '#FF6B6B' : 'var(--c3)';
}

function updatePowerupUI(room) {
  const me = room.players?.find(p => p.id === myId());
  const isMyTurn = room.currentTurn === myId();
  const hasPU = me && me.powerups > 0;
  $('my-powerups').textContent = me ? me.powerups : 0;
  document.querySelectorAll('.pu-btn').forEach(btn => { btn.disabled = !isMyTurn || !hasPU; });
  $('powerup-panel').style.display = room.config?.powerups === 0 ? 'none' : 'block';
}

// ═══ CHAT ════════════════════════════════════════════════════════════════════
function addChatMessage(msg) {
  const el = document.createElement('div');
  el.className = msg.system ? 'chat-msg system' : 'chat-msg';
  el.innerHTML = msg.system
    ? escapeHtml(msg.msg)
    : `<span class="cm-author">${escapeHtml(msg.from)}:</span> ${escapeHtml(msg.msg)}`;
  const msgs = $('chat-messages');
  msgs.appendChild(el);
  msgs.scrollTop = msgs.scrollHeight;
}

function initChatControls() {
  $('chat-send-btn').addEventListener('click', sendChat);
  $('chat-input').addEventListener('keyup', e => { if (e.key === 'Enter') sendChat(); });
}

function sendChat() {
  const input = $('chat-input');
  const msg = input.value.trim();
  if (!msg) return;
  SFX.click();
  socket.emit('chat_message', { msg });
  input.value = '';
}

// ═══ ONLINE STATUS UI ════════════════════════════════════════════════════════
function renderOnlineUsers(users) {
  // Update count
  const countEl = $('online-count');
  if (countEl) countEl.textContent = users.length;

  // Waiting room bar — tampilkan sebagai pill kecil
  const listEl = $('online-list');
  if (listEl) {
    listEl.innerHTML = users.map(u => `
      <div class="online-user">
        <span class="u-dot"></span>
        <span>${u.avatar} ${escapeHtml(u.name)}${u.id === myId() ? ' (Kamu)' : ''}</span>
      </div>
    `).join('');
  }

  // In-game panel
  const ingameEl = $('ingame-online-list');
  if (ingameEl && state.roomData) {
    const roomUsers = state.roomData.players.map(p => ({
      ...p, isOnline: users.some(u => u.id === p.id)
    }));
    ingameEl.innerHTML = roomUsers.map(p => `
      <div class="ingame-user ${p.isOnline ? '' : 'offline'}">
        <span class="iu-dot"></span>
        <span>${p.avatar}</span>
        <span class="iu-name">${escapeHtml(p.name)}${p.id === myId() ? ' (Aku)' : ''}</span>
        <span class="iu-badge">${p.isOnline ? 'Online' : 'Offline'}</span>
      </div>
    `).join('');
  }
}

socket.on('online_users', ({ users }) => {
  renderOnlineUsers(users);
});

// ═══ REACTIONS ═══════════════════════════════════════════════════════════════
function initReactionControls() {
  document.querySelectorAll('.react-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const emoji = btn.dataset.emoji;
      socket.emit('send_reaction', { emoji });
      // Show immediately for self too
      spawnReaction(emoji);
    });
  });
}

// ═══ POWER-UPS ═══════════════════════════════════════════════════════════════
function initPowerupControls() {
  document.querySelectorAll('.pu-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      SFX.powerup();
      socket.emit('use_powerup', { type: btn.dataset.type });
    });
  });
}

// ═══ GAME OVER ════════════════════════════════════════════════════════════════
function showGameOver({ winner, results, time, leaderboard }) {
  const isWinner = winner.id === myId();
  isWinner ? SFX.win() : SFX.gameOver();
  launchFireworks();

  const timeStr = s => `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
  const medals = ['🥇','🥈','🥉'];

  $('winner-display').innerHTML = `
    <div class="winner-label">🎊 Pemenang</div>
    <div class="winner-name">${winner.avatar} ${escapeHtml(winner.name)}</div>
    <div style="color:var(--text-m);font-size:.88rem;margin-top:.3rem">${winner.score} poin · ${winner.matches} pasang · ${timeStr(time)}</div>
  `;

  const sorted = [...results].sort((a, b) => b.score - a.score);
  $('results-list').innerHTML = sorted.map((p, i) => `
    <div class="result-item">
      <div class="result-rank">${medals[i] || `#${i+1}`}</div>
      <div class="result-avatar">${p.avatar}</div>
      <div class="result-info">
        <div class="result-name">${escapeHtml(p.name)}${p.id === myId() ? ' (Aku)' : ''}</div>
        <div class="result-stats">${p.matches} pasang cocok</div>
      </div>
      <div class="result-score">${p.score}</div>
    </div>
  `).join('');

  if (leaderboard?.length) {
    $('gameover-lb-list').innerHTML = leaderboard.slice(0, 5).map((e, i) => `
      <div class="gameover-lb-item">
        <span class="glb-rank">${medals[i] || `#${i+1}`}</span>
        <span>${e.avatar || '🎴'}</span>
        <span class="glb-name">${escapeHtml(e.name)}</span>
        <span class="glb-score">${e.score}</span>
      </div>
    `).join('');
  }

  showScreen('screen-gameover');
}

// ═══ SOCKET EVENTS ════════════════════════════════════════════════════════════
socket.on('connect', () => { state.myId = socket.id; });
socket.on('error', ({ msg }) => toast(msg, 'error'));

socket.on('room_created', ({ room }) => { enterWaitingRoom(room); toast(`Room ${room.code} dibuat! 🎉`, 'success'); });
socket.on('joined_room', ({ room }) => { enterWaitingRoom(room); toast(`Bergabung ke room ${room.code}! 🚀`, 'success'); });

socket.on('player_joined', ({ player, room }) => {
  state.roomData = room; renderWaitingPlayers(room);
  toast(`${player.name} bergabung! ${player.avatar}`, 'info');
  SFX.click();
});

socket.on('player_left', ({ players }) => {
  if (state.roomData) { state.roomData.players = players; renderWaitingPlayers(state.roomData); }
});
socket.on('player_disconnected', ({ name }) => toast(`${name || 'Pemain'} terputus 😔`, 'error'));

socket.on('host_changed', ({ newHost }) => {
  if (state.roomData) {
    state.roomData.host = newHost;
    if (newHost === myId()) toast('Kamu sekarang host! 👑', 'success');
    renderWaitingPlayers(state.roomData);
  }
});

socket.on('kicked', ({ msg }) => { toast(msg, 'error'); showScreen('screen-lobby'); state.roomData = null; });

socket.on('game_started', ({ room }) => {
  state.roomData = room; initGame(room);
  SFX.turn(); toast('Game dimulai! 🎮', 'success');
});

socket.on('card_flipped', ({ cardId, emoji, flippedCards }) => {
  flipCardUI(cardId, emoji);
  state.flippedThisTurn = flippedCards;
  if (flippedCards.length === 2) state.isAnimating = true;
});

socket.on('cards_matched', ({ cardIds, players, currentTurn, combo }) => {
  state.isAnimating = false; state.flippedThisTurn = [];
  cardIds.forEach(id => {
    const el = $(`card-${id}`);
    if (el) { el.classList.remove('flipped'); el.classList.add('matched'); }
  });
  combo > 1 ? SFX.combo() : SFX.match();
  if (state.roomData) {
    state.roomData.players = players; state.roomData.currentTurn = currentTurn;
    renderScores(players, currentTurn); renderTurnDisplay(currentTurn, players); updatePowerupUI(state.roomData);
  }
  const comboMsg = combo > 1 ? ` COMBO x${combo}! 🔥` : '';
  showMatchMessage(`✅ Cocok!${comboMsg}`, combo > 1 ? '#FF8C42' : '#06D6A0');
});

socket.on('cards_mismatched', ({ cardIds }) => {
  state.isAnimating = false; state.flippedThisTurn = [];
  SFX.mismatch();
  cardIds.forEach(id => {
    const el = $(`card-${id}`);
    if (el) {
      el.classList.add('mismatch');
      setTimeout(() => { el.classList.remove('flipped', 'mismatch'); el.querySelector('.card-front').textContent = ''; }, 600);
    }
  });
  showMatchMessage('❌ Tidak cocok!', '#FF6B6B');
});

socket.on('turn_changed', ({ currentTurn, board }) => {
  if (!state.roomData) return;
  state.roomData.currentTurn = currentTurn;
  if (board) {
    board.forEach(c => {
      const el = $(`card-${c.id}`); if (!el) return;
      if (c.matched && !el.classList.contains('matched')) { el.classList.add('matched'); el.classList.remove('flipped'); }
      if (!c.flipped && !c.matched) { el.classList.remove('flipped'); el.querySelector('.card-front').textContent = ''; }
    });
  }
  renderTurnDisplay(currentTurn, state.roomData.players);
  renderScores(state.roomData.players, currentTurn);
  updatePowerupUI(state.roomData);
  if (currentTurn === myId()) { SFX.turn(); toast('Giliran kamu! 🎯', 'info', 1500); }
});

socket.on('turn_timer', ({ timeLeft, currentTurn }) => {
  updateTimerBar(timeLeft);
  if (timeLeft === 10 && currentTurn === myId()) toast('10 detik tersisa! ⏰', 'error', 1500);
});

socket.on('powerup_peek', ({ cards, duration }) => {
  cards.forEach(c => {
    const el = $(`card-${c.id}`);
    if (el && !el.classList.contains('matched')) { el.querySelector('.card-front').textContent = c.emoji; el.classList.add('flipped'); }
  });
  toast('👁️ Mengintip kartu...', 'info', 2000);
  clearTimeout(state.peekTimeout);
  state.peekTimeout = setTimeout(() => {
    cards.forEach(c => {
      const el = $(`card-${c.id}`);
      if (el && !el.classList.contains('matched') && !state.flippedThisTurn.includes(c.id)) {
        el.classList.remove('flipped'); el.querySelector('.card-front').textContent = '';
      }
    });
  }, duration);
});

socket.on('powerup_used', ({ player, type, players }) => {
  const names = { peek:'intip kartu', freeze:'bekukan lawan', shuffle:'acak kartu' };
  toast(`${player} ⚡ ${names[type] || type}`, 'info');
  SFX.powerup();
  if (players && state.roomData) { state.roomData.players = players; renderScores(players, state.roomData.currentTurn); updatePowerupUI(state.roomData); }
});

socket.on('board_shuffled', ({ board }) => {
  board.forEach(c => {
    const el = $(`card-${c.id}`); if (!el || el.classList.contains('matched')) return;
    el.classList.remove('flipped'); el.querySelector('.card-front').textContent = c.emoji || '';
    el.style.animation = 'pop-in 0.4s cubic-bezier(0.175,0.885,0.32,1.275)';
    setTimeout(() => { el.style.animation = ''; }, 400);
  });
  toast('🔀 Kartu diacak!', 'info');
});

socket.on('game_over', data => { showGameOver(data); });

socket.on('chat_message', msg => { if ($('screen-game').classList.contains('active')) addChatMessage(msg); });

socket.on('leaderboard_data', ({ leaderboard }) => renderLobbyLeaderboard(leaderboard));

// ═══ CONTROLS INIT ═══════════════════════════════════════════════════════════
function initWaitingControls() {
  $('btn-start-game').addEventListener('click', () => { SFX.click(); socket.emit('start_game'); });
  $('btn-leave-room').addEventListener('click', () => {
    SFX.click();
    socket.disconnect(); socket.connect();
    state.roomData = null; showScreen('screen-lobby');
  });
  $('copy-code-btn').addEventListener('click', () => {
    navigator.clipboard.writeText($('display-room-code').textContent).then(() => toast('Kode disalin! 📋', 'success'));
  });
}

function initGameOverControls() {
  $('btn-play-again').addEventListener('click', () => { SFX.click(); showScreen('screen-lobby'); });
  $('btn-back-home').addEventListener('click', () => { SFX.click(); state.roomData = null; showScreen('screen-lobby'); });
}

// ═══ BOOT ═════════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initSoundToggle();
  $('theme-toggle').addEventListener('click', toggleTheme);
  createParticles();
  initLobby();
  initWaitingControls();
  initChatControls();
  initReactionControls();
  initPowerupControls();
  initGameOverControls();
  showScreen('screen-lobby');
});