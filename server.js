// Poulton HQ server: serves the dashboard behind a password and stores its data.
// No dependencies: plain Node.js 18+.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const USER = process.env.DASH_USER || 'cliff';
const PASS = process.env.DASH_PASS;               // set in Render > Environment
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');
const INDEX = path.join(__dirname, 'public', 'index.html');

if (!PASS) console.error('DASH_PASS is not set: the dashboard stays locked until it is added in Render > Environment.');
fs.mkdirSync(DATA_DIR, { recursive: true });

const safeEq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function authorised(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [u, ...rest] = Buffer.from(h.slice(6), 'base64').toString().split(':');
  return safeEq(u, USER) && safeEq(rest.join(':'), PASS);
}
const security = {
  'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000', 'Cache-Control': 'no-store'
};

http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (!PASS) {
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', ...security });
    return res.end('<meta name="viewport" content="width=device-width"><body style="font-family:sans-serif;padding:32px;color:#1a3a5c"><h1>Poulton HQ is locked</h1><p>Add the environment variable <b>DASH_PASS</b> in Render &gt; poulton-hq &gt; Environment, save, and the dashboard will open behind your password.</p></body>');
  }
  if (!authorised(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Poulton HQ"', ...security });
    return res.end('Password required');
  }
  const url = req.url.split('?')[0];
  if (url === '/api/state' && req.method === 'GET') {
    let body = '{}';
    try { body = fs.readFileSync(DATA_FILE, 'utf8'); } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'application/json', ...security });
    return res.end(body);
  }
  if (url === '/api/state' && req.method === 'PUT') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 5e6) req.destroy(); });
    req.on('end', () => {
      try {
        const j = JSON.parse(body);
        if (!Array.isArray(j.tasks)) throw new Error('bad shape');
        // keep a dated backup of the previous state once a day
        if (fs.existsSync(DATA_FILE)) {
          const bk = path.join(DATA_DIR, `state-${new Date().toISOString().slice(0, 10)}.json`);
          if (!fs.existsSync(bk)) fs.copyFileSync(DATA_FILE, bk);
        }
        fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(j));
        fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
        res.writeHead(204, security); res.end();
      } catch (e) { res.writeHead(400, security); res.end('Invalid data'); }
    });
    return;
  }
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...security });
    return fs.createReadStream(INDEX).pipe(res);
  }
  res.writeHead(404, security); res.end('Not found');
}).listen(PORT, () => console.log(`Poulton HQ on port ${PORT}`));
