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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎮 MindMatch berjalan di http://localhost:${PORT}\n`);
});