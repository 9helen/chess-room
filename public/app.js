(function () {
  'use strict';
  var START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  var glyphs = { wk: '♔', wq: '♕', wr: '♖', wb: '♗', wn: '♘', wp: '♙', bk: '♚', bq: '♛', br: '♜', bb: '♝', bn: '♞', bp: '♟' };
  var username = localStorage.getItem('chessroom.username') || '';
  var profile = null, socket = null, mode = '', myColor = 'w', game = null, selected = null, targets = [], lastMove = null, flip = false, clockTimer = null;
  var practice = { fen: START_FEN, initial: START_FEN, history: [], pgn: [], flip: false };
  var puzzleIndex = 0, puzzleSolved = false, puzzleAttemptRecorded = false, puzzleHadAttempt = false;
  var files = 'abcdefgh';
  var puzzles = [
    { fen: '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1', move: 'd1d8', prompt: 'The back rank is vulnerable. Find mate in one.', feedback: 'White to move. Look for the open file.' },
    { fen: '6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1', move: 'e1e8', prompt: 'The king has nowhere to run. Find mate in one.', feedback: 'White to move. The rook can reach the eighth rank.' },
    { fen: 'rnbqkbnr/pppp1p1p/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq g3 0 2', move: 'd8h4', prompt: 'Black to move. Spot the exposed king.', feedback: 'Black to move. Find the queen check that ends the game.' },
    { fen: '6k1/5ppp/8/8/8/8/5PPP/2R3K1 w - - 0 1', move: 'c1c8', prompt: 'Use the open file to deliver mate.', feedback: 'White to move. The rook has a clear path.' },
    { fen: '6k1/5ppp/8/8/8/8/5PPP/1R4K1 w - - 0 1', move: 'b1b8', prompt: 'Find the rook move that traps the king.', feedback: 'White to move. Search for a forcing finish.' }
  ];
  var $ = function (id) { return document.getElementById(id); };
  function message(id, value) { var el = $(id); if (el) el.textContent = value || ''; }
  function api(path, body) { return fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}).then(function (r) { return r.json().then(function (data) { if (!r.ok) throw new Error(data.error || 'Request failed.'); return data; }); }); }
  function showView(name) {
    ['home', 'play', 'puzzles', 'practice'].forEach(function (key) { $(key + '-view').classList.toggle('hidden', key !== name); });
    document.querySelectorAll('[data-view-link]').forEach(function (link) { link.classList.toggle('active', link.getAttribute('data-view-link') === name); });
    if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
    window.scrollTo(0, 0);
  }
  function validName(name) { return /^[\p{L}\p{N}_ -]{2,20}$/u.test(name); }
  function askUsername() {
    $('profile-username').value = username;
    $('profile-error').textContent = '';
    $('cancel-user').classList.toggle('hidden', !username);
    $('username-dialog').classList.remove('hidden');
    $('profile-username').focus();
  }
  function saveUsername(event) {
    event.preventDefault();
    var value = $('profile-username').value.trim().replace(/\s+/g, ' ');
    if (!validName(value)) { $('profile-error').textContent = 'Use 2–20 letters, numbers, spaces, underscores, or hyphens.'; return; }
    username = value; localStorage.setItem('chessroom.username', value); $('username-dialog').classList.add('hidden'); loadProfile();
  }
  function loadProfile() {
    if (!username) { askUsername(); return; }
    api('/api/profile?username=' + encodeURIComponent(username)).then(function (p) {
      profile = p; username = p.username; localStorage.setItem('chessroom.username', username);
      $('nav-username').textContent = username; $('welcome-name').textContent = username;
      $('stat-rating').textContent = p.rating; $('stat-games').textContent = p.wins + p.losses + p.draws;
      $('stat-record').textContent = p.wins + 'W · ' + p.draws + 'D · ' + p.losses + 'L'; $('stat-bot').textContent = (p.bot_wins || 0) + '–' + (p.bot_losses || 0);
      $('stat-puzzles').textContent = p.puzzles_solved || 0;
      $('stat-accuracy').textContent = p.puzzles_attempted ? Math.round(p.puzzles_solved * 100 / p.puzzles_attempted) + '% solve rate' : 'Start your streak';
      $('self-name').textContent = username; $('self-rating').textContent = p.rating + ' rating';
    }).catch(function () { message('lobby-message', 'Could not load profile.'); });
  }
  function parseBoard(fen) { return fen.split(' ')[0].split('/').map(function (row) { var out = []; for (var i = 0; i < row.length; i++) { if (/\d/.test(row[i])) for (var n = 0; n < Number(row[i]); n++) out.push(null); else out.push(row[i]); } return out; }); }
  function coord(r, c) { return files[c] + (8 - r); }
  function colorOf(piece) { return piece && (piece === piece.toUpperCase() ? 'w' : 'b'); }
  function pieceAt(fen, square) { var b = parseBoard(fen); return b[8 - Number(square[1])][files.indexOf(square[0])]; }
  function getTargets(fen, from) { return api('/api/legal-moves?fen=' + encodeURIComponent(fen) + '&from=' + from).then(function (data) { return data.moves.map(function (m) { return m.to; }); }); }
  function drawBoard(boardId, ranksId, fen, orientation, onClick, highlight) {
    var el = $(boardId), rankEl = $(ranksId), board = parseBoard(fen); el.innerHTML = ''; rankEl.innerHTML = '';
    var rows = orientation === 'b' ? [7,6,5,4,3,2,1,0] : [0,1,2,3,4,5,6,7];
    var cols = orientation === 'b' ? [7,6,5,4,3,2,1,0] : [0,1,2,3,4,5,6,7];
    var fileLabels = orientation === 'b' ? 'hgfedcba' : 'abcdefgh';
    var fileGroups = el.parentNode.querySelectorAll('.files');
    Array.prototype.forEach.call(fileGroups, function (group) { Array.prototype.forEach.call(group.children, function (label, index) { label.textContent = fileLabels[index]; }); });
    rows.forEach(function (r) { var mark = document.createElement('span'); mark.textContent = String(8-r); rankEl.appendChild(mark); });
    rows.forEach(function (r) { cols.forEach(function (c) {
      var sq = coord(r,c), piece = board[r][c], cell = document.createElement('button'); cell.type = 'button'; cell.className = 'square ' + ((r+c)%2 ? 'dark' : 'light'); cell.setAttribute('role','gridcell'); cell.setAttribute('aria-label',sq + (piece ? ' ' + piece : '')); cell.dataset.square = sq;
      if (highlight && highlight.from === sq || highlight && highlight.to === sq) cell.classList.add('last');
      if (selected === sq) cell.classList.add('selected'); if (targets.indexOf(sq) >= 0) cell.classList.add('legal'); if (piece) cell.classList.add('occupied');
      if (piece) { var glyph = document.createElement('span'); glyph.className = 'piece ' + (colorOf(piece) === 'w' ? 'white-piece' : 'black-piece'); glyph.textContent = glyphs[colorOf(piece) + piece.toLowerCase()]; cell.appendChild(glyph); }
      cell.addEventListener('click', function () { onClick(sq); }); el.appendChild(cell);
    }); });
  }
  function setGameTitle() {
    if (mode === 'friend') {
      var opp = game.players.filter(function (p) { return p.color !== myColor; })[0];
      $('opponent-name').textContent = opp ? opp.username : 'Waiting for opponent'; $('opponent-rating').textContent = opp ? opp.rating + ' rating' : 'Share your invite code';
      $('game-title').textContent = game.result ? (game.result === 'draw' ? 'Game drawn' : game.result === myColorName() ? 'You won' : 'You lost') : game.players.length < 2 ? 'Waiting for your opponent' : game.check ? 'Check!' : game.turn === myColor ? 'Your turn' : 'Opponent’s turn';
      $('turn-label').textContent = game.result ? 'Game complete' : game.turn === myColor ? 'Your turn' : 'Opponent’s turn';
      $('resign').classList.toggle('hidden', game.players.length < 2 || !!game.result); $('copy-code').classList.remove('hidden');
    } else {
      $('opponent-name').textContent = mode === 'bot' ? 'Chess Room Bot' : mode === 'puzzle' ? 'Puzzle position' : 'Practice'; $('opponent-rating').textContent = mode === 'bot' ? 'Friendly level' : 'Analysis board';
      $('game-title').textContent = game.result ? (game.result === 'draw' ? 'Game drawn' : game.result === myColorName() ? 'You won' : 'You lost') : game.status === 'checkmate' ? 'Checkmate' : game.check ? 'Check!' : game.turn === myColor ? 'Your turn' : 'Computer is thinking';
      $('turn-label').textContent = game.result ? 'Game complete' : game.turn === myColor ? 'Your turn' : 'Computer to move'; $('resign').classList.toggle('hidden', mode !== 'bot' || !!game.result); $('copy-code').classList.add('hidden');
    }
    $('back-to-modes').classList.toggle('hidden', !game.result && mode === 'friend' && game.players.length > 1);
    drawBoard('board','rank-coords',game.fen,flip ? (myColor === 'w' ? 'b' : 'w') : myColor,clickGame,lastMove); drawMoveList(game.pgn || ''); updateClock();
  }
  function myColorName() { return myColor === 'w' ? 'white' : 'black'; }
  function drawMoveList(pgn) {
    var tokens = (pgn || '').replace(/\[[^\]]*\]/g,'').replace(/\{[^}]*\}/g,'').replace(/\d+\.(\.\.)?/g,'').trim().split(/\s+/).filter(function (x) { return x && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(x); });
    var el = $('move-list'); el.innerHTML = '';
    if (!tokens.length) { el.innerHTML = '<p class="empty-state">Moves will appear here.</p>'; return; }
    for (var i=0;i<tokens.length;i+=2) { var row=document.createElement('div'); row.className='move-pair'; [String(i/2+1)+'.',tokens[i]||'',tokens[i+1]||''].forEach(function (text,idx) { var span=document.createElement('span'); span.className=idx===0?'move-number':'move'; span.textContent=text; row.appendChild(span); }); el.appendChild(row); } el.scrollTop=el.scrollHeight;
  }
  function goGame(m) { mode=m; selected=null; targets=[]; lastMove=null; flip=false; $('play-options').classList.add('hidden'); $('play-heading').classList.add('hidden'); $('game').classList.remove('hidden'); $('game-mode-label').textContent=m==='friend'?'FRIEND GAME':'COMPUTER GAME'; $('game-clock').classList.toggle('hidden',!game || game.timeControl==='untimed'); }
  function enterRoom(create) {
    message('lobby-message',''); if (!profile) return askUsername();
    if (!create && !$('room-code').value.trim()) return message('lobby-message','Enter a room code to join.');
    if (socket) { try { socket.close(); } catch (_) {} } game=null; mode='friend';
    socket = new WebSocket((location.protocol==='https:'?'wss:':'ws:')+'//'+location.host);
    socket.onopen = function () { socket.send(JSON.stringify({ type:'join', username:username, create:create, room:$('room-code').value, timeControl:$('time-control').value })); };
    socket.onerror = function () { message('lobby-message','Could not connect to the chess server.'); };
    socket.onmessage = function (event) { var msg=JSON.parse(event.data);
      if (msg.type==='error') { message(game?'game-message':'lobby-message',msg.message); return; }
      if (msg.type==='joined') { myColor=msg.color; $('game').classList.remove('hidden'); $('play-options').classList.add('hidden'); $('play-heading').classList.add('hidden'); $('game-mode-label').textContent='FRIEND GAME · ROOM '+msg.code; $('copy-code').classList.remove('hidden'); $('resign').classList.remove('hidden'); $('back-to-modes').classList.add('hidden'); $('self-name').textContent=profile.username; $('self-rating').textContent=profile.rating+' rating'; $('copy-code').dataset.code=msg.code; message('game-message',''); showView('play'); } 
      if (msg.type==='opponent-left') message('game-message',msg.message);
      if (msg.type==='state') { game=msg; $('game-mode-label').textContent='FRIEND GAME · '+msg.timeControl.toUpperCase()+' · ROOM '+msg.room; $('game-clock').classList.toggle('hidden',msg.timeControl==='untimed'); if (msg.players.length && !msg.players.some(function(p){return p.color===myColor;})) return; if (msg.players.length) { var self=msg.players.filter(function(p){return p.color===myColor;})[0]; if(self){$('self-name').textContent=self.username;$('self-rating').textContent=self.rating+' rating';} } setGameTitle(); loadProfile(); }
      if (msg.type==='clock') { game.clocks=msg.clocks; updateClock(); }
    };
  }
  function startBot() {
    mode='bot'; myColor='w'; game={fen:START_FEN,pgn:'',turn:'w',status:'playing',result:null,check:false,timeControl:$('bot-time-control').value,clocks:{white:$('bot-time-control').value==='blitz'?180:600,black:$('bot-time-control').value==='blitz'?180:600}};
    game.botClockUpdated=Date.now(); goGame('bot'); $('game-mode-label').textContent='COMPUTER GAME · '+game.timeControl.toUpperCase(); $('self-name').textContent=username; $('self-rating').textContent='Unrated'; startClockTicker(); setGameTitle();
  }
  function clickGame(square) {
    if (!game || game.result || game.status && game.status!=='playing') return;
    if (mode==='friend' && game.turn!==myColor) return;
    var piece=pieceAt(game.fen,square);
    if (selected && targets.indexOf(square)>=0) { var from=selected; selected=null; targets=[]; makeMove(from,square); return; }
    if (piece && colorOf(piece)===game.turn && (mode!=='friend' || colorOf(piece)===myColor)) { selected=square; getTargets(game.fen,square).then(function(t){targets=t;drawCurrentBoard();}).catch(function(){}); }
    else { selected=null; targets=[]; drawCurrentBoard(); }
  }
  function drawCurrentBoard() { drawBoard('board','rank-coords',game.fen,flip?(myColor==='w'?'b':'w'):myColor,clickGame,lastMove); }
  function makeMove(from,to) {
    if (mode==='friend') { socket.send(JSON.stringify({type:'move',from:from,to:to,promotion:'q'})); lastMove={from:from,to:to}; drawCurrentBoard(); return; }
    api('/api/local-move',{fen:game.fen,from:from,to:to,promotion:'q'}).then(function(data){
      lastMove={from:from,to:to}; game.fen=data.fen; game.pgn=game.pgn ? game.pgn+' '+data.san : data.san; game.turn=data.turn; game.check=data.check; game.status=data.status; game.result=data.result;
      if (game.status!=='playing') return finishSolo(); setGameTitle();
      if (mode==='bot' && game.turn!==myColor) setTimeout(botMove,450);
    }).catch(function(err){message(mode==='practice'?'practice-message':'game-message',err.message);});
  }
  function botMove() {
    if (!game || game.result || mode!=='bot') return;
    api('/api/bot-move',{fen:game.fen}).then(function(data){ if(!data.move)return; return api('/api/local-move',{fen:game.fen,from:data.move.from,to:data.move.to,promotion:data.move.promotion}).then(function(result){ lastMove={from:data.move.from,to:data.move.to}; game.fen=result.fen; game.pgn+=(game.pgn?' ':'')+result.san; game.turn=result.turn; game.check=result.check; game.status=result.status; game.result=result.result; if(game.status!=='playing')finishSolo(); else setGameTitle(); }); }).catch(function(){message('game-message','The computer move failed. Please try again.');});
  }
  function finishSolo() {
    setGameTitle(); stopClockTicker(); $('back-to-modes').classList.remove('hidden');
    if(mode==='bot' && !game.resultRecorded) { game.resultRecorded=true; var result=game.result==='draw'?'draw':game.result===myColorName()?'win':'loss'; api('/api/solo-result',{username:username,result:result}).then(loadProfile).catch(function(){}); }
  }
  function startClockTicker() { stopClockTicker(); if(mode==='bot'&&game&&game.timeControl!=='untimed'){game.botClockUpdated=Date.now();clockTimer=setInterval(function(){var now=Date.now(),side=game.turn==='w'?'white':'black';game.clocks[side]=Math.max(0,game.clocks[side]-(now-game.botClockUpdated)/1000);game.botClockUpdated=now;if(game.clocks[side]<=0){game.result=side==='white'?'black':'white';game.status='timeout';finishSolo();}else updateClock();},250);} }
  function stopClockTicker(){if(clockTimer){clearInterval(clockTimer);clockTimer=null;}}
  function updateClock() {
    var el=$('game-clock'); if(!el||!game||game.timeControl==='untimed'){el&&el.classList.add('hidden');return;} el.classList.remove('hidden');
    var clocks=game.clocks||{}, side=mode==='friend'?(game.turn==='w'?'white':'black'):(game.turn==='w'?'white':'black'), secs=clocks[side]; if(secs===undefined)secs=game.timeControl==='blitz'?180:600;
    var value=Math.max(0,Math.floor(secs));el.textContent=Math.floor(value/60)+':'+String(value%60).padStart(2,'0');el.classList.toggle('active',!game.result);
  }
  function connectFriend() { if(socket&&socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'resign'})); }

  function openPuzzles() { showView('puzzles'); puzzleIndex=0; puzzleSolved=false; loadPuzzle(); }
  function puzzleOrientation(){return game.turn==='b'?'b':'w';}
  function loadPuzzle() { var p=puzzles[puzzleIndex]; puzzleSolved=false;puzzleAttemptRecorded=false;puzzleHadAttempt=false;selected=null;targets=[];game={fen:p.fen,turn:p.fen.split(' ')[1],status:'playing',result:null,pgn:'',check:false};$('puzzle-number').textContent=String(puzzleIndex+1).padStart(2,'0')+' / '+String(puzzles.length).padStart(2,'0');$('puzzle-title').textContent=(game.turn==='w'?'White':'Black')+' to move';$('puzzle-prompt').textContent=p.prompt;$('puzzle-feedback').textContent=p.feedback;$('puzzle-progress-text').textContent='Puzzle '+(puzzleIndex+1)+' of '+puzzles.length;$('puzzle-progress-bar').style.width=(puzzleIndex/puzzles.length*100)+'%';$('next-puzzle').textContent=puzzleIndex===puzzles.length-1?'Finish puzzles':'Next puzzle →';drawBoard('puzzle-board','puzzle-ranks',game.fen,puzzleOrientation(),clickPuzzle,null); }
  function clickPuzzle(square) { if(puzzleSolved)return;var piece=pieceAt(game.fen,square);if(selected&&targets.indexOf(square)>=0){var from=selected;selected=null;targets=[];puzzleHadAttempt=true;var expected=puzzles[puzzleIndex].move;if(from+square===expected){api('/api/local-move',{fen:game.fen,from:from,to:square}).then(function(d){game.fen=d.fen;game.status=d.status;game.turn=d.turn;game.pgn=d.san;puzzleSolved=true;lastMove={from:from,to:square};$('puzzle-feedback').textContent='Correct! '+d.san+' is checkmate.';$('puzzle-feedback').classList.add('success');recordPuzzle(true);drawBoard('puzzle-board','puzzle-ranks',game.fen,puzzleOrientation(),clickPuzzle,lastMove);$('puzzle-progress-bar').style.width=((puzzleIndex+1)/puzzles.length*100)+'%';}).catch(function(){});}else{$('puzzle-feedback').textContent='Not quite. Try another move.';$('puzzle-feedback').classList.add('error');drawBoard('puzzle-board','puzzle-ranks',game.fen,puzzleOrientation(),clickPuzzle,null);setTimeout(function(){$('puzzle-feedback').classList.remove('error');},1000);}return;}
    if(piece&&colorOf(piece)===game.turn){selected=square;getTargets(game.fen,square).then(function(t){targets=t;drawBoard('puzzle-board','puzzle-ranks',game.fen,puzzleOrientation(),clickPuzzle,null);}).catch(function(){});}else{selected=null;targets=[];drawBoard('puzzle-board','puzzle-ranks',game.fen,puzzleOrientation(),clickPuzzle,null);} }
  function recordPuzzle(solved){if(puzzleAttemptRecorded)return;puzzleAttemptRecorded=true;api('/api/puzzle-result',{username:username,solved:solved}).then(loadProfile).catch(function(){});}
  function resetPuzzle(){if(puzzleHadAttempt&&!puzzleSolved)recordPuzzle(false);loadPuzzle();}
  function nextPuzzle(){if(!puzzleSolved&&puzzleHadAttempt)recordPuzzle(false);if(puzzleIndex<puzzles.length-1){puzzleIndex++;loadPuzzle();}else{showView('home');}}

  function drawPractice(){drawBoard('practice-board','practice-ranks',practice.fen,practice.flip?'b':'w',clickPractice,null);$('practice-turn').textContent=practice.fen.split(' ')[1]==='w'?'White to move':'Black to move';$('fen-input').value=practice.fen;}
  function clickPractice(square){var piece=pieceAt(practice.fen,square);if(selected&&targets.indexOf(square)>=0){var from=selected;selected=null;targets=[];api('/api/local-move',{fen:practice.fen,from:from,to:square}).then(function(d){practice.history.push({fen:practice.fen,pgn:practice.pgn.slice()});practice.fen=d.fen;practice.pgn.push(d.san);drawPractice();message('practice-message','');}).catch(function(err){message('practice-message',err.message);});return;}if(piece){selected=square;getTargets(practice.fen,square).then(function(t){targets=t;drawPractice();});}else{selected=null;targets=[];drawPractice();}}
  function resetPractice(){practice={fen:START_FEN,initial:START_FEN,history:[],pgn:[],flip:false};selected=null;targets=[];drawPractice();message('practice-message','Position reset.');}
  function undoPractice(){var prev=practice.history.pop();if(!prev)return message('practice-message','There are no moves to undo.');practice.fen=prev.fen;practice.pgn=prev.pgn;selected=null;targets=[];drawPractice();message('practice-message','Last move undone.');}
  function loadFen(){var fen=$('fen-input').value.trim();if(!fen)return message('practice-message','Paste a FEN position first.');api('/api/legal-moves?fen='+encodeURIComponent(fen)).then(function(){practice={fen:fen,initial:fen,history:[],pgn:[],flip:false};selected=null;targets=[];drawPractice();message('practice-message','Position loaded.');}).catch(function(){message('practice-message','That FEN position is invalid.');});}
  function copyFen(){navigator.clipboard.writeText(practice.fen).then(function(){message('practice-message','FEN copied to clipboard.');}).catch(function(){message('practice-message','Clipboard access is unavailable.');});}
  function loadLeaderboard(){api('/api/leaderboard').then(function(rows){var el=$('leaderboard-list');el.innerHTML='';if(!rows.length){el.innerHTML='<p class="empty-state">Finish a friend game to appear here.</p>';return;}rows.forEach(function(p,i){var row=document.createElement('div');row.className='leader-row';var rank=document.createElement('span'),name=document.createElement('span'),rating=document.createElement('span');rank.className='leader-rank';name.className='leader-name';rating.className='leader-rating';rank.textContent=String(i+1).padStart(2,'0');name.textContent=p.username;rating.textContent=p.rating;row.appendChild(rank);row.appendChild(name);row.appendChild(rating);el.appendChild(row);});}).catch(function(){message('leaderboard-list','Leaderboard unavailable.');});}
  function returnToPlay(){stopClockTicker();game=null;selected=null;targets=[];if(socket){socket.send(JSON.stringify({type:'leave'}));socket.close();socket=null;}$('game').classList.add('hidden');$('play-options').classList.remove('hidden');$('play-heading').classList.remove('hidden');message('lobby-message','');}

  document.querySelectorAll('[data-go]').forEach(function(button){button.addEventListener('click',function(){var dest=button.getAttribute('data-go');if(dest==='puzzles')openPuzzles();else{showView(dest);if(dest==='practice')drawPractice();}});});
  document.querySelectorAll('[data-view-link]').forEach(function(link){link.addEventListener('click',function(e){e.preventDefault();var dest=link.getAttribute('data-view-link');if(dest==='puzzles')openPuzzles();else{showView(dest);if(dest==='practice')drawPractice();}});});
  $('change-user').addEventListener('click',askUsername);$('username-form').addEventListener('submit',saveUsername);$('cancel-user').addEventListener('click',function(){$('username-dialog').classList.add('hidden');});$('create-room').addEventListener('click',function(){enterRoom(true);});$('join-room').addEventListener('click',function(){enterRoom(false);});$('room-code').addEventListener('keydown',function(e){if(e.key==='Enter')enterRoom(false);});$('start-bot').addEventListener('click',startBot);
  $('resign').addEventListener('click',function(){if(mode==='friend'){if(window.confirm('Resign this game?'))connectFriend();}else if(mode==='bot'&&window.confirm('Resign this game?')){game.result='black';finishSolo();}});
  $('copy-code').addEventListener('click',function(){var code=$('copy-code').dataset.code;if(code)navigator.clipboard.writeText(code).then(function(){$('copy-code').textContent='Copied!';setTimeout(function(){$('copy-code').textContent='Copy invite';},1300);});});
  $('back-to-modes').addEventListener('click',returnToPlay);$('flip-board').addEventListener('click',function(){flip=!flip;drawCurrentBoard();});$('next-puzzle').addEventListener('click',nextPuzzle);$('reset-puzzle').addEventListener('click',resetPuzzle);
  $('undo-practice').addEventListener('click',undoPractice);$('reset-practice').addEventListener('click',resetPractice);$('flip-practice').addEventListener('click',function(){practice.flip=!practice.flip;drawPractice();});$('load-fen').addEventListener('click',loadFen);$('copy-fen').addEventListener('click',copyFen);
  window.addEventListener('hashchange',function(){var name=location.hash.slice(1);if(['home','play','practice'].indexOf(name)>=0){showView(name);if(name==='practice')drawPractice();}else if(name==='puzzles')openPuzzles();});
  loadProfile();loadLeaderboard();drawPractice();var first=location.hash.slice(1);if(first==='play'||first==='practice')showView(first);else if(first==='puzzles')openPuzzles();else showView('home');
}());
