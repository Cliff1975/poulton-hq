// Poulton HQ: Gmail link cleaner.
// Drafts saved by Claude's Gmail connector have every link rewritten to
// https://www.google.com/url?q=<real link>&source=gmail&ust=...&sa=E, which makes
// clients click twice (and shows a "Redirect notice" once the link is a day old).
// This module connects HQ directly to Gmail (OAuth, scope gmail.compose) and
// rewrites those drafts with the real links. It only reads and updates DRAFTS:
// it never sends, never deletes and never touches received or sent mail.
// No dependencies: plain Node.js 18+ (global fetch).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCOPE = 'https://www.googleapis.com/auth/gmail.compose';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

module.exports = function gmailCleaner({ dataDir, baseUrl, clientId, clientSecret, log = console.log }) {
  const TOKEN_FILE = path.join(dataDir, 'google-token.json');
  const STATUS_FILE = path.join(dataDir, 'gmail-clean-status.json');
  const enabled = Boolean(clientId && clientSecret);
  const redirectUri = () => `${baseUrl}/oauth/google/callback`;
  let pendingState = null;
  let access = { token: null, exp: 0 };

  const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
  const writeJSON = (f, j) => { fs.writeFileSync(f + '.tmp', JSON.stringify(j, null, 2)); fs.renameSync(f + '.tmp', f); };
  const status = () => readJSON(STATUS_FILE, { connected: fs.existsSync(TOKEN_FILE), lastRun: null, fixed: [] });
  const saveStatus = s => writeJSON(STATUS_FILE, s);

  // ---------- OAuth ----------
  function authUrl() {
    pendingState = crypto.randomBytes(16).toString('hex');
    const q = new URLSearchParams({
      client_id: clientId, redirect_uri: redirectUri(), response_type: 'code', scope: SCOPE,
      access_type: 'offline', prompt: 'consent', state: pendingState, login_hint: 'info@poultonconsults.com'
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  }
  async function handleCallback(query) {
    if (!query.state || query.state !== pendingState) throw new Error('State mismatch: start again from HQ.');
    pendingState = null;
    if (query.error) throw new Error(`Google said: ${query.error}`);
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: query.code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri(), grant_type: 'authorization_code' })
    });
    const j = await r.json();
    if (!j.refresh_token) throw new Error('Google did not return a refresh token: ' + JSON.stringify(j).slice(0, 200));
    writeJSON(TOKEN_FILE, { refresh_token: j.refresh_token, saved: new Date().toISOString() });
    access = { token: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
    const s = status(); s.connected = true; saveStatus(s);
  }
  async function token() {
    if (access.token && Date.now() < access.exp) return access.token;
    const t = readJSON(TOKEN_FILE, null);
    if (!t) throw new Error('Gmail not connected');
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ refresh_token: t.refresh_token, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token' })
    });
    const j = await r.json();
    if (!j.access_token) throw new Error('Token refresh failed: ' + (j.error || 'unknown'));
    access = { token: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
    return access.token;
  }
  async function gmail(pathPart, opts = {}) {
    const r = await fetch(API + pathPart, { ...opts, headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    if (!r.ok) throw new Error(`Gmail ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.status === 204 ? null : r.json();
  }

  // ---------- MIME rewriting ----------
  const b64urlDecode = s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const b64urlEncode = b => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const WRAP = /https?:\/\/(?:www\.)?google\.com\/url\?q=([^"'<>\s]+?)(?:&amp;|&)source=gmail(?:&amp;|&)ust=\d+(?:&amp;|&)sa=E/g;
  function unwrapText(t, html = true) {
    return t.replace(WRAP, (m, q) => {
      let u = q.replace(/&amp;/g, '&');
      try { u = decodeURIComponent(u); } catch (e) {}
      if (u.startsWith('http://') && !/^http:\/\/(localhost|127\.)/.test(u)) u = 'https://' + u.slice(7); // links typed without https were wrapped as http
      return html ? u.replace(/&/g, '&amp;').replace(/"/g, '%22') : u;
    });
  }
  function qpDecode(s) {
    return Buffer.from(s.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
  }
  function splitHead(block) {
    const i = block.search(/\r?\n\r?\n/);
    if (i < 0) return { head: block, body: '' };
    const sep = block.slice(i).match(/^\r?\n\r?\n/)[0];
    return { head: block.slice(0, i), body: block.slice(i + sep.length) };
  }
  const header = (head, name) => { const m = head.replace(/\r?\n[ \t]+/g, ' ').match(new RegExp(`^${name}:\\s*(.*)$`, 'im')); return m ? m[1].trim() : ''; };
  // Returns { text, changed } for one MIME entity (headers + body), recursing into multiparts.
  function rewriteEntity(entity) {
    const { head, body } = splitHead(entity);
    const ctype = header(head, 'Content-Type') || 'text/plain';
    const nl = entity.includes('\r\n') ? '\r\n' : '\n';
    if (/^multipart\//i.test(ctype)) {
      const bm = ctype.match(/boundary="?([^";]+)"?/i);
      if (!bm) return { text: entity, changed: false };
      const b = '--' + bm[1];
      const parts = body.split(b);
      let changed = false;
      const out = parts.map((p, i) => {
        if (i === 0 || p.startsWith('--')) return p; // preamble and closing
        const lead = p.match(/^\r?\n/) ? p.match(/^\r?\n/)[0] : '';
        const r = rewriteEntity(p.slice(lead.length));
        if (r.changed) changed = true;
        return lead + r.text;
      });
      return { text: head + nl + nl + out.join(b), changed };
    }
    if (!/^text\/(html|plain)/i.test(ctype)) return { text: entity, changed: false }; // attachments untouched
    const cte = header(head, 'Content-Transfer-Encoding').toLowerCase();
    const charset = (ctype.match(/charset="?([^";]+)"?/i) || [, 'utf-8'])[1];
    let raw;
    if (cte === 'base64') raw = Buffer.from(body.replace(/\s+/g, ''), 'base64');
    else if (cte === 'quoted-printable') raw = qpDecode(body);
    else raw = Buffer.from(body, 'latin1');
    const decoded = new TextDecoder(/utf-?8/i.test(charset) ? 'utf-8' : charset).decode(raw);
    const fixed = unwrapText(decoded, /html/i.test(ctype));
    if (fixed === decoded) return { text: entity, changed: false };
    const enc = Buffer.from(fixed, 'utf-8').toString('base64').replace(/.{76}/g, '$&' + nl);
    let newHead = head.replace(/^Content-Transfer-Encoding:.*$/im, 'Content-Transfer-Encoding: base64');
    if (!/^Content-Transfer-Encoding:/im.test(newHead)) newHead += nl + 'Content-Transfer-Encoding: base64';
    newHead = newHead.replace(/(^Content-Type:[^\r\n]*?)charset="?[^";\r\n]+"?/im, '$1charset=UTF-8');
    return { text: newHead + nl + nl + enc + nl, changed: true };
  }

  // ---------- The sweep ----------
  let running = false;
  async function sweep() {
    if (!enabled || !fs.existsSync(TOKEN_FILE) || running) return status();
    running = true;
    const s = status();
    const fixed = [];
    try {
      let pageToken, seen = 0;
      do {
        const list = await gmail(`/drafts?maxResults=100${pageToken ? '&pageToken=' + pageToken : ''}`);
        for (const d of list.drafts || []) {
          if (++seen > 300) break;
          const full = await gmail(`/drafts/${d.id}?format=raw`);
          const mime = b64urlDecode(full.message.raw).toString('latin1');
          if (!mime.includes('google') ) continue;
          const r = rewriteEntity(mime);
          if (!r.changed) continue;
          await gmail(`/drafts/${d.id}`, { method: 'PUT', body: JSON.stringify({ id: d.id, message: { raw: b64urlEncode(Buffer.from(r.text, 'latin1')), threadId: full.message.threadId } }) });
          const subj = header(splitHead(mime).head, 'Subject');
          fixed.push({ id: d.id, subject: subj, at: new Date().toISOString() });
        }
        pageToken = list.nextPageToken;
      } while (pageToken);
      s.lastRun = new Date().toISOString(); s.lastError = null;
      s.fixed = [...fixed, ...(s.fixed || [])].slice(0, 50);
      s.connected = true;
      if (fixed.length) log(`Gmail cleaner: fixed links in ${fixed.length} draft(s)`);
    } catch (e) {
      s.lastRun = new Date().toISOString(); s.lastError = String(e.message || e);
      log('Gmail cleaner error: ' + s.lastError);
    } finally { running = false; saveStatus(s); }
    return s;
  }

  return { enabled, authUrl, handleCallback, sweep, status, _test: { rewriteEntity, unwrapText } };
};
