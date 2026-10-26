// TrialScout SPA: Cognito Authorization Code + PKCE login, streaming chat over SSE (fetch + ReadableStream).
'use strict';

const $ = (id) => document.getElementById(id);
const store = {
  get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* private mode */ } },
  del: (k) => { try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
};
let cfg, tokens = null, sessionId = newSessionId(), busy = false;

const SUGGESTIONS = {
  analyst: [
    'Which recruiting Phase 3 studies are behind plan? Forecast the worst one.',
    'Check PRT-TS-003 for SOP compliance and summarize its amendment.',
    'Which sites breach SOP-006 quality thresholds?',
    'Remember that I prefer answers as compact tables.',
  ],
  reader: [
    'List oncology studies and their enrollment progress.',
    'What does our SOP say about SAE reporting timelines?',
    'Forecast enrollment for TS-001.',
  ],
};

function newSessionId() { return `ts-${crypto.randomUUID()}`; } // 39 chars (Runtime needs >= 33)

function b64url(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function randomString(n = 48) { return b64url(crypto.getRandomValues(new Uint8Array(n))); }
function claims(jwt) {
  try { return JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { return {}; }
}

async function signIn() {
  const verifier = randomString(48);
  const state = randomString(16);
  store.set('pkce_verifier', verifier);
  store.set('oauth_state', state);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const q = new URLSearchParams({ response_type: 'code', client_id: cfg.clientId, redirect_uri: cfg.redirectUri,
    scope: 'openid email profile', state, code_challenge_method: 'S256', code_challenge: challenge });
  location.assign(`https://${cfg.cognitoDomain}/oauth2/authorize?${q}`);
}

async function tokenRequest(params) {
  const r = await fetch(`https://${cfg.cognitoDomain}/oauth2/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.clientId, ...params }),
  });
  if (!r.ok) throw new Error(`token endpoint ${r.status}`);
  return r.json();
}

async function handleRedirect() {
  const p = new URLSearchParams(location.search);
  if (!p.has('code')) return;
  history.replaceState(null, '', '/');
  if (p.get('state') !== store.get('oauth_state')) throw new Error('OAuth state mismatch');
  const t = await tokenRequest({ grant_type: 'authorization_code', code: p.get('code'),
    redirect_uri: cfg.redirectUri, code_verifier: store.get('pkce_verifier') });
  store.del('pkce_verifier'); store.del('oauth_state');
  saveTokens(t);
}

function saveTokens(t) {
  tokens = { access: t.access_token, id: t.id_token, refresh: t.refresh_token || tokens?.refresh };
  store.set('tokens', JSON.stringify(tokens));
}

async function accessToken() {
  if (!tokens) return null;
  const exp = claims(tokens.access).exp || 0;
  if (exp * 1000 - Date.now() > 60000) return tokens.access;
  if (!tokens.refresh) return null;
  try {
    const r = await idp('InitiateAuth', { AuthFlow: 'REFRESH_TOKEN_AUTH', AuthParameters: { REFRESH_TOKEN: tokens.refresh } });
    saveTokens({ access_token: r.AuthenticationResult.AccessToken, id_token: r.AuthenticationResult.IdToken }); return tokens.access;
  }
  catch { return null; }
}

function signOut() {
  store.del('tokens');
  const q = new URLSearchParams({ client_id: cfg.clientId, logout_uri: cfg.redirectUri });
  location.assign(`https://${cfg.cognitoDomain}/logout?${q}`);
}

// ---------- in-page sign-in / self-sign-up (Cognito user-pool API; no secret, public app client) ----------
async function idp(target, body) {
  const r = await fetch(`https://cognito-idp.${cfg.region}.amazonaws.com/`, { method: 'POST',
    headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}` },
    body: JSON.stringify({ ClientId: cfg.clientId, ...body }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(String(j.message || j.__type || `HTTP ${r.status}`).replace(/^\w+ failed with error /, ''));
  return j;
}
async function passwordLogin(username, password) {
  const r = await idp('InitiateAuth', { AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: username, PASSWORD: password } });
  const a = r.AuthenticationResult;
  if (!a) throw new Error(`Unexpected sign-in challenge ${r.ChallengeName || ''}`);
  saveTokens({ access_token: a.AccessToken, id_token: a.IdToken, refresh_token: a.RefreshToken });
}
async function authSubmit(create) {
  const u = $('authUser').value.trim(), pw = $('authPass').value;
  const role = document.querySelector('input[name=role]:checked')?.value || 'reader';
  $('loginError').hidden = true; $('loginInfo').hidden = true;
  if (!$('authForm').reportValidity()) return;
  $('loginBtn').disabled = $('signupBtn').disabled = true;
  try {
    if (create) {
      await idp('SignUp', { Username: u, Password: pw, UserAttributes: [{ Name: 'custom:role', Value: role }] });
      $('loginInfo').textContent = `Account "${u}" created with role ${role}. Signing you in...`; $('loginInfo').hidden = false;
    }
    await passwordLogin(u, pw);
    $('authPass').value = '';
    onSignedIn();
  } catch (e) {
    $('loginError').textContent = e.message; $('loginError').hidden = false;
  } finally { $('loginBtn').disabled = $('signupBtn').disabled = false; }
}
function bindAuthForm() {
  $('authForm').addEventListener('submit', (e) => { e.preventDefault(); authSubmit(false); });
  $('signupBtn').addEventListener('click', () => authSubmit(true));
  $('signIn').addEventListener('click', (e) => { e.preventDefault(); signIn(); });
}

// ---------- minimal safe markdown (escape first, then format) ----------
function esc(s) { return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function inline(s) {
  return s.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
}
function markdown(src) {
  const lines = esc(src).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const row = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      let html = '<table><thead><tr>' + row(l).map((c) => `<th>${c}</th>`).join('') + '</tr></thead><tbody>';
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { html += '<tr>' + row(lines[i]).map((c) => `<td>${c}</td>`).join('') + '</tr>'; i++; }
      i--; out.push(html + '</tbody></table>');
    } else if (/^\s*[-*] /.test(l)) {
      let html = '<ul>';
      while (i < lines.length && /^\s*[-*] /.test(lines[i])) { html += `<li>${inline(lines[i].replace(/^\s*[-*] /, ''))}</li>`; i++; }
      i--; out.push(html + '</ul>');
    } else if (/^#{1,4} /.test(l)) {
      out.push(`<h4>${inline(l.replace(/^#{1,4} /, ''))}</h4>`);
    } else if (l.trim()) {
      out.push(`<p>${inline(l)}</p>`);
    }
  }
  return out.join('');
}

// ---------- chat ----------
function addMsg(cls, html) {
  const el = document.createElement('div');
  el.className = `msg ${cls}`;
  el.innerHTML = html;
  $('messages').appendChild(el);
  $('messages').scrollTop = $('messages').scrollHeight;
  return el;
}

async function send(prompt) {
  if (busy || !prompt.trim()) return;
  busy = true; $('send').disabled = true; $('suggestions').hidden = true;
  addMsg('user', esc(prompt));
  const bubble = addMsg('assistant', '<div class="tools"></div><div class="body typing"></div><div class="meta"></div>');
  const body = bubble.querySelector('.body'), toolsEl = bubble.querySelector('.tools'), meta = bubble.querySelector('.meta');
  let text = '', corr = '';
  try {
    const token = await accessToken();
    if (!token) { signIn(); return; }
    // Abort if the whole answer takes > 210 s or the stream stalls > 90 s (server sends keep-alives every 10 s).
    const ac = new AbortController();
    const hardStop = setTimeout(() => ac.abort(), 210000);
    let stall = setTimeout(() => ac.abort(), 90000);
    const r = await fetch('/api/chat', {
      method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ prompt, sessionId }),
    });
    corr = r.headers.get('X-Correlation-Id') || '';
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(r.status === 429 ? 'Rate limit reached -- wait a moment and retry.' : (err.error || err.message || `HTTP ${r.status}`));
    }
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      clearTimeout(stall); stall = setTimeout(() => ac.abort(), 90000);
      if (done) { clearTimeout(stall); clearTimeout(hardStop); break; }
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const data = frame.split('\n').filter((x) => x.startsWith('data:')).map((x) => x.slice(5).trim()).join('');
        if (!data) continue;
        let ev; try { ev = JSON.parse(data); } catch { continue; }
        if (typeof ev === 'string') { try { ev = JSON.parse(ev); } catch { continue; } }
        if (ev.type === 'text') { text += ev.delta; body.innerHTML = markdown(text); }
        else if (ev.type === 'tool') { if (text && !text.endsWith('\n\n')) text += '\n\n'; const c = document.createElement('span'); c.className = 'chip'; c.textContent = ev.name; toolsEl.appendChild(c); }
        else if (ev.type === 'blocked') { bubble.classList.add('blocked'); text = ev.message; body.innerHTML = markdown(`**Blocked by guardrail.** ${text}`); }
        else if (ev.type === 'error') { bubble.classList.add('blocked'); body.textContent = ev.message; }
        else if (ev.type === 'meta') { corr = ev.correlation_id || corr; }
        else if (ev.type === 'done') { meta.textContent = `${(ev.latency_ms / 1000).toFixed(1)} s · correlation ${corr}`; }
        $('messages').scrollTop = $('messages').scrollHeight;
      }
    }
  } catch (e) {
    bubble.classList.add('blocked');
    body.textContent = e.name === 'AbortError' ? 'The answer timed out. Please retry.' : `Request failed: ${e.message}`;
    if (corr) meta.textContent = `correlation ${corr}`;
  } finally {
    body.classList.remove('typing');
    busy = false; $('send').disabled = false; $('prompt').focus();
  }
}

function onSignedIn() { showChat(); }

function showChat() {
  const c = claims(tokens.access), idc = claims(tokens.id || '');
  const role = (c['cognito:groups'] || []).includes('analyst') ? 'analyst' : 'reader';
  $('userName').textContent = idc['cognito:username'] || c.username || '';
  $('roleBadge').textContent = role; $('roleBadge').className = `badge ${role}`;
  $('user').hidden = false; $('chat').hidden = false; $('login').hidden = true;
  const sug = $('suggestions'); sug.innerHTML = ''; sug.hidden = false;
  for (const s of SUGGESTIONS[role]) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = s;
    b.addEventListener('click', () => send(s)); sug.appendChild(b);
  }
}

async function main() {
  cfg = await (await fetch('/config.json', { cache: 'no-store' })).json();
  bindAuthForm();
  $('signOut').addEventListener('click', signOut);
  $('newChat').addEventListener('click', () => { sessionId = newSessionId(); $('messages').innerHTML = ''; showChat(); });
  $('composer').addEventListener('submit', (e) => { e.preventDefault(); const v = $('prompt').value; $('prompt').value = ''; send(v); });
  $('prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('composer').requestSubmit(); } });
  try { await handleRedirect(); } catch (e) { $('loginError').textContent = e.message; $('loginError').hidden = false; }
  if (!tokens) { try { tokens = JSON.parse(store.get('tokens') || 'null'); } catch { tokens = null; } }
  if (tokens && await accessToken()) showChat(); else { $('login').hidden = false; }
}

main();
