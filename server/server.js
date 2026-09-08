// 2026年末旅游地图 - 云同步后端（零依赖 Node.js）
// 部署：Docker node:20-alpine，挂载 /app/data 持久化
// 端口：3211（避开 wbsync 的 3210）
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '3211', 10);
const TOKEN = process.env.TRAVEL_TOKEN || 'travel_sync_2026';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const MAX_BODY = 25 * 1024 * 1024; // 25MB（多张照片一起传）

// 初始化目录与数据文件
function init() {
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ checkins: {}, photos: [], updated: 0 }));
  }
}
init();

function readData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { return { checkins: {}, photos: [], updated: 0 }; }
}
function writeData(d) {
  d.updated = Date.now();
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d));
  fs.renameSync(tmp, DATA_FILE);
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too-large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function safeKey(key) {
  // 只允许 [A-Za-z0-9-_.] 且以 .jpg 结尾，防路径穿越
  return typeof key === 'string' && /^[A-Za-z0-9_-]{6,}\.jpg$/.test(key);
}
function photoPath(key) { return path.join(PHOTO_DIR, key); }

async function handleSync(req, res) {
  const raw = await readBody(req);
  let body;
  try { body = JSON.parse(raw); } catch (e) { return send(res, 400, { error: 'bad-json' }); }
  if (!body || typeof body !== 'object') return send(res, 400, { error: 'bad-body' });

  const d = readData();
  const newCheckins = body.checkins || {};
  const newPhotos = Array.isArray(body.photos) ? body.photos : [];
  const photoData = body.photoData || {};
  const removedCk = Array.isArray(body.removedCheckins) ? body.removedCheckins : [];
  const removedPh = Array.isArray(body.removedPhotos) ? body.removedPhotos : [];
  let changed = false;

  // 合并 checkins：ts 新者胜
  for (const pid of Object.keys(newCheckins)) {
    if (typeof pid !== 'string' || pid.length > 64) continue;
    const r = newCheckins[pid];
    if (!r || typeof r.ts !== 'number') continue;
    const note = (typeof r.note === 'string') ? r.note.slice(0, 500) : '';
    const old = d.checkins[pid];
    if (!old || (r.ts || 0) > (old.ts || 0)) {
      d.checkins[pid] = { ts: r.ts, note };
      changed = true;
    }
  }
  // 删除
  for (const pid of removedCk) {
    if (pid in d.checkins) { delete d.checkins[pid]; changed = true; }
  }

  // 合并照片元数据
  const known = new Set(d.photos.map(p => p.key));
  for (const ph of newPhotos) {
    if (!ph || !safeKey(ph.key)) continue;
    if (!known.has(ph.key)) {
      d.photos.push({ key: ph.key, pid: String(ph.pid || '').slice(0, 64), ts: ph.ts || Date.now() });
      known.add(ph.key);
      changed = true;
    }
  }
  for (const key of removedPh) {
    if (!safeKey(key)) continue;
    const before = d.photos.length;
    d.photos = d.photos.filter(p => p.key !== key);
    if (d.photos.length !== before) changed = true;
    try { if (fs.existsSync(photoPath(key))) fs.unlinkSync(photoPath(key)); } catch (e) {}
  }
  // 落盘照片内容
  for (const key of Object.keys(photoData)) {
    if (!safeKey(key)) continue;
    const val = photoData[key];
    if (typeof val !== 'string' || !val.startsWith('data:image/')) continue;
    const b64 = val.slice(val.indexOf(',') + 1);
    if (b64.length * 0.75 > 4 * 1024 * 1024) continue; // 单张上限4MB
    try {
      fs.writeFileSync(photoPath(key), Buffer.from(b64, 'base64'));
      if (!known.has(key)) { d.photos.push({ key, pid: '', ts: Date.now() }); changed = true; }
    } catch (e) { console.warn('photo write fail', key, e.message); }
  }

  if (changed) writeData(d);
  send(res, 200, { ok: true, checkins: d.checkins, photos: d.photos, updated: d.updated });
}

function handlePhotoGet(req, res, key) {
  if (!safeKey(key)) { res.writeHead(400); return res.end('bad key'); }
  const fp = photoPath(key);
  if (!fs.existsSync(fp)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
  const stat = fs.statSync(fp);
  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Content-Length': stat.size,
    'Cache-Control': 'public, max-age=31536000, immutable',
  });
  fs.createReadStream(fp).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    // 健康检查（无鉴权）
    if (p === '/health') return send(res, 200, { ok: true, ts: Date.now() });
    // 照片读取：key 为随机 UUID 不可枚举，无需口令（同 wbsync 图床思路）
    const photoMatch = p.match(/^\/photo\/([A-Za-z0-9_.-]+)$/);
    if (photoMatch && req.method === 'GET') return handlePhotoGet(req, res, photoMatch[1]);
    // 其余全部需要口令（口令走 header，绝不进 URL）
    const token = req.headers['x-token'];
    if (token !== TOKEN) return send(res, 401, { error: 'unauthorized' });
    if (p === '/api/sync' && req.method === 'POST') return await handleSync(req, res);
    if (p === '/sync' && req.method === 'POST') return await handleSync(req, res); // 兼容相对路径 /api/sync -> Caddy strip 后
    if (p === '/api/data' && req.method === 'GET') {
      const d = readData();
      return send(res, 200, { checkins: d.checkins, photos: d.photos, updated: d.updated });
    }
    send(res, 404, { error: 'not-found', path: p });
  } catch (e) {
    if (e.message === 'too-large') return send(res, 413, { error: 'too-large' });
    console.error('ERR', req.method, p, e.message);
    if (!res.headersSent) send(res, 500, { error: 'internal' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[travelsync] listening on 127.0.0.1:${PORT}`);
});
