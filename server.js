const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── Data Storage ──────────────────────────────────────────────────────────
const LEADERBOARD_FILE = path.join(__dirname, 'data', 'leaderboard.json');
if (!fs.existsSync(path.join(__dirname, 'data'))) fs.mkdirSync(path.join(__dirname, 'data'));
if (!fs.existsSync(LEADERBOARD_FILE)) fs.writeFileSync(LEADERBOARD_FILE, '[]');

function readLeaderboard() {
  try { return JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf8')); }
  catch { return []; }
}

function saveLeaderboard(data) {
  fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(data, null, 2));
}

function addToLeaderboard(entry) {
  const lb = readLeaderboard();
  lb.push({ ...entry, date: new Date().toISOString() });
  lb.sort((a, b) => {
    if (b.matches !== a.matches) return b.matches - a.matches;
    return a.time - b.time;
  });
  const top = lb.slice(0, 50);
  saveLeaderboard(top);
  return top;
}

// ─── Game Config ───────────────────────────────────────────────────────────
const LEVELS = {
  easy:   { rows: 3, cols: 4, pairs: 6,  name: 'Mudah',  powerups: 2 },
  medium: { rows: 4, cols: 6, pairs: 12, name: 'Sedang', powerups: 1 },
  hard:   { rows: 5, cols: 8, pairs: 20, name: 'Sulit',  powerups: 0 }
};

const EMOJI_THEMES = {
  animals:  ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔','🐧','🐦','🦆','🦅','🦋','🐛','🐌','🐜'],
  food:     ['🍎','🍊','🍋','🍇','🍓','🫐','🍒','🍑','🥭','🍍','🥝','🍅','🥑','🌽','🥕','🫛','🍄','🧅','🍆','🫑','🥦','🧄','🫚','🌶'],
  nature:   ['🌸','🌺','🌻','🌹','🌷','🌼','💐','🌿','🍀','🌱','🌲','🌳','🌴','🎋','🎍','🍁','🍂','🍃','🌾','☘️','🌵','🎄','🌰','🍄'],
  objects:  ['🎸','🎹','🎺','🎻','🥁','🪘','🎷','🎵','🎮','🕹️','🎯','🎱','🏆','🥇','🎭','🎪','🎨','🖼️','📸','🔭','🎁','💎','🧩','🪄'],
  space:    ['🌍','🌙','⭐','☀️','🌟','💫','✨','🌈','⚡','🔥','💧','🌊','❄️','🌪️','🌈','🌅','🌄','🌠','🎆','🎇','🪐','🌌','☄️','🛸']
};

// ─── Room Management ───────────────────────────────────────────────────────
const rooms = new Map();

// ─── Online Users (global lobby) ──────────────────────────────────────────
const onlineUsers = new Map(); // socketId -> { name, avatar, status }

function broadcastOnlineUsers() {
  const users = [...onlineUsers.values()];
  io.emit("online_users", { users, count: users.length });
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function createBoard(level, theme) {
  const config = LEVELS[level];
  const allEmojis = EMOJI_THEMES[theme] || EMOJI_THEMES.animals;
  const selected = allEmojis.slice(0, config.pairs);
  const cards = [...selected, ...selected]
    .sort(() => Math.random() - 0.5)
    .map((emoji, index) => ({ id: index, emoji, flipped: false, matched: false }));
  return cards;
}

function createRoom(hostName, level, theme, hostSocketId) {
  const code = generateRoomCode();
  const config = LEVELS[level];
  const board = createBoard(level, theme);
  const room = {
    code,
    host: hostSocketId,
    level,
    theme,
    config,
    board,
    players: [{
      id: hostSocketId,
      name: hostName,
      score: 0,
      matches: 0,
      powerups: config.powerups,
      avatar: getAvatar(hostName),
      connected: true
    }],
    state: 'waiting',   // waiting | playing | finished
    currentTurn: hostSocketId,
    flippedCards: [],
    chat: [],
    startTime: null,
    turnTimer: null,
    turnTimeLeft: 30,
    consecutiveMatches: {}
  };
  rooms.set(code, room);
  return room;
}

function getAvatar(name) {
  const avatars = ['🦊','🐼','🦁','🐯','🐸','🦋','🐬','🦄','🐙','🦜'];
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff;
  return avatars[Math.abs(hash) % avatars.length];
}

function getRoomPublic(room) {
  return {
    code: room.code, host: room.host, level: room.level, theme: room.theme,
    config: room.config, board: room.board.map(c => ({
      id: c.id,
      emoji: (c.flipped || c.matched) ? c.emoji : null,
      flipped: c.flipped, matched: c.matched
    })),
    players: room.players, state: room.state,
    currentTurn: room.currentTurn, chat: room.chat.slice(-30),
    turnTimeLeft: room.turnTimeLeft,
    startTime: room.startTime
  };
}

// ─── Turn Timer ────────────────────────────────────────────────────────────
function startTurnTimer(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  clearInterval(room.turnTimer);
  room.turnTimeLeft = 30;
  room.turnTimer = setInterval(() => {
    room.turnTimeLeft--;
    io.to(roomCode).emit('turn_timer', { timeLeft: room.turnTimeLeft, currentTurn: room.currentTurn });
    if (room.turnTimeLeft <= 0) {
      clearInterval(room.turnTimer);
      // Auto-flip back and pass turn
      if (room.flippedCards.length > 0) {
        room.flippedCards.forEach(id => { room.board[id].flipped = false; });
        room.flippedCards = [];
      }
      passTurn(room, roomCode);
    }
  }, 1000);
}

function passTurn(room, roomCode) {
  const activePlayers = room.players.filter(p => p.connected);
  if (activePlayers.length === 0) return;
  const idx = activePlayers.findIndex(p => p.id === room.currentTurn);
  const next = activePlayers[(idx + 1) % activePlayers.length];
  room.currentTurn = next.id;
  room.consecutiveMatches[room.currentTurn] = 0;
  io.to(roomCode).emit('turn_changed', { currentTurn: room.currentTurn, board: getRoomPublic(room).board });
  startTurnTimer(roomCode);
}

// ─── Socket.IO Events ──────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // Kirim daftar online saat user baru connect
  socket.emit('online_users', { users: [...onlineUsers.values()], count: onlineUsers.size });

  // ── Set Online (dipanggil saat user masukkan nama) ────────────────────────
  socket.on('set_online', ({ name }) => {
    if (!name || name.length > 20) return;
    const avatars = ['🦊','🐼','🦁','🐯','🐸','🦋','🐬','🦄','🐙','🦜'];
    let hash = 0;
    for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff;
    const avatar = avatars[Math.abs(hash) % avatars.length];
    socket.data.name = name;
    socket.data.avatar = avatar;
    onlineUsers.set(socket.id, { id: socket.id, name, avatar, status: 'online', since: Date.now() });
    broadcastOnlineUsers();
    console.log(`[online] ${name} is now online`);
  });

  // ── Create Room ──────────────────────────────────────────────────────────
  socket.on('create_room', ({ name, level, theme }) => {
    if (!name || !level || !LEVELS[level]) {
      return socket.emit('error', { msg: 'Data tidak valid.' });
    }
    const room = createRoom(name, level, theme || 'animals', socket.id);
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.name = name;
    socket.emit('room_created', { room: getRoomPublic(room) });
    console.log(`[room] Created ${room.code} by ${name}`);
  });

  // ── Join Room ────────────────────────────────────────────────────────────
  socket.on('join_room', ({ name, code }) => {
    const room = rooms.get(code?.toUpperCase());
    if (!room) return socket.emit('error', { msg: 'Room tidak ditemukan.' });
    if (room.state === 'playing') return socket.emit('error', { msg: 'Game sudah dimulai.' });
    if (room.players.length >= 4) return socket.emit('error', { msg: 'Room penuh (maks 4 pemain).' });
    if (room.players.find(p => p.id === socket.id)) return;

    const config = LEVELS[room.level];
    const player = {
      id: socket.id, name, score: 0, matches: 0,
      powerups: config.powerups, avatar: getAvatar(name), connected: true
    };
    room.players.push(player);
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.name = name;

    io.to(room.code).emit('player_joined', { player, room: getRoomPublic(room) });
    socket.emit('joined_room', { room: getRoomPublic(room) });
    console.log(`[room] ${name} joined ${room.code}`);
  });

  // ── Start Game ───────────────────────────────────────────────────────────
  socket.on('start_game', () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room) return;
    if (room.host !== socket.id) return socket.emit('error', { msg: 'Hanya host yang bisa memulai.' });
    if (room.players.length < 1) return socket.emit('error', { msg: 'Butuh minimal 1 pemain.' });

    room.state = 'playing';
    room.startTime = Date.now();
    room.currentTurn = room.players[0].id;
    room.consecutiveMatches = {};
    room.players.forEach(p => { room.consecutiveMatches[p.id] = 0; });

    io.to(code).emit('game_started', { room: getRoomPublic(room) });
    startTurnTimer(code);
    console.log(`[game] Started in ${code}`);
  });

  // ── Flip Card ────────────────────────────────────────────────────────────
  socket.on('flip_card', ({ cardId }) => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || room.state !== 'playing') return;
    if (room.currentTurn !== socket.id) return socket.emit('error', { msg: 'Bukan giliran kamu.' });

    const card = room.board[cardId];
    if (!card || card.flipped || card.matched) return;
    if (room.flippedCards.length >= 2) return;

    card.flipped = true;
    room.flippedCards.push(cardId);
    io.to(code).emit('card_flipped', { cardId, emoji: card.emoji, flippedCards: room.flippedCards });

    if (room.flippedCards.length === 2) {
      const [a, b] = room.flippedCards;
      const cardA = room.board[a];
      const cardB = room.board[b];

      setTimeout(() => {
        if (cardA.emoji === cardB.emoji) {
          // Match!
          cardA.matched = true; cardB.matched = true;
          cardA.flipped = false; cardB.flipped = false;
          const player = room.players.find(p => p.id === socket.id);
          if (player) {
            room.consecutiveMatches[socket.id] = (room.consecutiveMatches[socket.id] || 0) + 1;
            const combo = room.consecutiveMatches[socket.id];
            const bonus = combo > 1 ? combo - 1 : 0;
            player.score += 10 + (bonus * 5);
            player.matches += 1;
          }
          room.flippedCards = [];
          io.to(code).emit('cards_matched', {
            cardIds: [a, b], players: room.players,
            currentTurn: room.currentTurn,
            combo: room.consecutiveMatches[socket.id]
          });

          // Check win
          const allMatched = room.board.every(c => c.matched);
          if (allMatched) {
            clearInterval(room.turnTimer);
            room.state = 'finished';
            const elapsed = Math.floor((Date.now() - room.startTime) / 1000);
            const winner = room.players.reduce((a, b) => a.score > b.score ? a : b);
            const results = room.players.map(p => ({ ...p, time: elapsed }));

            // Save to leaderboard
            results.forEach(p => {
              addToLeaderboard({ name: p.name, score: p.score, matches: p.matches, level: room.level, time: elapsed, avatar: p.avatar });
            });

            io.to(code).emit('game_over', { winner, results, time: elapsed, leaderboard: readLeaderboard().slice(0, 10) });
            console.log(`[game] Over in ${code}, winner: ${winner.name}`);
          } else {
            startTurnTimer(code);
          }
        } else {
          // No match
          cardA.flipped = false; cardB.flipped = false;
          room.flippedCards = [];
          room.consecutiveMatches[socket.id] = 0;
          io.to(code).emit('cards_mismatched', { cardIds: [a, b] });
          passTurn(room, code);
        }
      }, 1000);
    }
  });

  // ── Use Power-up ─────────────────────────────────────────────────────────
  socket.on('use_powerup', ({ type }) => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || room.state !== 'playing') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.powerups <= 0) return socket.emit('error', { msg: 'Tidak ada power-up tersisa.' });

    player.powerups--;

    if (type === 'peek') {
      // Reveal all cards for 2 seconds (only to the player)
      const allEmojis = room.board.map(c => ({ id: c.id, emoji: c.emoji }));
      socket.emit('powerup_peek', { cards: allEmojis, duration: 2000 });
      io.to(code).emit('powerup_used', { player: player.name, type: 'peek', players: room.players });
    } else if (type === 'freeze') {
      // Skip next player's turn
      const activePlayers = room.players.filter(p => p.connected);
      const idx = activePlayers.findIndex(p => p.id === socket.id);
      const nextIdx = (idx + 1) % activePlayers.length;
      const nextNext = activePlayers[(nextIdx + 1) % activePlayers.length];
      room.currentTurn = nextNext.id;
      io.to(code).emit('powerup_used', { player: player.name, type: 'freeze', players: room.players });
      io.to(code).emit('turn_changed', { currentTurn: room.currentTurn, board: getRoomPublic(room).board });
      startTurnTimer(code);
    } else if (type === 'shuffle') {
      // Shuffle unmatched cards
      const unmatched = room.board.filter(c => !c.matched);
      const emojis = unmatched.map(c => c.emoji).sort(() => Math.random() - 0.5);
      unmatched.forEach((c, i) => { c.emoji = emojis[i]; });
      io.to(code).emit('powerup_used', { player: player.name, type: 'shuffle', players: room.players });
      io.to(code).emit('board_shuffled', { board: getRoomPublic(room).board });
    }
  });

  // ── Reaction ──────────────────────────────────────────────────────────────
  socket.on('send_reaction', ({ emoji }) => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room) return;
    const allowed = ['👍','🔥','😱','😂','😭','💀'];
    if (!allowed.includes(emoji)) return;
    // Broadcast to others only (sender already shows it locally)
    socket.to(code).emit('reaction', { emoji });
  });

  // ── Chat ──────────────────────────────────────────────────────────────────
  socket.on('chat_message', ({ msg }) => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || !msg.trim() || msg.length > 100) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    const message = { from: player.name, avatar: player.avatar, msg: msg.trim(), time: Date.now() };
    room.chat.push(message);
    io.to(code).emit('chat_message', message);
  });

  // ── Kick Player (host only) ───────────────────────────────────────────────
  socket.on('kick_player', ({ targetId }) => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || room.host !== socket.id) return;
    const idx = room.players.findIndex(p => p.id === targetId);
    if (idx === -1) return;
    room.players.splice(idx, 1);
    io.to(targetId).emit('kicked', { msg: 'Kamu dikeluarkan dari room.' });
    io.to(code).emit('player_left', { playerId: targetId, players: room.players });
  });

  // ── Get Leaderboard ───────────────────────────────────────────────────────
  socket.on('get_leaderboard', () => {
    socket.emit('leaderboard_data', { leaderboard: readLeaderboard().slice(0, 20) });
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (player) player.connected = false;

    io.to(code).emit('player_disconnected', { playerId: socket.id, name: player?.name });

    if (room.state === 'playing' && room.currentTurn === socket.id) {
      passTurn(room, code);
    }

    // Clean empty rooms
    const active = room.players.filter(p => p.connected);
    if (active.length === 0) {
      clearInterval(room.turnTimer);
      rooms.delete(code);
      console.log(`[room] Deleted ${code} (empty)`);
    } else if (room.host === socket.id && active.length > 0) {
      room.host = active[0].id;
      io.to(code).emit('host_changed', { newHost: room.host });
    }
    // Hapus dari online users global
    onlineUsers.delete(socket.id);
    broadcastOnlineUsers();
    console.log(`[-] Disconnected: ${socket.id}`);
  });
});

// ─── REST API ─────────────────────────────────────────────────────────────
app.get('/api/leaderboard', (req, res) => {
  res.json(readLeaderboard().slice(0, 20));
});

app.get('/api/rooms/:code', (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Not found' });
  res.json({ code: room.code, players: room.players.length, state: room.state, level: room.level });
});

// ─── ADMIN PANEL ──────────────────────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'; // ganti ini!

// Middleware cek session admin (pakai cookie sederhana)
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token === ADMIN_PASSWORD) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// Login
app.post('/api/admin/login', express.json(), (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ success: true, token: ADMIN_PASSWORD });
  } else {
    res.status(401).json({ error: 'Password salah!' });
  }
});

// Get leaderboard (admin - semua data)
app.get('/api/admin/leaderboard', requireAdmin, (req, res) => {
  res.json(readLeaderboard());
});

// Hapus semua leaderboard
app.delete('/api/admin/leaderboard', requireAdmin, (req, res) => {
  saveLeaderboard([]);
  console.log('[admin] Leaderboard dihapus semua');
  res.json({ success: true, message: 'Leaderboard berhasil dikosongkan!' });
});

// Hapus 1 entri berdasarkan index
app.delete('/api/admin/leaderboard/:index', requireAdmin, (req, res) => {
  const idx = parseInt(req.params.index);
  const lb = readLeaderboard();
  if (idx < 0 || idx >= lb.length) return res.status(404).json({ error: 'Entri tidak ditemukan' });
  const removed = lb.splice(idx, 1)[0];
  saveLeaderboard(lb);
  console.log(`[admin] Hapus entri: ${removed.name}`);
  res.json({ success: true, removed });
});

// Stats
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const lb = readLeaderboard();
  const activeRooms = rooms.size;
  const activePlayers = [...rooms.values()].reduce((sum, r) => sum + r.players.filter(p => p.connected).length, 0);
  res.json({
    totalEntries: lb.length,
    topScore: lb[0]?.score || 0,
    topPlayer: lb[0]?.name || '-',
    activeRooms,
    activePlayers,
    byLevel: {
      easy:   lb.filter(e => e.level === 'easy').length,
      medium: lb.filter(e => e.level === 'medium').length,
      hard:   lb.filter(e => e.level === 'hard').length,
    }
  });
});

// Halaman admin (HTML)
app.get('/admin', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MindMatch Admin</title>
<link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#0F0A1E;--bg2:#1A1035;--bg3:#251847;--text:#F0E6FF;--muted:#9B8EC4;--accent:#A855F7;--danger:#FF6B6B;--success:#06D6A0;--border:rgba(168,85,247,0.2)}
  body{font-family:'Nunito',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
  .card{background:var(--bg3);border:1px solid var(--border);border-radius:20px;padding:2rem;width:100%;max-width:700px;box-shadow:0 20px 60px rgba(0,0,0,0.5)}
  h1{font-size:1.6rem;margin-bottom:0.25rem}h1 span{color:var(--accent)}
  .sub{color:var(--muted);font-size:0.85rem;margin-bottom:1.5rem}
  input[type=password]{width:100%;padding:0.75rem 1rem;background:rgba(255,255,255,0.06);border:1.5px solid rgba(255,255,255,0.1);border-radius:10px;color:var(--text);font-family:'Nunito',sans-serif;font-size:1rem;outline:none;margin-bottom:0.75rem}
  input:focus{border-color:var(--accent)}
  .btn{padding:0.75rem 1.5rem;border-radius:50px;border:none;font-family:'Nunito',sans-serif;font-size:0.9rem;font-weight:800;cursor:pointer;transition:all 0.2s}
  .btn-primary{background:linear-gradient(135deg,var(--accent),#7C3AED);color:white;box-shadow:0 4px 15px rgba(168,85,247,0.3)}
  .btn-primary:hover{transform:translateY(-1px);box-shadow:0 6px 20px rgba(168,85,247,0.4)}
  .btn-danger{background:rgba(255,107,107,0.15);color:var(--danger);border:1.5px solid rgba(255,107,107,0.3)}
  .btn-danger:hover{background:rgba(255,107,107,0.25)}
  .btn-sm{padding:0.35rem 0.75rem;font-size:0.75rem;border-radius:50px}
  #login-section{}
  #admin-section{display:none}
  .stats-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:0.75rem;margin-bottom:1.5rem}
  .stat-box{background:rgba(0,0,0,0.2);border:1px solid var(--border);border-radius:12px;padding:1rem;text-align:center}
  .stat-val{font-size:1.8rem;font-weight:800;color:var(--accent);display:block}
  .stat-label{font-size:0.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em}
  .section-title{font-size:0.75rem;font-weight:800;text-transform:uppercase;letter-spacing:0.1em;color:var(--muted);margin-bottom:0.75rem}
  .lb-table{width:100%;border-collapse:collapse}
  .lb-table th{font-size:0.72rem;text-transform:uppercase;letter-spacing:0.08em;color:var(--muted);padding:0.4rem 0.5rem;text-align:left;border-bottom:1px solid var(--border)}
  .lb-table td{padding:0.5rem;font-size:0.85rem;border-bottom:1px solid rgba(255,255,255,0.04)}
  .lb-table tr:hover td{background:rgba(255,255,255,0.02)}
  .badge{display:inline-block;padding:0.2rem 0.6rem;border-radius:50px;font-size:0.7rem;font-weight:700}
  .b-easy{background:rgba(6,214,160,0.15);color:#06D6A0}
  .b-medium{background:rgba(255,230,109,0.15);color:#FFE66D}
  .b-hard{background:rgba(255,107,107,0.15);color:#FF6B6B}
  .actions{display:flex;gap:0.75rem;align-items:center;margin-bottom:1.25rem;flex-wrap:wrap}
  .toast-msg{position:fixed;bottom:1.5rem;right:1.5rem;background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:0.75rem 1.25rem;font-weight:700;font-size:0.875rem;animation:tin 0.3s ease;z-index:99}
  @keyframes tin{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:translateX(0)}}
  .empty{text-align:center;color:var(--muted);padding:2rem;font-size:0.9rem}
  .logout{font-size:0.8rem;color:var(--muted);cursor:pointer;text-decoration:underline;float:right;margin-top:0.25rem}
  .logout:hover{color:var(--text)}
  .confirm-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:100;align-items:center;justify-content:center}
  .confirm-overlay.show{display:flex}
  .confirm-box{background:var(--bg3);border:1px solid var(--border);border-radius:16px;padding:1.5rem;max-width:360px;width:100%;text-align:center}
  .confirm-box h3{margin-bottom:0.5rem}
  .confirm-box p{color:var(--muted);font-size:0.85rem;margin-bottom:1.25rem}
  .confirm-actions{display:flex;gap:0.75rem;justify-content:center}
  .btn-ghost{background:transparent;border:2px solid rgba(255,255,255,0.15);color:var(--muted);padding:0.6rem 1.25rem;border-radius:50px;font-family:'Nunito',sans-serif;font-size:0.85rem;font-weight:700;cursor:pointer}
</style>
</head>
<body>

<div class="confirm-overlay" id="confirm-overlay">
  <div class="confirm-box">
    <h3>⚠️ Hapus Semua?</h3>
    <p>Semua data leaderboard akan dihapus permanen. Tindakan ini tidak bisa dibatalkan.</p>
    <div class="confirm-actions">
      <button class="btn-ghost" onclick="closeConfirm()">Batal</button>
      <button class="btn btn-danger" onclick="confirmDeleteAll()">Ya, Hapus Semua</button>
    </div>
  </div>
</div>

<div class="card">
  <!-- LOGIN -->
  <div id="login-section">
    <h1>Mind<span>Match</span> 🔐</h1>
    <p class="sub">Admin Panel — masukkan password untuk lanjut</p>
    <input type="password" id="pw-input" placeholder="Password admin..." onkeyup="if(event.key==='Enter')login()">
    <br>
    <button class="btn btn-primary" onclick="login()">Masuk</button>
    <p id="login-err" style="color:var(--danger);font-size:0.82rem;margin-top:0.75rem;display:none"></p>
  </div>

  <!-- ADMIN PANEL -->
  <div id="admin-section">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:1.5rem">
      <div>
        <h1>Mind<span>Match</span> ⚙️</h1>
        <p class="sub">Admin Panel</p>
      </div>
      <span class="logout" onclick="logout()">Keluar</span>
    </div>

    <!-- Stats -->
    <p class="section-title">Statistik</p>
    <div class="stats-grid" id="stats-grid">
      <div class="stat-box"><span class="stat-val" id="s-total">-</span><span class="stat-label">Total Entri</span></div>
      <div class="stat-box"><span class="stat-val" id="s-top">-</span><span class="stat-label">Skor Tertinggi</span></div>
      <div class="stat-box"><span class="stat-val" id="s-rooms">-</span><span class="stat-label">Room Aktif</span></div>
      <div class="stat-box"><span class="stat-val" id="s-players">-</span><span class="stat-label">Pemain Online</span></div>
      <div class="stat-box"><span class="stat-val" id="s-easy">-</span><span class="stat-label">Game Mudah</span></div>
      <div class="stat-box"><span class="stat-val" id="s-medium">-</span><span class="stat-label">Game Sedang</span></div>
      <div class="stat-box"><span class="stat-val" id="s-hard">-</span><span class="stat-label">Game Sulit</span></div>
    </div>

    <!-- Leaderboard -->
    <div class="actions">
      <p class="section-title" style="margin:0;flex:1">Leaderboard</p>
      <button class="btn btn-primary btn-sm" onclick="loadData()">🔄 Refresh</button>
      <button class="btn btn-danger btn-sm" onclick="openConfirm()">🗑️ Hapus Semua</button>
    </div>

    <div id="lb-container">
      <p class="empty">Memuat data...</p>
    </div>
  </div>
</div>

<script>
  let token = sessionStorage.getItem('mm_admin_token') || '';
  const timeStr = s => { const d = new Date(s); return d.toLocaleDateString('id-ID',{day:'2-digit',month:'short',year:'numeric'})+' '+d.toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'}); };
  const durStr = s => s ? Math.floor(s/60)+'m '+( s%60)+'s' : '-';
  const lvlBadge = l => '<span class="badge b-'+l+'">'+(l==='easy'?'Mudah':l==='medium'?'Sedang':'Sulit')+'</span>';

  function showToast(msg, ok=true) {
    const t = document.createElement('div'); t.className='toast-msg';
    t.style.borderColor = ok ? 'rgba(6,214,160,0.4)' : 'rgba(255,107,107,0.4)';
    t.style.color = ok ? '#06D6A0' : '#FF6B6B';
    t.textContent = msg; document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }

  async function login() {
    const pw = document.getElementById('pw-input').value;
    const err = document.getElementById('login-err');
    try {
      const r = await fetch('/api/admin/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({password:pw}) });
      const d = await r.json();
      if (d.success) {
        token = d.token; sessionStorage.setItem('mm_admin_token', token);
        document.getElementById('login-section').style.display = 'none';
        document.getElementById('admin-section').style.display = 'block';
        loadData();
      } else { err.textContent = d.error; err.style.display='block'; }
    } catch(e) { err.textContent='Gagal terhubung ke server'; err.style.display='block'; }
  }

  function logout() {
    token=''; sessionStorage.removeItem('mm_admin_token');
    document.getElementById('admin-section').style.display='none';
    document.getElementById('login-section').style.display='block';
    document.getElementById('pw-input').value='';
  }

  async function loadData() {
    await loadStats(); await loadLeaderboard();
  }

  async function loadStats() {
    try {
      const r = await fetch('/api/admin/stats', { headers:{'x-admin-token':token} });
      const d = await r.json();
      document.getElementById('s-total').textContent = d.totalEntries;
      document.getElementById('s-top').textContent = d.topScore;
      document.getElementById('s-rooms').textContent = d.activeRooms;
      document.getElementById('s-players').textContent = d.activePlayers;
      document.getElementById('s-easy').textContent = d.byLevel.easy;
      document.getElementById('s-medium').textContent = d.byLevel.medium;
      document.getElementById('s-hard').textContent = d.byLevel.hard;
    } catch(e) {}
  }

  async function loadLeaderboard() {
    const c = document.getElementById('lb-container');
    try {
      const r = await fetch('/api/admin/leaderboard', { headers:{'x-admin-token':token} });
      const data = await r.json();
      if (!data.length) { c.innerHTML='<p class="empty">Leaderboard kosong 🎉</p>'; return; }
      c.innerHTML = '<table class="lb-table"><thead><tr><th>#</th><th>Pemain</th><th>Level</th><th>Skor</th><th>Pasang</th><th>Waktu</th><th>Tanggal</th><th></th></tr></thead><tbody>'
        + data.map((e,i) => '<tr><td style="color:var(--muted)">'+(i+1)+'</td><td>'+e.avatar+' '+escHtml(e.name)+'</td><td>'+lvlBadge(e.level)+'</td><td style="font-weight:800;color:#FFE66D">'+e.score+'</td><td>'+e.matches+'</td><td>'+durStr(e.time)+'</td><td style="color:var(--muted);font-size:0.75rem">'+timeStr(e.date)+'</td><td><button class="btn btn-danger btn-sm" onclick="deleteOne('+i+')">✕</button></td></tr>').join('')
        + '</tbody></table>';
    } catch(e) { c.innerHTML='<p class="empty" style="color:var(--danger)">Gagal memuat data</p>'; }
  }

  function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function openConfirm() { document.getElementById('confirm-overlay').classList.add('show'); }
  function closeConfirm() { document.getElementById('confirm-overlay').classList.remove('show'); }

  async function confirmDeleteAll() {
    closeConfirm();
    try {
      const r = await fetch('/api/admin/leaderboard', { method:'DELETE', headers:{'x-admin-token':token} });
      const d = await r.json();
      showToast(d.message || 'Berhasil!'); loadData();
    } catch(e) { showToast('Gagal menghapus', false); }
  }

  async function deleteOne(idx) {
    try {
      const r = await fetch('/api/admin/leaderboard/'+idx, { method:'DELETE', headers:{'x-admin-token':token} });
      const d = await r.json();
      if (d.success) { showToast('Entri dihapus!'); loadData(); }
      else showToast('Gagal', false);
    } catch(e) { showToast('Gagal', false); }
  }

  // Auto-login kalau token masih ada di session
  if (token) {
    document.getElementById('login-section').style.display='none';
    document.getElementById('admin-section').style.display='block';
    loadData();
  }
</script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎮 MindMatch berjalan di http://localhost:${PORT}`);
  console.log(`🔐 Admin panel: http://localhost:${PORT}/admin\n`);
});