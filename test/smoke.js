const assert = require('assert');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const net = require('net');
const spawn = require('child_process').spawn;
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(err => err ? reject(err) : resolve(port)); });
  });
}
function request(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method: data ? 'POST' : 'GET', headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} }, res => {
      let raw = ''; res.setEncoding('utf8'); res.on('data', chunk => { raw += chunk; }); res.on('end', () => { let value; try { value = JSON.parse(raw); } catch (e) { return reject(e); } resolve({ status: res.statusCode, value }); });
    });
    req.once('error', reject); if (data) req.write(data); req.end();
  });
}
function openSocket(port) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket('ws://127.0.0.1:' + port);
    socket.once('open', () => resolve(socket)); socket.once('error', reject);
  });
}
function nextMessage(socket, predicate, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.removeListener('message', onMessage); reject(new Error('Timed out waiting for WebSocket message')); }, timeout || 4000);
    function onMessage(raw) { const msg = JSON.parse(raw); if (predicate(msg)) { clearTimeout(timer); socket.removeListener('message', onMessage); resolve(msg); } }
    socket.on('message', onMessage);
  });
}
function send(socket, value) { socket.send(JSON.stringify(value)); }
function waitReady(port, child) {
  return new Promise((resolve, reject) => {
    const until = Date.now() + 8000;
    (function check() {
      if (child.exitCode !== null) return reject(new Error('Server exited before becoming ready'));
      const req = http.get({ hostname: '127.0.0.1', port, path: '/api/leaderboard' }, res => { res.resume(); if (res.statusCode === 200) return resolve(); retry(); });
      req.on('error', retry); function retry() { if (Date.now() > until) return reject(new Error('Server did not become ready')); setTimeout(check, 100); }
    }());
  });
}
function removeDirectory(directory) {
  if (!fs.existsSync(directory)) return;
  fs.readdirSync(directory).forEach(name => {
    const file = path.join(directory, name);
    if (fs.statSync(file).isDirectory()) removeDirectory(file); else fs.unlinkSync(file);
  });
  fs.rmdirSync(directory);
}
function seedLegacyDatabase(filename) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filename);
    db.serialize(() => {
      db.run(`CREATE TABLE players (username TEXT PRIMARY KEY COLLATE NOCASE, rating INTEGER NOT NULL DEFAULT 1200, wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0, draws INTEGER NOT NULL DEFAULT 0)`);
      db.run(`CREATE TABLE games (id INTEGER PRIMARY KEY AUTOINCREMENT, room_code TEXT NOT NULL, white_username TEXT NOT NULL, black_username TEXT NOT NULL, result TEXT NOT NULL, pgn TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
      db.run('INSERT INTO players(username, rating, wins) VALUES (?, ?, ?)', ['LegacyPlayer', 1340, 7]);
    });
    db.close(err => err ? reject(err) : resolve());
  });
}

(async function main() {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chess-room-test-'));
  const dbPath = path.join(dataDir, 'test.sqlite');
  await seedLegacyDatabase(dbPath);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { PORT: String(port), CHESS_DB_PATH: dbPath }), stdio: 'ignore' });
  let sockets = [];
  try {
    await waitReady(port, child);
    let response = await request(port, '/api/profile?username=SmokeWhite');
    assert.strictEqual(response.status, 200); assert.strictEqual(response.value.rating, 1200); assert.strictEqual(response.value.wins, 0);
    response = await request(port, '/api/profile?username=LegacyPlayer'); assert.strictEqual(response.value.rating, 1340); assert.strictEqual(response.value.wins, 7); assert.strictEqual(response.value.puzzles_solved, 0);
    response = await request(port, '/api/profile?username=x'); assert.strictEqual(response.status, 400);

    const initial = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const legal = await request(port, '/api/legal-moves?fen=' + encodeURIComponent(initial) + '&from=e2');
    assert.strictEqual(legal.status, 200); assert.deepStrictEqual(legal.value.moves.map(m => m.to).sort(), ['e3', 'e4']);
    const bot = await request(port, '/api/bot-move', { fen: initial }); assert.strictEqual(bot.status, 200); assert(bot.value.move);
    const botPlayed = await request(port, '/api/local-move', { fen: initial, from: bot.value.move.from, to: bot.value.move.to, promotion: bot.value.move.promotion }); assert.strictEqual(botPlayed.status, 200);
    const moved = await request(port, '/api/local-move', { fen: initial, from: 'e2', to: 'e4' }); assert.strictEqual(moved.status, 200); assert.strictEqual(moved.value.turn, 'b');
    const illegal = await request(port, '/api/local-move', { fen: initial, from: 'e2', to: 'e5' }); assert.strictEqual(illegal.status, 400);

    const puzzles = [
      ['6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1','d1','d8'],
      ['6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1','e1','e8'],
      ['rnbqkbnr/pppp1p1p/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq g3 0 2','d8','h4'],
      ['6k1/5ppp/8/8/8/8/5PPP/2R3K1 w - - 0 1','c1','c8'],
      ['6k1/5ppp/8/8/8/8/5PPP/1R4K1 w - - 0 1','b1','b8']
    ];
    for (const puzzle of puzzles) { const answer = await request(port, '/api/local-move', { fen: puzzle[0], from: puzzle[1], to: puzzle[2] }); assert.strictEqual(answer.status, 200); assert.strictEqual(answer.value.status, 'checkmate'); }
    await request(port, '/api/puzzle-result', { username: 'SmokeWhite', solved: true });
    await request(port, '/api/solo-result', { username: 'SmokeWhite', result: 'win' });
    response = await request(port, '/api/profile?username=SmokeWhite'); assert.strictEqual(response.value.puzzles_solved, 1); assert.strictEqual(response.value.bot_wins, 1); assert.strictEqual(response.value.rating, 1200);

    const white = await openSocket(port), black = await openSocket(port); sockets.push(white, black);
    const whiteJoined = nextMessage(white, m => m.type === 'joined'); send(white, { type: 'join', username: 'SmokeWhite', create: true, timeControl: 'rapid' });
    const joined = await whiteJoined;
    const blackJoined = nextMessage(black, m => m.type === 'joined');
    const readyState = nextMessage(white, m => m.type === 'state' && m.players.length === 2 && m.clocks.white > 0);
    send(black, { type: 'join', username: 'SmokeBlack', room: joined.code }); await blackJoined;
    let state = await readyState;
    assert.strictEqual(state.timeControl, 'rapid'); assert(state.clocks.white <= 600 && state.clocks.white > 590);
    const tick = nextMessage(white, m => m.type === 'clock' && m.clocks.white < state.clocks.white, 3000);
    const ticked = await tick; assert(ticked.clocks.white < state.clocks.white);
    const movedState = nextMessage(white, m => m.type === 'state' && m.pgn.indexOf('e4') >= 0); send(white, { type: 'move', from: 'e2', to: 'e4' }); state = await movedState; assert.strictEqual(state.turn, 'b');
    const endedState = nextMessage(white, m => m.type === 'state' && m.result === 'black'); send(white, { type: 'resign' }); state = await endedState; assert.strictEqual(state.result, 'black');
    response = await request(port, '/api/profile?username=SmokeWhite'); assert.strictEqual(response.value.losses, 1); assert(response.value.rating < 1200);
    response = await request(port, '/api/profile?username=SmokeBlack'); assert.strictEqual(response.value.wins, 1); assert(response.value.rating > 1200);
    console.log('Chess Room smoke checks passed.');
  } finally {
    sockets.forEach(socket => { try { socket.close(); } catch (_) {} });
    child.kill('SIGTERM');
    await new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); setTimeout(resolve, 1500); });
    try { removeDirectory(dataDir); } catch (_) {}
  }
}()).catch(err => { console.error(err); process.exitCode = 1; });
