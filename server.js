// READ ME — 공유 책장 서버 (Node 18+)
// 실행: npm install && node server.js  →  http://localhost:3000
// 정적 파일(index.html, assets/)을 서비스하고, 모두가 꽂은 수첩을 저장합니다.
//  - DATABASE_URL 이 있으면 Postgres(onpod 무료 DB)에 저장 → 재시작·재배포에도 유지
//  - 없으면 data/notebooks.json 파일에 저장 (로컬 개발용)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'notebooks.json');
const MAX_NOTEBOOKS = 500;
const MAX_BODY = 256 * 1024;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ttf': 'font/ttf',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon' };

// ---------- 저장소 ----------
let db = { notebooks: {} };
let pool = null;
async function loadStore() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
    await pool.query('CREATE TABLE IF NOT EXISTS notebooks (id TEXT PRIMARY KEY, doc JSONB NOT NULL)');
    const { rows } = await pool.query('SELECT id, doc FROM notebooks');
    rows.forEach(r => { db.notebooks[r.id] = r.doc; });
    console.log(`Postgres 연결 · 수첩 ${rows.length}권 불러옴`);
    return;
  }
  try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); if (!db.notebooks) db.notebooks = {}; } catch (e) {}
}
let saveTimer = null;
function persist(id) {
  if (pool) {
    const n = db.notebooks[id];
    (n ? pool.query('INSERT INTO notebooks (id, doc) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc', [id, n])
       : pool.query('DELETE FROM notebooks WHERE id = $1', [id])).catch(e => console.error('DB 저장 실패:', e.message));
    return;
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DATA_FILE);
  }, 300);
}
const hash = t => crypto.createHash('sha256').update(String(t)).digest('hex');

// ---------- 입력 정리 (모든 값은 길이·형식 제한) ----------
const str = (v, n) => (typeof v === 'string' ? v : '').slice(0, n);
const arr = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
const word = (v, n) => (typeof v === 'string' && /^[A-Za-z0-9_-]{0,40}$/.test(v) ? v.slice(0, n) : '');
function clean(nb) {
  nb = nb && typeof nb === 'object' ? nb : {};
  return {
    nick: str(nb.nick, 20) || '이름 없는 수첩',
    bio: str(nb.bio, 60),
    coverTitle: str(nb.coverTitle, 30),
    avatar: Math.max(0, Math.min(20, parseInt(nb.avatar, 10) || 0)),
    persona: /^[A-Z]{2}$/.test(nb.persona || '') ? nb.persona : null,
    quotes: arr(nb.quotes, 60).map(q => ({
      text: str(q && q.text, 300), book: str(q && q.book, 40), author: str(q && q.author, 30),
      thought: str(q && q.thought, 300), tags: arr(q && q.tags, 8).map(t => str(t, 10)), font: word(q && q.font, 20)
    })).filter(q => q.text),
    books: arr(nb.books, 80).map(b => ({ title: str(b && b.title, 40), author: str(b && b.author, 30), status: str(b && b.status, 10) })).filter(b => b.title),
    convs: arr(nb.convs, 20).map(c => ({
      charId: word(c && c.charId, 30), note: str(c && c.note, 60),
      lines: arr(c && c.lines, 12).map(l => ({ who: l && l.who === 'me' ? 'me' : 'ch', text: str(l && l.text, 400) }))
    })).filter(c => c.charId)
  };
}
const pub = (id, n) => ({ id, ...n.data, comments: n.comments || [], createdAt: n.createdAt, updatedAt: n.updatedAt });

// ---------- 간단한 요청 제한 ----------
const hits = new Map();
function limited(ip) {
  const now = Date.now(), h = (hits.get(ip) || []).filter(t => now - t < 60000);
  h.push(now); hits.set(ip, h);
  return h.length > 60;
}

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((ok, bad) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { bad(new Error('too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { bad(new Error('bad_json')); } });
    req.on('error', bad);
  });
}

async function api(req, res, url) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  if (req.method !== 'GET' && limited(ip)) return send(res, 429, { error: 'rate_limited' });
  const parts = url.pathname.split('/').filter(Boolean); // api, notebooks, :id, comments
  const id = parts[2];
  if (id && !/^[a-z0-9]{8,32}$/.test(id)) return send(res, 400, { error: 'bad_id' });

  // 목록
  if (req.method === 'GET' && parts.length === 2) {
    const list = Object.entries(db.notebooks).map(([k, n]) => pub(k, n)).sort((a, b) => a.createdAt - b.createdAt);
    return send(res, 200, { notebooks: list });
  }
  // 내 수첩 꽂기/갱신 (token 으로 주인 확인)
  if (req.method === 'PUT' && parts.length === 3) {
    const body = await readBody(req);
    const token = str(body.token, 100);
    if (token.length < 16) return send(res, 400, { error: 'bad_token' });
    const cur = db.notebooks[id];
    if (cur && cur.tokenHash !== hash(token)) return send(res, 403, { error: 'not_owner' });
    if (!cur && Object.keys(db.notebooks).length >= MAX_NOTEBOOKS) return send(res, 507, { error: 'shelf_full' });
    const now = Date.now();
    db.notebooks[id] = { tokenHash: hash(token), data: clean(body.notebook), comments: cur ? cur.comments : [], createdAt: cur ? cur.createdAt : now, updatedAt: now };
    persist(id);
    return send(res, 200, { ok: true, notebook: pub(id, db.notebooks[id]) });
  }
  // 책장에서 빼기
  if (req.method === 'DELETE' && parts.length === 3) {
    const body = await readBody(req);
    const cur = db.notebooks[id];
    if (!cur) return send(res, 404, { error: 'not_found' });
    if (cur.tokenHash !== hash(str(body.token, 100))) return send(res, 403, { error: 'not_owner' });
    delete db.notebooks[id]; persist(id);
    return send(res, 200, { ok: true });
  }
  // 방명록 남기기
  if (req.method === 'POST' && parts.length === 4 && parts[3] === 'comments') {
    const cur = db.notebooks[id];
    if (!cur) return send(res, 404, { error: 'not_found' });
    const body = await readBody(req);
    const text = str(body.text, 120).trim();
    if (!text) return send(res, 400, { error: 'empty' });
    cur.comments = (cur.comments || []).concat({ id: crypto.randomBytes(6).toString('hex'), author: str(body.author, 20) || '익명', text, date: new Date().toISOString().slice(0, 10) }).slice(-200);
    persist(id);
    return send(res, 200, { ok: true, comments: cur.comments });
  }
  return send(res, 404, { error: 'not_found' });
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  const rel = path.relative(ROOT, file);
  // 앱 파일만 공개 (data/, server.js, .git 등은 막음)
  if (rel.startsWith('..') || path.isAbsolute(rel) || !(rel === 'index.html' || rel.startsWith('assets' + path.sep))) {
    res.writeHead(404); return res.end('Not found');
  }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': rel === 'index.html' ? 'no-cache' : 'public, max-age=86400' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/health') return send(res, 200, { ok: true });
    if (url.pathname.startsWith('/api/notebooks')) return await api(req, res, url);
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url);
    res.writeHead(405); res.end();
  } catch (e) {
    send(res, e.message === 'too_large' ? 413 : 400, { error: e.message || 'error' });
  }
});
loadStore().then(() => server.listen(PORT, () => console.log(`READ ME → http://localhost:${PORT}`)))
  .catch(e => { console.error('저장소 연결 실패:', e.message); process.exit(1); });
