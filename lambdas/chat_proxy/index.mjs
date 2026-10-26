// Thin streaming proxy: API Gateway (STREAM) -> Lambda -> AgentCore Runtime (JWT inbound auth).
//
// It holds no AWS permissions for AgentCore: it forwards the caller's own Cognito access token, and the
// Runtime's JWT authorizer makes the decision. It adds a correlation id, validates input, sends SSE
// keep-alives (CloudFront's origin read timeout is 60 s) and enforces an upstream timeout.
/* global awslambda */
import { randomUUID } from 'node:crypto';

const RUNTIME_ARN = process.env.AGENT_RUNTIME_ARN;
const REGION = process.env.AWS_REGION;
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 240000);
const SESSION_RE = /^[A-Za-z0-9-]{33,100}$/;
const enc = new TextEncoder();

const log = (fields) => console.log(JSON.stringify({ service: 'chat-proxy', ts: Date.now() / 1000, ...fields }));

function header(event, name) {
  const h = event.headers || {};
  const k = Object.keys(h).find((x) => x.toLowerCase() === name);
  return k ? h[k] : undefined;
}

function respond(stream, statusCode, contentType, extraHeaders = {}) {
  return awslambda.HttpResponseStream.from(stream, {
    statusCode,
    headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extraHeaders },
  });
}

function sendJson(stream, statusCode, obj, corr) {
  const out = respond(stream, statusCode, 'application/json', { 'X-Correlation-Id': corr });
  out.write(JSON.stringify(obj));
  out.end();
}

export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  const corr = randomUUID();
  const path = event.path || event.rawPath || '';
  const t0 = Date.now();

  if (path.endsWith('/health')) {
    return sendJson(responseStream, 200, { status: 'ok', service: 'trialscout-api', runtimeConfigured: Boolean(RUNTIME_ARN) }, corr);
  }

  let body;
  try {
    body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString() : event.body || '{}');
  } catch {
    return sendJson(responseStream, 400, { error: 'Invalid JSON body', correlationId: corr }, corr);
  }
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const sessionId = body.sessionId;
  if (!prompt || prompt.length > 4000) {
    return sendJson(responseStream, 400, { error: 'prompt must be 1-4000 characters', correlationId: corr }, corr);
  }
  if (!SESSION_RE.test(sessionId || '')) {
    return sendJson(responseStream, 400, { error: 'sessionId must be 33-100 chars [A-Za-z0-9-]', correlationId: corr }, corr);
  }
  const auth = header(event, 'authorization');
  if (!auth) return sendJson(responseStream, 401, { error: 'Unauthorized', correlationId: corr }, corr);

  const url = `https://bedrock-agentcore.${REGION}.amazonaws.com/runtimes/${encodeURIComponent(RUNTIME_ARN)}/invocations?qualifier=DEFAULT`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
  let upstream;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        Authorization: auth.startsWith('Bearer ') ? auth : `Bearer ${auth}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': sessionId,
        'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Correlation-Id': corr,
      },
      body: JSON.stringify({ prompt }),
    });
  } catch (e) {
    clearTimeout(timer);
    log({ event: 'upstream_error', correlation_id: corr, error: e.name });
    return sendJson(responseStream, 502, { error: 'Agent unavailable', correlationId: corr }, corr);
  }
  log({ event: 'upstream_status', correlation_id: corr, status: upstream.status });
  if (!upstream.ok) {
    clearTimeout(timer);
    const status = upstream.status === 401 || upstream.status === 403 ? upstream.status : upstream.status === 429 ? 429 : 502;
    return sendJson(responseStream, status, { error: `Agent returned ${upstream.status}`, correlationId: corr }, corr);
  }

  const out = respond(responseStream, 200, 'text/event-stream', { 'X-Correlation-Id': corr });
  const keepAlive = setInterval(() => out.write(enc.encode(': keep-alive\n\n')), 10000);
  try {
    for await (const chunk of upstream.body) out.write(chunk);
  } catch (e) {
    log({ event: 'stream_error', correlation_id: corr, error: e.name });
    out.write(enc.encode(`data: ${JSON.stringify({ type: 'error', message: 'Stream interrupted. Please retry.' })}\n\n`));
  } finally {
    clearInterval(keepAlive);
    clearTimeout(timer);
    out.end();
    log({ event: 'request_done', correlation_id: corr, latency_ms: Date.now() - t0 });
  }
});
