const express = require('express'), http = require('http'), { Server } = require('socket.io');
const app = express(), srv = http.createServer(app), io = new Server(srv);
const fs = require('fs'), path = require('path');
const PUB = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public') : __dirname;
app.use(express.static(PUB));
app.get('/', (q, r) => {
  const f = path.join(PUB, 'index.html');
  fs.existsSync(f) ? r.sendFile(f) : r.status(500).send('index.html not found. Put it in the public/ folder.');
});
app.get('/health', (q, r) => r.send('ok'));

const rooms = {};
const sum = h => h.reduce((s, t) => s + t[0] + t[1], 0);
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const key = t => t[0] + '' + t[1];
const unit = (r, s) => r.max === 4 ? s % 2 : s;      // 4 players = 2 teams (0&2 vs 1&3)
const units = r => r.max === 4 ? 2 : r.max;
const rid = () => { let c; do c = Math.random().toString(36).slice(2, 6).toUpperCase(); while (rooms[c]); return c; };
const addLog = (g, m) => { g.log.push(m); if (g.log.length > 8) g.log.shift(); };
const ends = g => g.chain.length ? [g.chain[0][0], g.chain[g.chain.length - 1][1]] : null;
const auto = (r, s) => r.seats[s].bot || !r.seats[s].sid;

function movesOf(g, hand) {
  const e = ends(g), out = [];
  hand.forEach((t, i) => {
    if (!e) { if (g.must && key(t) !== g.must) return; out.push({ i, sides: ['R'] }); return; }
    const s = [];
    if (t[0] === e[0] || t[1] === e[0]) s.push('L');
    if (t[0] === e[1] || t[1] === e[1]) s.push('R');
    if (s.length) out.push({ i, sides: s });
  });
  return out;
}

function view(r, s) {
  const g = r.game;
  const v = { code: r.code, max: r.max, target: r.target, me: s, teams: r.max === 4,
    seats: r.seats.map(x => ({ name: x.name, bot: !!x.bot, on: !!(x.bot || x.sid) })), phase: g ? g.phase : 'lobby' };
  if (g) {
    const my = g.turn === s && g.phase === 'play';
    const m = my ? movesOf(g, g.hands[s]) : [];
    Object.assign(v, { chain: g.chain, ends: ends(g), turn: g.turn, scores: g.scores, round: g.round,
      boneyard: g.boneyard.length, counts: g.hands.map(h => h.length), hand: g.hands[s], log: g.log,
      result: g.result, must: g.must, moves: m, canDraw: my && !m.length && g.boneyard.length > 0 });
    if (g.phase !== 'play') v.hands = g.hands;
  }
  return v;
}
function emit(r) { r.seats.forEach((x, i) => x.sid && io.to(x.sid).emit('state', view(r, i))); }

function newRound(r, first) {
  const n = r.max, all = [];
  for (let a = 0; a < 7; a++) for (let b = a; b < 7; b++) all.push([a, b]);
  shuffle(all);
  const hands = []; for (let i = 0; i < n; i++) hands.push(all.splice(0, 7));
  const g = r.game = r.game || { scores: Array(units(r)).fill(0), round: 0 };
  Object.assign(g, { hands, boneyard: all, chain: [], passes: 0, phase: 'play', result: null, log: [], must: null, round: g.round + 1 });
  if (first == null) { // first round: highest double starts, otherwise highest tile
    let best = null;
    hands.forEach((h, s) => h.forEach(t => { const sc = (t[0] === t[1] ? 100 : 0) + t[0] + t[1]; if (!best || sc > best.sc) best = { sc, s, k: key(t) }; }));
    g.turn = best.s; g.must = best.k;
  } else g.turn = first;
  g.starter = g.turn;
  addLog(g, `دست ${g.round} شروع شد`);
  runTurn(r);
}

function runTurn(r) {
  const g = r.game; emit(r);
  if (g.phase !== 'play') return;
  const s = g.turn; clearTimeout(r.t);
  if (auto(r, s)) { r.t = setTimeout(() => bot(r, s), 900); return; }
  if (!movesOf(g, g.hands[s]).length && !g.boneyard.length) r.t = setTimeout(() => pass(r, s), 1300);
}
const nextTurn = r => { r.game.turn = (r.game.turn + 1) % r.max; runTurn(r); };

function play(r, s, i, side) {
  const g = r.game, t = g.hands[s].splice(i, 1)[0], e = ends(g); let o;
  if (!e) { o = t; g.chain.push(o); }
  else if (side === 'L') { o = t[1] === e[0] ? t : [t[1], t[0]]; g.chain.unshift(o); }
  else { o = t[0] === e[1] ? t : [t[1], t[0]]; g.chain.push(o); }
  g.must = null; g.passes = 0;
  addLog(g, `${r.seats[s].name}: ${t[0]}|${t[1]}`);
  if (!g.hands[s].length) return endRound(r, false, s);
  nextTurn(r);
}
function draw(r, s) {
  const g = r.game; g.hands[s].push(g.boneyard.pop());
  addLog(g, `${r.seats[s].name} از بازار برداشت`); runTurn(r);
}
function pass(r, s) {
  const g = r.game; if (g.phase !== 'play' || g.turn !== s) return;
  g.passes++; addLog(g, `${r.seats[s].name} پاس داد`);
  if (g.passes >= r.max) return endRound(r, true);
  nextTurn(r);
}

function endRound(r, blocked, ws) {
  const g = r.game, n = r.max, tot = Array(units(r)).fill(0);
  g.hands.forEach((h, s) => tot[unit(r, s)] += sum(h));
  const all = tot.reduce((a, b) => a + b, 0);
  let u = -1, pts = 0, w = null;
  if (!blocked) { w = ws; u = unit(r, ws); pts = all - tot[u]; }
  else {
    const mn = Math.min(...tot), lows = tot.map((x, i) => x === mn ? i : -1).filter(i => i >= 0);
    if (lows.length === 1) {
      u = lows[0]; pts = all - 2 * tot[u];
      w = g.hands.map((h, s) => ({ s, v: sum(h) })).filter(x => unit(r, x.s) === u).sort((a, b) => a.v - b.v)[0].s;
    }
  }
  if (u >= 0) g.scores[u] += pts;
  g.result = { blocked, winner: w, unit: u, pts };
  g.next = w != null ? w : (g.starter + 1) % n;
  g.phase = (u >= 0 && g.scores[u] >= r.target) ? 'over' : 'roundEnd';
  addLog(g, u < 0 ? 'بازی بسته شد؛ مساوی' : `${blocked ? 'بسته شد' : 'دومینو!'} ${pts} امتیاز`);
  clearTimeout(r.t); emit(r);
}

function bot(r, s) {
  const g = r.game; if (!g || g.phase !== 'play' || g.turn !== s) return;
  const h = g.hands[s], m = movesOf(g, h);
  if (!m.length) return g.boneyard.length ? draw(r, s) : pass(r, s);
  const e = ends(g); let best = null;
  m.forEach(mv => mv.sides.forEach(side => {
    const t = h[mv.i]; let ne;
    if (!e) ne = [t[0], t[1]];
    else if (side === 'L') ne = [t[0] === e[0] ? t[1] : t[0], e[1]];
    else ne = [e[0], t[0] === e[1] ? t[1] : t[0]];
    const rest = h.filter((_, k) => k !== mv.i);
    const hold = x => rest.filter(q => q[0] === x || q[1] === x).length;
    const sc = t[0] + t[1] + (t[0] === t[1] ? 4 : 0) + 3 * (hold(ne[0]) + hold(ne[1])) + Math.random();
    if (!best || sc > best.sc) best = { sc, i: mv.i, side };
  }));
  play(r, s, best.i, best.side);
}

io.on('connection', so => {
  const R = () => rooms[so.data.code];
  const S = r => r ? r.seats.findIndex(x => x.pid === so.data.pid) : -1;
  function join(r, d, cb) {
    const pid = String(d.pid || '').slice(0, 40) || Math.random().toString(36).slice(2);
    let i = r.seats.findIndex(x => x.pid === pid);
    if (i < 0) {
      if (r.game || r.seats.length >= r.max) return cb && cb({ err: 'اتاق پر است یا بازی شروع شده' });
      r.seats.push({ pid, name: String(d.name || 'بازیکن').slice(0, 14), sid: so.id });
    } else r.seats[i].sid = so.id;
    so.data = { code: r.code, pid }; so.join(r.code);
    cb && cb({ ok: 1, code: r.code }); emit(r);
    if (r.game && r.game.phase === 'play') runTurn(r);
  }
  so.on('create', (d, cb) => {
    const code = rid(), max = [2, 3, 4].includes(+d.max) ? +d.max : 4;
    const r = rooms[code] = { code, max, target: Math.min(500, Math.max(30, +d.target || 100)), seats: [], game: null };
    join(r, d, cb);
  });
  so.on('join', (d, cb) => {
    const r = rooms[String(d.code || '').toUpperCase()];
    if (!r) return cb && cb({ err: 'اتاقی با این کد پیدا نشد' });
    join(r, d, cb);
  });
  so.on('addBot', () => {
    const r = R(); if (!r || r.game || S(r) !== 0 || r.seats.length >= r.max) return;
    const k = r.seats.filter(x => x.bot).length + 1;
    r.seats.push({ pid: 'bot' + Date.now() + k, name: 'ربات ' + k, bot: true }); emit(r);
  });
  so.on('removeBot', () => {
    const r = R(); if (!r || r.game || S(r) !== 0) return;
    for (let i = r.seats.length - 1; i > 0; i--) if (r.seats[i].bot) { r.seats.splice(i, 1); break; }
    emit(r);
  });
  so.on('start', () => {
    const r = R(); if (!r || r.game || S(r) !== 0 || r.seats.length !== r.max) return;
    newRound(r);
  });
  so.on('move', d => {
    const r = R(), s = S(r); if (!r || !r.game || s < 0) return;
    const g = r.game; if (g.phase !== 'play' || g.turn !== s) return;
    const m = movesOf(g, g.hands[s]).find(x => x.i === d.i);
    if (!m || !m.sides.includes(d.side)) return;
    clearTimeout(r.t); play(r, s, d.i, d.side);
  });
  so.on('draw', () => {
    const r = R(), s = S(r); if (!r || !r.game || s < 0) return;
    const g = r.game; if (g.phase !== 'play' || g.turn !== s || !g.boneyard.length || movesOf(g, g.hands[s]).length) return;
    draw(r, s);
  });
  so.on('next', () => {
    const r = R(); if (!r || !r.game || r.game.phase !== 'roundEnd' || S(r) < 0) return;
    newRound(r, r.game.next);
  });
  so.on('rematch', () => {
    const r = R(); if (!r || S(r) !== 0 || !r.game || r.game.phase !== 'over') return;
    clearTimeout(r.t); r.game = null; emit(r);
  });
  const leave = hard => {
    const r = R(); if (!r) return; const s = S(r); if (s < 0) return;
    so.leave(r.code);
    if (!r.game && (hard || true)) { r.seats.splice(s, 1); if (!r.seats.some(x => !x.bot)) { delete rooms[r.code]; return; } }
    else { r.seats[s].sid = null; if (hard) r.seats[s].pid = 'gone' + Math.random(); }
    if (!r.seats.some(x => x.sid)) setTimeout(() => { if (rooms[r.code] && !rooms[r.code].seats.some(x => x.sid)) { clearTimeout(r.t); delete rooms[r.code]; } }, 600000);
    emit(r); if (r.game && r.game.phase === 'play') runTurn(r);
  };
  so.on('leave', () => leave(true));
  so.on('disconnect', () => leave(false));
});

const PORT = process.env.PORT || 3000;
srv.listen(PORT, () => console.log('Domino server on ' + PORT));
