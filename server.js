const path = require('path');
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const { Chess } = require('chess.js');

const PORT = process.env.PORT || 3000;
const dbPath = process.env.CHESS_DB_PATH || path.join(__dirname, 'data', 'chess.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new sqlite3.Database(dbPath);
const schemaReady = new Promise((resolve, reject) => db.serialize(() => {
  db.run('PRAGMA journal_mode = WAL');
  db.run(`CREATE TABLE IF NOT EXISTS players (
    username TEXT PRIMARY KEY COLLATE NOCASE, rating INTEGER NOT NULL DEFAULT 1200,
    wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0, draws INTEGER NOT NULL DEFAULT 0,
    bot_wins INTEGER NOT NULL DEFAULT 0, bot_losses INTEGER NOT NULL DEFAULT 0,
    puzzles_solved INTEGER NOT NULL DEFAULT 0, puzzles_attempted INTEGER NOT NULL DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT, room_code TEXT NOT NULL,
    white_username TEXT NOT NULL, black_username TEXT NOT NULL, result TEXT NOT NULL,
    pgn TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'friend', time_control TEXT NOT NULL DEFAULT 'untimed',
    rated INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  // Additive migrations preserve existing Chess Room databases.
  let migrations = 2;
  let migrationFailure = null;
  function migrationDone(err) { if (err) migrationFailure = migrationFailure || err; if (--migrations === 0) migrationFailure ? reject(migrationFailure) : resolve(); }
  function addMissingColumns(table, additions) {
    db.all(`PRAGMA table_info(${table})`, [], (err, cols) => {
      if (err) { migrationDone(err); return; }
      const names = (cols || []).map(c => c.name), missing = additions.filter(([name]) => !names.includes(name));
      if (!missing.length) { migrationDone(); return; }
      let pending = missing.length;
      missing.forEach(([name, type]) => db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`, err2 => {
        if (--pending === 0) migrationDone(err2);
      }));
    });
  }
  addMissingColumns('players', [['bot_wins', 'INTEGER NOT NULL DEFAULT 0'], ['bot_losses', 'INTEGER NOT NULL DEFAULT 0'], ['puzzles_solved', 'INTEGER NOT NULL DEFAULT 0'], ['puzzles_attempted', 'INTEGER NOT NULL DEFAULT 0']]);
  addMissingColumns('games', [['mode', "TEXT NOT NULL DEFAULT 'friend'"], ['time_control', "TEXT NOT NULL DEFAULT 'untimed'"], ['rated', 'INTEGER NOT NULL DEFAULT 1']]);
}));

const rooms = new Map();
const timeControls = { untimed: 0, rapid: 600, blitz: 180 };
function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
function readBody(req, cb) { let body = ''; req.on('data', chunk => { body += chunk; if (body.length > 16384) req.destroy(); }); req.on('end', () => { try { cb(null, JSON.parse(body || '{}')); } catch (_) { cb(new Error('Invalid JSON')); } }); }
function cleanName(name) { return String(name || '').trim().replace(/\s+/g, ' ').slice(0, 20); }
function ensurePlayer(name, cb) {
  db.run('INSERT OR IGNORE INTO players(username) VALUES (?)', [name], err => {
    if (err) return cb(err);
    db.get('SELECT * FROM players WHERE username = ? COLLATE NOCASE', [name], cb);
  });
}
function profileFor(name, cb) {
  const username = cleanName(name);
  if (!/^[\p{L}\p{N}_ -]{2,20}$/u.test(username)) return cb(new Error('Use 2–20 letters, numbers, spaces, underscores, or hyphens.'));
  ensurePlayer(username, cb);
}
function scoreForMove(move) { const value = { p: 1, n: 3, b: 3.2, r: 5, q: 9, k: 0 }; return (move.captured ? value[move.captured] * 10 : 0) + (move.promotion ? 8 : 0) + (move.san && move.san.includes('+') ? 2 : 0) + (move.san && move.san.includes('#') ? 100 : 0); }
function pickBotMove(fen) {
  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true });
  if (!moves.length) return null;
  // A modest, intentionally approachable opponent: favor checks, captures and promotion,
  // with a little randomness so it does not repeat a fixed line every game.
  const ranked = moves.map(move => ({ move, score: scoreForMove(move) + Math.random() * 2 })).sort((a, b) => b.score - a.score);
  const pool = ranked.filter(item => item.score >= ranked[0].score - 2.5).slice(0, 4);
  const picked = pool[Math.floor(Math.random() * pool.length)].move;
  return { from: picked.from, to: picked.to, promotion: picked.promotion || 'q', san: picked.san };
}

const publicDir = path.join(__dirname, 'public');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/api/profile') {
    return profileFor(url.searchParams.get('username'), (err, row) => err ? json(res, 400, { error: err.message }) : json(res, 200, row));
  }
  if (req.method === 'GET' && url.pathname === '/api/leaderboard') {
    return db.all('SELECT username, rating, wins, losses, draws FROM players ORDER BY rating DESC, wins DESC LIMIT 10', [], (err, rows) => err ? json(res, 500, { error: 'Could not load leaderboard' }) : json(res, 200, rows || []));
  }
  if (req.method === 'POST' && url.pathname === '/api/bot-move') {
    return readBody(req, (err, body) => {
      if (err || !body.fen) return json(res, 400, { error: 'A valid FEN is required.' });
      try { const move = pickBotMove(body.fen); return json(res, 200, { move }); } catch (_) { return json(res, 400, { error: 'Invalid chess position.' }); }
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/legal-moves') {
    try {
      const chess = new Chess(url.searchParams.get('fen') || undefined);
      const from = url.searchParams.get('from');
      return json(res, 200, { moves: chess.moves({ verbose: true }).filter(move => !from || move.from === from).map(move => ({ from: move.from, to: move.to, promotion: move.promotion || null })) });
    } catch (_) { return json(res, 400, { error: 'Invalid chess position.' }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/local-move') {
    return readBody(req, (err, body) => {
      if (err || !body.fen || !body.from || !body.to) return json(res, 400, { error: 'Position and move are required.' });
      try {
        const chess = new Chess(body.fen);
        const move = chess.move({ from: body.from, to: body.to, promotion: body.promotion || 'q' });
        if (!move) return json(res, 400, { error: 'That is not a legal move.' });
        return json(res, 200, { fen: chess.fen(), pgn: chess.pgn(), turn: chess.turn(), check: chess.in_check(), status: chess.game_over() ? (chess.in_checkmate() ? 'checkmate' : chess.in_stalemate() ? 'stalemate' : chess.in_draw() ? 'draw' : 'over') : 'playing', result: chess.in_checkmate() ? (chess.turn() === 'w' ? 'black' : 'white') : chess.in_draw() ? 'draw' : null, san: move.san });
      } catch (_) { return json(res, 400, { error: 'Invalid chess position or move.' }); }
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/solo-result') {
    return readBody(req, (err, body) => {
      if (err || !['win', 'loss', 'draw'].includes(body.result)) return json(res, 400, { error: 'Invalid result.' });
      profileFor(body.username, (profileErr, row) => {
        if (profileErr) return json(res, 400, { error: profileErr.message });
        const field = body.result === 'win' ? 'bot_wins' : body.result === 'loss' ? 'bot_losses' : null;
        if (!field) return json(res, 200, { ok: true });
        db.run(`UPDATE players SET ${field} = ${field} + 1 WHERE username = ? COLLATE NOCASE`, [row.username], dbErr => dbErr ? json(res, 500, { error: 'Could not save result.' }) : json(res, 200, { ok: true }));
      });
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/puzzle-result') {
    return readBody(req, (err, body) => {
      if (err || typeof body.solved !== 'boolean') return json(res, 400, { error: 'Invalid puzzle result.' });
      profileFor(body.username, (profileErr, row) => {
        if (profileErr) return json(res, 400, { error: profileErr.message });
        db.run('UPDATE players SET puzzles_attempted = puzzles_attempted + 1, puzzles_solved = puzzles_solved + ? WHERE username = ? COLLATE NOCASE', [body.solved ? 1 : 0, row.username], dbErr => dbErr ? json(res, 500, { error: 'Could not save puzzle result.' }) : json(res, 200, { ok: true }));
      });
    });
  }
  const pathname = decodeURIComponent(url.pathname);
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(publicDir, relative);
  if (file.indexOf(publicDir + path.sep) !== 0) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, content) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json' };
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }); res.end(content);
  });
});
const wss = new WebSocket.Server({ server });

function send(ws, type, payload) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(Object.assign({ type }, payload || {}))); }
function broadcast(room, type, payload) { room.players.forEach(player => send(player.ws, type, payload)); }
function cleanCode(code) { return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); }
function createCode() { let code; do { code = Math.random().toString(36).slice(2, 7).toUpperCase(); } while (rooms.has(code)); return code; }
function clockValues(room) {
  const clocks = Object.assign({}, room.clocks);
  if (room.startedAt && !room.chess.game_over()) clocks[room.chess.turn()] = Math.max(0, clocks[room.chess.turn()] - (Date.now() - room.startedAt) / 1000);
  return { white: Math.max(0, Math.floor(clocks.w)), black: Math.max(0, Math.floor(clocks.b)) };
}
function stateFor(room) {
  const chess = room.chess;
  return { room: room.code, fen: chess.fen(), pgn: chess.pgn(), turn: chess.turn(), players: room.players.map(p => ({ username: p.username, color: p.color, rating: p.rating })), status: chess.game_over() ? (chess.in_checkmate() ? 'checkmate' : chess.in_stalemate() ? 'stalemate' : chess.in_draw() ? 'draw' : 'over') : 'playing', check: chess.in_check(), result: room.result || null, timeControl: room.timeControl, clocks: clockValues(room) };
}
function updateRatedResult(white, black, result, done) {
  db.get('SELECT rating FROM players WHERE username = ? COLLATE NOCASE', [white.username], (err, w) => db.get('SELECT rating FROM players WHERE username = ? COLLATE NOCASE', [black.username], (err2, b) => {
    if (err || err2 || !w || !b) return done && done();
    const expectedW = 1 / (1 + Math.pow(10, (b.rating - w.rating) / 400));
    const scoreW = result === 'white' ? 1 : result === 'draw' ? 0.5 : 0;
    const changeW = Math.round(24 * (scoreW - expectedW));
    db.serialize(() => {
      db.run('UPDATE players SET rating = rating + ?, wins = wins + ?, losses = losses + ?, draws = draws + ? WHERE username = ? COLLATE NOCASE', [changeW, result === 'white' ? 1 : 0, result === 'black' ? 1 : 0, result === 'draw' ? 1 : 0, white.username]);
      db.run('UPDATE players SET rating = rating - ?, wins = wins + ?, losses = losses + ?, draws = draws + ? WHERE username = ? COLLATE NOCASE', [changeW, result === 'black' ? 1 : 0, result === 'white' ? 1 : 0, result === 'draw' ? 1 : 0, black.username], done);
    });
  }));
}
function completeRoom(room, result) {
  if (room.saved) return;
  room.saved = true; room.result = result; room.startedAt = null;
  const white = room.players.find(p => p.color === 'w'), black = room.players.find(p => p.color === 'b');
  if (!white || !black) return;
  db.run('INSERT INTO games(room_code, white_username, black_username, result, pgn, mode, time_control, rated) VALUES (?, ?, ?, ?, ?, ?, ?, 1)', [room.code, white.username, black.username, result, room.chess.pgn(), 'friend', room.timeControl]);
  updateRatedResult(white, black, result, () => broadcast(room, 'state', stateFor(room)));
}
function settleClock(room) {
  if (!room.startedAt || room.chess.game_over() || room.timeControl === 'untimed') return false;
  const values = clockValues(room), side = room.chess.turn();
  if (values[side === 'w' ? 'white' : 'black'] > 0) return false;
  room.clocks[side] = 0; room.startedAt = null;
  completeRoom(room, side === 'w' ? 'black' : 'white');
  return true;
}
function leave(ws) {
  const room = ws.room;
  if (!room) return;
  if (room.startedAt && room.timeControl !== 'untimed') {
    const side = room.chess.turn();
    room.clocks[side] = clockValues(room)[side === 'w' ? 'white' : 'black'];
    room.startedAt = null;
  }
  room.players = room.players.filter(player => player.ws !== ws); ws.room = null;
  if (!room.players.length) { rooms.delete(room.code); return; }
  if (!room.chess.game_over() && !room.result) broadcast(room, 'opponent-left', { message: 'Your opponent left. This room is waiting for a player.' });
  broadcast(room, 'state', stateFor(room));
}

wss.on('connection', ws => {
  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch (_) { return send(ws, 'error', { message: 'Invalid message.' }); }
    if (msg.type === 'join') {
      if (ws.room) return send(ws, 'error', { message: 'You are already in a room.' });
      const username = cleanName(msg.username);
      if (!/^[\p{L}\p{N}_ -]{2,20}$/u.test(username)) return send(ws, 'error', { message: 'Use 2–20 letters, numbers, spaces, underscores, or hyphens.' });
      const creating = !!msg.create, code = creating ? createCode() : cleanCode(msg.room);
      if (!code) return send(ws, 'error', { message: 'Enter a valid room code.' });
      let room = rooms.get(code);
      if (!room && !creating) return send(ws, 'error', { message: 'Room not found. Check the code or create a room.' });
      if (room && room.players.length >= 2) return send(ws, 'error', { message: 'This room is full.' });
      const control = timeControls[msg.timeControl] !== undefined ? msg.timeControl : 'untimed';
      if (!room) { room = { code, chess: new Chess(), players: [], saved: false, result: null, timeControl: control, clocks: { w: timeControls[control], b: timeControls[control] }, startedAt: null }; rooms.set(code, room); }
      if (room.players.some(p => p.username.toLowerCase() === username.toLowerCase())) return send(ws, 'error', { message: 'That username is already in this room.' });
      ensurePlayer(username, (err, profile) => {
        if (err) return send(ws, 'error', { message: 'Could not create player profile.' });
        if (!rooms.has(code) || room.players.length >= 2) return send(ws, 'error', { message: 'Room is no longer available.' });
        const color = room.players.some(player => player.color === 'w') ? 'b' : 'w';
        room.players.push({ ws, username: profile.username, color, rating: profile.rating }); ws.room = room;
        if (room.players.length === 2 && room.timeControl !== 'untimed') room.startedAt = Date.now();
        send(ws, 'joined', { code, color, profile }); broadcast(room, 'state', stateFor(room));
      });
      return;
    }
    const room = ws.room;
    if (!room) return send(ws, 'error', { message: 'Join a room first.' });
    if (msg.type === 'move') {
      const player = room.players.find(p => p.ws === ws);
      if (room.result || room.chess.game_over()) return send(ws, 'error', { message: 'This game is over.' });
      if (settleClock(room)) return;
      if (player.color !== room.chess.turn()) return send(ws, 'error', { message: 'It is your opponent’s turn.' });
      const remaining = room.timeControl !== 'untimed' ? clockValues(room)[player.color === 'w' ? 'white' : 'black'] : null;
      try {
        const move = room.chess.move({ from: msg.from, to: msg.to, promotion: msg.promotion || 'q' });
        if (!move) return send(ws, 'error', { message: 'That is not a legal move.' });
        if (remaining !== null) { room.clocks[player.color] = remaining; room.startedAt = null; }
        if (room.chess.game_over()) { const winner = room.chess.in_checkmate() ? (room.chess.turn() === 'w' ? 'b' : 'w') : null; completeRoom(room, winner ? (winner === 'w' ? 'white' : 'black') : 'draw'); }
        else { if (room.timeControl !== 'untimed' && room.players.length === 2) room.startedAt = Date.now(); broadcast(room, 'state', stateFor(room)); }
      } catch (_) { send(ws, 'error', { message: 'That is not a legal move.' }); }
    } else if (msg.type === 'resign') {
      const player = room.players.find(p => p.ws === ws);
      if (room.players.length < 2 || room.result || room.chess.game_over()) return send(ws, 'error', { message: 'There is no active game to resign.' });
      completeRoom(room, player.color === 'w' ? 'black' : 'white');
    } else if (msg.type === 'leave') leave(ws);
  });
  ws.on('close', () => leave(ws));
});

setInterval(() => { rooms.forEach(room => { if (settleClock(room)) return; if (room.startedAt) broadcast(room, 'clock', { clocks: clockValues(room) }); }); }, 1000).unref();
schemaReady.then(() => server.listen(PORT, () => console.log('Chess server listening on http://localhost:' + PORT))).catch(err => {
  console.error('Database startup failed:', err.message);
  db.close(() => process.exit(1));
});
