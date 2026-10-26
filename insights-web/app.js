// TrialScout Insights SPA: Cognito PKCE login, read-only dashboards, streaming chatbot (SSE over fetch).
// API calls send the access token in X-Insights-Token (CloudFront OAC re-signs Authorization for the Lambda origin)
// and, for POST bodies, x-amz-content-sha256 (required by OAC for Lambda Function URL origins).
'use strict';

const $ = (id) => document.getElementById(id);
const store = {
  get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* private mode */ } },
  del: (k) => { try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
};
let cfg, tokens = null, convo = [], busy = false;
const loaded = {};

const SUGGESTIONS = [
  'Give me the architecture in five bullets: what runs where?',
  'Where does TrialScout get its data, and how many studies and sites are there?',
  'How many different types of AWS resources are deployed right now, and in which stacks?',
  'Which LLM is used, with what settings, and why?',
  'Show the reasoning from the most recent TrialScout agent call.',
  'How does a reader get blocked from calling forecast_enrollment? Show recent evidence in the logs.',
  'Explain AgentCore Gateway, Identity and Memory as used here.',
  'How is this Insights app built, and how does it avoid exposing secrets?',
];

// ---------------------------------------------------------------- auth (Authorization Code + PKCE)
function b64url(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function randomString(n = 48) { return b64url(crypto.getRandomValues(new Uint8Array(n))); }
function claims(jwt) { try { return JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { return {}; } }

async function signIn() {
  const verifier = randomString(48), state = randomString(16);
  store.set('pkce_verifier', verifier); store.set('oauth_state', state);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const q = new URLSearchParams({ response_type: 'code', client_id: cfg.clientId, redirect_uri: cfg.redirectUri,
    scope: 'openid email profile', state, code_challenge_method: 'S256', code_challenge: challenge });
  location.assign(`https://${cfg.cognitoDomain}/oauth2/authorize?${q}`);
}
async function tokenRequest(params) {
  const r = await fetch(`https://${cfg.cognitoDomain}/oauth2/token`, { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: cfg.clientId, ...params }) });
  if (!r.ok) throw new Error(`token endpoint ${r.status}`);
  return r.json();
}
async function handleRedirect() {
  const p = new URLSearchParams(location.search);
  if (!p.has('code')) return;
  history_replace();
  if (p.get('state') !== store.get('oauth_state')) throw new Error('OAuth state mismatch');
  saveTokens(await tokenRequest({ grant_type: 'authorization_code', code: p.get('code'), redirect_uri: cfg.redirectUri, code_verifier: store.get('pkce_verifier') }));
  store.del('pkce_verifier'); store.del('oauth_state');
}
function history_replace() { window.history.replaceState(null, '', '/'); }
function saveTokens(t) { tokens = { access: t.access_token, id: t.id_token, refresh: t.refresh_token || tokens?.refresh }; store.set('tokens', JSON.stringify(tokens)); }
async function accessToken() {
  if (!tokens) return null;
  if ((claims(tokens.access).exp || 0) * 1000 - Date.now() > 60000) return tokens.access;
  if (!tokens.refresh) return null;
  try {
    const r = await idp('InitiateAuth', { AuthFlow: 'REFRESH_TOKEN_AUTH', AuthParameters: { REFRESH_TOKEN: tokens.refresh } });
    saveTokens({ access_token: r.AuthenticationResult.AccessToken, id_token: r.AuthenticationResult.IdToken }); return tokens.access;
  } catch { return null; }
}
function signOut() {
  store.del('tokens');
  location.assign(`https://${cfg.cognitoDomain}/logout?${new URLSearchParams({ client_id: cfg.clientId, logout_uri: cfg.redirectUri })}`);
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

async function api(path, params = {}) {
  const token = await accessToken();
  if (!token) { signIn(); throw new Error('signing in'); }
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null));
  const r = await fetch(`/api/${path}${q.size ? `?${q}` : ''}`, { headers: { 'X-Insights-Token': token } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

// ---------------------------------------------------------------- safe markdown (escape first, then format)
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function inline(s) {
  return s.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
function markdown(src) {
  const lines = esc(src).split('\n'), out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*```/.test(l)) {
      const buf = []; i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      out.push(`<pre class="code">${buf.join('\n')}</pre>`);
    } else if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const row = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      let html = '<table><thead><tr>' + row(l).map((c) => `<th>${c}</th>`).join('') + '</tr></thead><tbody>';
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { html += '<tr>' + row(lines[i]).map((c) => `<td>${c}</td>`).join('') + '</tr>'; i++; }
      i--; out.push(html + '</tbody></table>');
    } else if (/^\s*([-*]|\d+\.) /.test(l)) {
      let html = '<ul>';
      while (i < lines.length && /^\s*([-*]|\d+\.) /.test(lines[i])) { html += `<li>${inline(lines[i].replace(/^\s*([-*]|\d+\.) /, ''))}</li>`; i++; }
      i--; out.push(html + '</ul>');
    } else if (/^#{1,6} /.test(l)) {
      const n = Math.min(4, l.match(/^#+/)[0].length + 1);
      out.push(`<h${n}>${inline(l.replace(/^#{1,6} /, ''))}</h${n}>`);
    } else if (/^&gt; /.test(l)) out.push(`<blockquote>${inline(l.slice(5))}</blockquote>`);
    else if (l.trim()) out.push(`<p>${inline(l)}</p>`);
  }
  return out.join('');
}

// ---------------------------------------------------------------- chat
function addMsg(cls, html) {
  const el = document.createElement('div'); el.className = `msg ${cls}`; el.innerHTML = html;
  $('messages').appendChild(el); $('messages').scrollTop = $('messages').scrollHeight; return el;
}
async function sha256hex(text) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function send(prompt) {
  if (busy || !prompt.trim()) return;
  busy = true; $('send').disabled = true; $('suggestions').hidden = true;
  addMsg('user', esc(prompt));
  convo.push({ role: 'user', text: prompt });
  const bubble = addMsg('assistant', '<details class="thinking" hidden><summary>Model reasoning</summary><div class="tbody"></div></details><div class="tools"></div><div class="body typing"></div><div class="meta"></div>');
  const body = bubble.querySelector('.body'), toolsEl = bubble.querySelector('.tools'), meta = bubble.querySelector('.meta');
  const thinkWrap = bubble.querySelector('.thinking'), thinkBody = bubble.querySelector('.tbody');
  let text = '', thinking = '', corr = '';
  try {
    const token = await accessToken();
    if (!token) { signIn(); return; }
    const payload = JSON.stringify({ messages: convo.slice(-20) });
    const ac = new AbortController();
    const hardStop = setTimeout(() => ac.abort(), 240000);
    let stall = setTimeout(() => ac.abort(), 90000);
    const r = await fetch('/api/chat', { method: 'POST', signal: ac.signal, body: payload,
      headers: { 'Content-Type': 'application/json', 'X-Insights-Token': token, 'x-amz-content-sha256': await sha256hex(payload) } });
    corr = r.headers.get('x-correlation-id') || '';
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(r.status === 429 || r.status === 403 ? 'Rate limit reached -- wait a moment.' : e.error || `HTTP ${r.status}`); }
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
        if (ev.type === 'text') { text += ev.delta; body.innerHTML = markdown(text); }
        else if (ev.type === 'thinking') { thinking += ev.delta; thinkWrap.hidden = false; thinkBody.textContent = thinking; }
        else if (ev.type === 'tool') {
          if (text && !text.endsWith('\n\n')) text += '\n\n';
          const c = document.createElement('span'); c.className = 'chip'; c.title = JSON.stringify(ev.input);
          c.textContent = ev.input?.source ? `${ev.name}(${ev.input.source})` : ev.name; toolsEl.appendChild(c);
        } else if (ev.type === 'error') { bubble.classList.add('blocked'); body.textContent = ev.message; }
        else if (ev.type === 'meta') corr = ev.correlation_id || corr;
        else if (ev.type === 'done') {
          const u = ev.usage || {};
          meta.textContent = `${(ev.latency_ms / 1000).toFixed(1)} s · tokens in ${u.input} (cache read ${u.cacheRead}, write ${u.cacheWrite}) / out ${u.output} · correlation ${corr}`;
        }
        $('messages').scrollTop = $('messages').scrollHeight;
      }
    }
    if (text) convo.push({ role: 'assistant', text });
  } catch (e) {
    bubble.classList.add('blocked');
    body.textContent = e.name === 'AbortError' ? 'The answer timed out. Please retry.' : `Request failed: ${e.message}`;
    convo.pop();
  } finally {
    body.classList.remove('typing'); busy = false; $('send').disabled = false; $('prompt').focus();
  }
}
function resetChat() {
  convo = []; $('messages').innerHTML = '';
  addMsg('assistant intro', markdown('Ask me how the TrialScout demo is designed, deployed and running. I read the project knowledge file and can pull **live** inventory, logs, metrics, source files and the **reasoning** behind recent LLM calls.'));
  const sug = $('suggestions'); sug.innerHTML = ''; sug.hidden = false;
  for (const s of SUGGESTIONS) { const b = document.createElement('button'); b.type = 'button'; b.textContent = s; b.addEventListener('click', () => send(s)); sug.appendChild(b); }
}

// ---------------------------------------------------------------- dashboards
const table = (cols, rows) => `<table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${
  rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
const errBox = (e) => `<p class="err">${esc(e.message)}</p>`;

async function loadOverview() {
  const o = await api('overview');
  const types = Object.entries(o.byType).sort((a, b) => b[1] - a[1]);
  $('overview').innerHTML = `
    <div class="tiles">
      <div class="tile"><b>${o.stacks.length}</b><span>CloudFormation stacks</span></div>
      <div class="tile"><b>${o.totalResources}</b><span>stack resources</span></div>
      <div class="tile"><b>${o.distinctTypes}</b><span>distinct resource types</span></div>
      <div class="tile"><b>${o.awsServices.length}</b><span>AWS services</span></div>
    </div>
    <p>Model: <code>${esc(o.model)}</code> · Bedrock invocation logging: <b>${o.invocationLogging?.enabled ? 'on' : 'off'}</b> ${o.invocationLogging?.logGroup ? `→ <code>${esc(o.invocationLogging.logGroup)}</code>` : ''}
      · Knowledge file updated ${esc(o.knowledge.lastModified)}</p>
    <h3>Stacks</h3>${table(['Stack', 'Status', 'Resources', 'Last update', 'Purpose'], o.stacks.map((s) => [`<code>${esc(s.name)}</code>`, esc(s.status), s.resourceCount, esc(s.lastUpdated?.slice(0, 16).replace('T', ' ')), esc(s.description || '')]))}
    <h3>Services</h3><p>${o.awsServices.map((s) => `<span class="chip">${esc(s)}</span>`).join(' ')}</p>
    <h3>Resource types</h3>${table(['Type', 'Count'], types.map(([t, n]) => [`<code>${esc(t)}</code>`, n]))}`;
}

async function loadLlm(form) {
  $('llm').innerHTML = '<p class="typing">Loading</p>';
  const fd = new FormData(form);
  const d = await api('llm', { app: fd.get('app'), user: fd.get('user').trim(), minutes: fd.get('minutes'), limit: 10, system: fd.get('system') ? '1' : '' });
  if (!d.invocations.length) { $('llm').innerHTML = '<p>No model invocations in this window. Ask TrialScout or the chatbot something, then reload (logs arrive within ~1 minute).</p>'; return; }
  $('llm').innerHTML = d.invocations.map((x) => `
    <article class="card">
      <header><span class="chip">${esc(x.app)}</span> <span class="chip">user: ${esc(x.user)}</span> <code>${esc(x.operation)}</code> ${esc(x.time)} · in ${x.inputTokens ?? '?'} / out ${x.outputTokens ?? '?'} tokens${x.cacheReadTokens ? ` · cache read ${x.cacheReadTokens}` : ''} · stop: ${esc(x.stopReason || '')}</header>
      <p class="sub">request ${esc(x.requestId)} ${x.requestMetadata ? `· metadata <code>${esc(JSON.stringify(x.requestMetadata))}</code>` : ''} · thinking <code>${esc(JSON.stringify(x.thinkingConfig || 'off'))}</code> · turns ${x.conversationTurns} · tools offered: ${esc((x.toolsOffered || []).join(', ') || 'none')}</p>
      ${x.systemPrompt ? `<details><summary>System prompt (${x.systemPromptChars} chars)</summary><pre class="code">${esc(x.systemPrompt)}</pre></details>` : ''}
      <h4>Latest user content</h4><pre class="code">${esc(x.latestUserContent || '')}</pre>
      <h4>Reasoning</h4><pre class="code reasoning">${esc(x.reasoning || '(no reasoning block in this call: adaptive thinking judged it unnecessary)')}</pre>
      ${x.toolCalls?.length ? `<h4>Tool calls</h4><pre class="code">${esc(x.toolCalls.map((t) => `${t.name} ${JSON.stringify(t.input)}`).join('\n'))}</pre>` : ''}
      ${x.outputText ? `<h4>Output</h4><div class="md">${markdown(x.outputText)}</div>` : ''}
    </article>`).join('');
}

async function loadLogs(form) {
  $('logs').innerHTML = '<p class="typing">Loading</p>';
  const fd = new FormData(form);
  const d = await api('logs', { source: fd.get('source'), minutes: fd.get('minutes'), filter: fd.get('filter'), limit: 50 });
  $('logs').innerHTML = `<p class="sub">${esc(d.logGroup)} · ${d.count} events (newest first, values redacted)</p>` +
    (d.events.map((e) => `<div class="logline"><span class="ts">${esc(e.time.slice(11, 23))}</span><pre>${esc(pretty(e.message))}</pre></div>`).join('') || '<p>No events.</p>');
}
function pretty(m) { try { return JSON.stringify(JSON.parse(m), null, 1); } catch { return m; } }

async function loadMetrics(form) {
  $('metrics').innerHTML = '<p class="typing">Loading</p>';
  const d = await api('metrics', { hours: new FormData(form).get('hours') });
  $('metrics').innerHTML = `<div class="tiles">${d.series.map((s) => `
    <div class="tile wide"><span>${esc(s.label)}</span><b>${s.total !== undefined ? Math.round(s.total) : Math.round(s.max)}</b>
    ${spark(s.points)}<small>${s.total !== undefined ? 'total' : 'max'} over ${d.hours} h</small></div>`).join('')}</div>`;
}
function spark(points) {
  if (points.length < 2) return '<svg class="spark" viewBox="0 0 100 24"></svg>';
  const max = Math.max(...points.map((p) => p.v), 1);
  const pts = points.map((p, i) => `${(i / (points.length - 1)) * 100},${22 - (p.v / max) * 20}`).join(' ');
  return `<svg class="spark" viewBox="0 0 100 24" preserveAspectRatio="none"><polyline points="${pts}"/></svg>`;
}

async function loadKnowledge() {
  const k = await api('knowledge');
  $('knowledge').innerHTML = `<p class="sub">s3://…/projectknowledge.md · last modified ${esc(k.lastModified)} · version ${esc(k.versionId)}</p>${markdown(k.text)}`;
}
async function loadSource() {
  const m = await api('source');
  $('fileList').innerHTML = m.files.map((f) => `<li><button type="button" class="file" data-path="${esc(f.path)}">${esc(f.path)}</button></li>`).join('');
  $('fileList').addEventListener('click', async (e) => {
    const p = e.target.closest('button.file')?.dataset.path; if (!p) return;
    $('fileView').textContent = 'Loading…';
    try { const f = await api('source', { path: p }); $('fileView').textContent = f.content; } catch (err) { $('fileView').textContent = err.message; }
  });
}

const LOADERS = { overview: loadOverview, knowledge: loadKnowledge, source: loadSource,
  logs: async () => { if (!$('logSource').options.length) { const s = await api('log-sources'); $('logSource').innerHTML = s.sources.map((x) => `<option value="${esc(x.id)}">${esc(x.label)}</option>`).join(''); } },
  metrics: () => loadMetrics($('metricsForm')) };
function showTab(name) {
  document.querySelectorAll('[role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== name; });
  if (LOADERS[name] && !loaded[name]) {
    loaded[name] = true;
    LOADERS[name]().catch((e) => { loaded[name] = false; const el = $(name) || $('fileView'); if (el) el.innerHTML = errBox(e); });
  }
}

function onSignedIn() { showApp(); }

function showApp() {
  const idc = claims(tokens.id || '');
  $('userName').textContent = idc['cognito:username'] || claims(tokens.access).username || '';
  $('user').hidden = false; $('app').hidden = false; $('login').hidden = true;
  resetChat();
}

async function main() {
  cfg = await (await fetch('/config.json', { cache: 'no-store' })).json();
  $('mainLink').href = cfg.mainSite;
  bindAuthForm();
  $('signOut').addEventListener('click', signOut);
  $('newChat').addEventListener('click', resetChat);
  document.querySelectorAll('[role=tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('composer').addEventListener('submit', (e) => { e.preventDefault(); const v = $('prompt').value; $('prompt').value = ''; send(v); });
  $('prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('composer').requestSubmit(); } });
  const bind = (id, fn, out) => $(id).addEventListener('submit', (e) => { e.preventDefault(); fn(e.target).catch((err) => { $(out).innerHTML = errBox(err); }); });
  bind('llmForm', loadLlm, 'llm'); bind('logsForm', loadLogs, 'logs'); bind('metricsForm', loadMetrics, 'metrics');
  try { await handleRedirect(); } catch (e) { $('loginError').textContent = e.message; $('loginError').hidden = false; }
  if (!tokens) { try { tokens = JSON.parse(store.get('tokens') || 'null'); } catch { tokens = null; } }
  if (tokens && await accessToken()) showApp(); else $('login').hidden = false;
}

main();
