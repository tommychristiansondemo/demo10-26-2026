// Shared, read-only data layer for TrialScout Insights (used by api.mjs and chat.mjs).
// Everything returned to a browser or to the LLM passes through redact().
import crypto from 'node:crypto';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { CloudWatchLogsClient, DescribeLogGroupsCommand, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { CloudFormationClient, DescribeStacksCommand, ListStackResourcesCommand } from '@aws-sdk/client-cloudformation';
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { BedrockClient, GetModelInvocationLoggingConfigurationCommand } from '@aws-sdk/client-bedrock';

const REGION = process.env.AWS_REGION || 'us-east-1';
const { KNOWLEDGE_BUCKET, USER_POOL_ID, CLIENT_ID, INVOCATION_LOG_GROUP, PREFIX = 'trialscout' } = process.env;
const cfg = { region: REGION, maxAttempts: 4 };
const s3 = new S3Client(cfg), cwl = new CloudWatchLogsClient(cfg), cfn = new CloudFormationClient(cfg);
const cw = new CloudWatchClient(cfg), bedrock = new BedrockClient(cfg);

// ---------------------------------------------------------------- logging (no prompts, no tokens)
export function log(event, fields = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), service: 'insights', event, ...fields }));
}
export function metric(name, value = 1, unit = 'Count', dims = {}) {
  const keys = Object.keys(dims);
  console.log(JSON.stringify({ _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: 'TrialScoutInsights',
    Dimensions: [keys], Metrics: [{ Name: name, Unit: unit }] }] }, ...dims, [name]: value }));
}

// ---------------------------------------------------------------- redaction
const REDACTIONS = [
  [/eyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}/g, '[REDACTED_JWT]'],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY_ID]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  [/\b(bearer)\s+[\w.~+/=-]{16,}/gi, '$1 [REDACTED]'],
  [/("?(?:password|passwd|client_secret|clientSecret|secret_access_key|aws_secret_access_key|session_token|x-origin-verify|refresh_token|access_token|id_token)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1"[REDACTED]"'],
  [/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '[EMAIL]'],
  [/(?<![\w-])(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\w-])/g, '[PHONE]'],
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN]'],
];
export function redact(v) {
  if (typeof v === 'string') return REDACTIONS.reduce((s, [re, rep]) => s.replace(re, rep), v);
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x)]));
  return v;
}
const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}… [+${s.length - n} chars]` : s);

// ---------------------------------------------------------------- auth: verify Cognito access token (RS256)
const ISSUER = `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`;
let jwks = null, jwksAt = 0;
async function keyFor(kid) {
  if (!jwks || Date.now() - jwksAt > 3600_000 || !jwks.find((k) => k.kid === kid)) {
    const r = await fetch(`${ISSUER}/.well-known/jwks.json`, { signal: AbortSignal.timeout(5000) });
    jwks = (await r.json()).keys; jwksAt = Date.now();
  }
  const jwk = jwks.find((k) => k.kid === kid);
  return jwk ? crypto.createPublicKey({ key: jwk, format: 'jwk' }) : null;
}
const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
/** Returns { sub, username, groups } or throws. */
export async function verifyToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('missing token');
  const header = b64json(parts[0]), claims = b64json(parts[1]);
  if (header.alg !== 'RS256') throw new Error('bad alg');
  const key = await keyFor(header.kid);
  if (!key) throw new Error('unknown key');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new Error('bad signature');
  if (claims.iss !== ISSUER || claims.token_use !== 'access' || claims.client_id !== CLIENT_ID) throw new Error('wrong token');
  if (claims.exp * 1000 < Date.now()) throw new Error('expired');
  return { sub: claims.sub, username: claims.username, groups: claims['cognito:groups'] || [] };
}
export function tokenFrom(headers = {}) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return (h['x-insights-token'] || '').replace(/^Bearer\s+/i, '');
}

// ---------------------------------------------------------------- knowledge file + source snapshot
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}
async function s3Text(key) {
  const r = await s3.send(new GetObjectCommand({ Bucket: KNOWLEDGE_BUCKET, Key: key }));
  return { text: await r.Body.transformToString(), lastModified: r.LastModified?.toISOString(), versionId: r.VersionId };
}
export const getKnowledge = () => cached('knowledge', 300_000, () => s3Text('projectknowledge.md'));
export const getSourceManifest = () => cached('manifest', 300_000, async () => JSON.parse((await s3Text('source/manifest.json')).text));
export async function readSourceFile(path) {
  const manifest = await getSourceManifest();
  const entry = manifest.files.find((f) => f.path === path);
  if (!entry) return { error: `Unknown file '${path}'. Use list_source_files to see what exists.` };
  const { text } = await s3Text(`source/${path}`);
  return { path, bytes: entry.bytes, content: redact(text) };
}

// ---------------------------------------------------------------- log sources (allow-list)
export const LOG_SOURCES = {
  agent_runtime: { prefix: `/aws/bedrock-agentcore/runtimes/${PREFIX}_agent-`, label: 'TrialScout agent runtime (stdout: tslog JSON + OTel)' },
  study_mcp_runtime: { prefix: `/aws/bedrock-agentcore/runtimes/${PREFIX}_study_mcp-`, label: 'Study Portfolio MCP runtime' },
  policy_mcp_runtime: { prefix: `/aws/bedrock-agentcore/runtimes/${PREFIX}_policy_mcp-`, label: 'Policy & Protocol MCP runtime' },
  agent_app_logs: { prefix: `/aws/vendedlogs/bedrock-agentcore/${PREFIX}_agent`, exact: true, label: 'Agent runtime APPLICATION_LOGS delivery (AgentCore Observability)' },
  gateway: { prefix: `/aws/vendedlogs/bedrock-agentcore/${PREFIX}-gateway`, exact: true, label: 'AgentCore Gateway application logs' },
  memory: { prefix: `/aws/vendedlogs/bedrock-agentcore/${PREFIX}-memory`, exact: true, label: 'AgentCore Memory application logs' },
  rbac_interceptor: { prefix: `/aws/lambda/${PREFIX}-gateway-rbac`, exact: true, label: 'Gateway RBAC interceptor Lambda' },
  chat_proxy: { prefix: `/aws/lambda/${PREFIX}-chat-proxy`, exact: true, label: 'Streaming chat proxy Lambda (API Gateway backend)' },
  api_access: { prefix: `/aws/apigateway/${PREFIX}-api`, exact: true, label: 'API Gateway access logs (JSON)' },
  insights_api: { prefix: `/aws/lambda/${PREFIX}-insights-api`, exact: true, label: 'Insights API Lambda' },
  insights_chat: { prefix: `/aws/lambda/${PREFIX}-insights-chat`, exact: true, label: 'Insights chatbot Lambda (llm_call metadata)' },
  bedrock_invocations: { prefix: INVOCATION_LOG_GROUP, exact: true, label: 'Bedrock model invocation logs (full prompts + reasoning)' },
};
async function resolveGroup(source) {
  const s = LOG_SOURCES[source];
  if (!s) throw new Error(`unknown source '${source}'`);
  if (s.exact) return s.prefix;
  return cached(`lg:${source}`, 600_000, async () => {
    const r = await cwl.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: s.prefix }));
    if (!r.logGroups?.length) throw new Error(`no log group for ${source} yet`);
    return r.logGroups[0].logGroupName;
  });
}
const bound = (n, lo, hi, d) => Math.min(hi, Math.max(lo, Number.isFinite(+n) ? +n : d));

async function filterEvents(group, { minutes, filter, limit }) {
  const out = [];
  let nextToken;
  const startTime = Date.now() - minutes * 60_000;
  for (let page = 0; page < 6 && out.length < limit; page++) {
    const r = await cwl.send(new FilterLogEventsCommand({ logGroupName: group, startTime, filterPattern: filter || undefined,
      nextToken, limit: Math.min(1000, limit * 4) }));
    out.push(...(r.events || []));
    nextToken = r.nextToken;
    if (!nextToken) break;
  }
  return out.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}

export async function queryLogs({ source, minutes = 60, filter = '', limit = 25 }) {
  minutes = bound(minutes, 1, 7 * 24 * 60, 60); limit = bound(limit, 1, 50, 25);
  if (source === 'bedrock_invocations') return { error: 'Use get_llm_invocations for the Bedrock invocation log.' };
  if (!LOG_SOURCES[source]) return { error: `Unknown source '${source}'. Valid: ${Object.keys(LOG_SOURCES).join(', ')}` };
  const group = await resolveGroup(source);
  const events = await filterEvents(group, { minutes, filter: String(filter).slice(0, 200), limit });
  return redact({ source, logGroup: group, minutes, filter, count: events.length,
    events: events.map((e) => ({ time: new Date(e.timestamp).toISOString(), stream: clip(e.logStreamName, 60), message: clip(e.message, 1500) })) });
}

// ---------------------------------------------------------------- Bedrock invocation log parsing
function appFor(arn = '') {
  if (arn.includes(`${PREFIX}-agent-runtime`)) return 'trialscout-agent';
  if (arn.includes(`${PREFIX}-insights-chat`)) return 'insights-chatbot';
  if (arn.includes(`${PREFIX}-policymcp-runtime`)) return 'policy-mcp (embeddings)';
  return 'other';
}
const textOf = (content = []) => content.map((c) => c.text ?? (c.toolResult ? '[toolResult]' : c.toolUse ? `[toolUse ${c.toolUse.name}]` : '')).filter(Boolean).join('\n');
/** Rebuild the assistant output from either a Converse body or a ConverseStream event list. */
function outputOf(body) {
  const reasoning = [], text = [], tools = [];
  let usage, stopReason;
  const take = (block) => {
    if (block.reasoningContent?.reasoningText?.text) reasoning.push(block.reasoningContent.reasoningText.text);
    if (block.reasoningContent?.redactedContent) reasoning.push('[redacted reasoning]');
    if (block.text) text.push(block.text);
    if (block.toolUse) tools.push({ name: block.toolUse.name, input: block.toolUse.input });
  };
  if (Array.isArray(body)) {
    const starts = {};
    for (const ev of body) {
      const d = ev.contentBlockDelta?.delta;
      if (d?.reasoningContent?.text) reasoning.push(d.reasoningContent.text);
      if (d?.text) text.push(d.text);
      if (ev.contentBlockStart?.start?.toolUse) starts[ev.contentBlockStart.contentBlockIndex] = { name: ev.contentBlockStart.start.toolUse.name, input: '' };
      if (d?.toolUse) { const t = starts[ev.contentBlockDelta.contentBlockIndex]; if (t) t.input += d.toolUse.input; }
      if (ev.metadata?.usage) usage = ev.metadata.usage;
      if (ev.messageStop?.stopReason) stopReason = ev.messageStop.stopReason;
    }
    for (const t of Object.values(starts)) { let input = t.input; try { input = JSON.parse(input); } catch { /* keep raw */ } tools.push({ name: t.name, input }); }
  } else if (body) {
    (body.output?.message?.content || []).forEach(take);
    usage = body.usage; stopReason = body.stopReason;
  }
  return { reasoning: reasoning.join(''), text: text.join(''), tools, usage, stopReason };
}

export async function llmInvocations({ app = 'all', user = '', minutes = 120, limit = 5, include_system_prompt = false, request_id = '' }) {
  minutes = bound(minutes, 1, 7 * 24 * 60, 120); limit = bound(limit, 1, 20, 5);
  const filter = request_id ? `{ $.requestId = "${String(request_id).replace(/[^\w-]/g, '')}" }` : '';
  const events = await filterEvents(INVOCATION_LOG_GROUP, { minutes, filter, limit: app === 'all' && !user ? limit : 80 });
  const items = [];
  for (const e of events) {
    let rec; try { rec = JSON.parse(e.message); } catch { continue; }
    const who = appFor(rec.identity?.arn);
    if (app !== 'all' && who !== app) continue;
    if (user && (rec.requestMetadata?.user || '').toLowerCase() !== String(user).toLowerCase()) continue;
    const input = rec.input?.inputBodyJson || {};
    const msgs = input.messages || [];
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    const out = outputOf(rec.output?.outputBodyJson);
    const system = (input.system || []).map((s) => s.text).filter(Boolean).join('\n');
    items.push({
      time: rec.timestamp, app: who, user: rec.requestMetadata?.user || '(not tagged)', operation: rec.operation, modelId: rec.modelId, requestId: rec.requestId,
      requestMetadata: rec.requestMetadata, inputTokens: rec.input?.inputTokenCount, outputTokens: rec.output?.outputTokenCount,
      cacheReadTokens: rec.input?.cacheReadInputTokenCount, cacheWriteTokens: rec.input?.cacheWriteInputTokenCount,
      thinkingConfig: input.additionalModelRequestFields?.thinking, toolsOffered: (input.toolConfig?.tools || []).map((t) => t.toolSpec?.name).filter(Boolean),
      conversationTurns: msgs.length, systemPromptChars: system.length,
      systemPrompt: include_system_prompt ? clip(system, 6000) : undefined,
      latestUserContent: clip(textOf(lastUser?.content), 2000),
      reasoning: clip(out.reasoning, 4000), outputText: clip(out.text, 3000), toolCalls: out.tools, stopReason: out.stopReason,
      largeBodyInS3: Boolean(rec.input?.inputBodyS3Path || rec.output?.outputBodyS3Path),
    });
    if (items.length >= limit) break;
  }
  return redact({ logGroup: INVOCATION_LOG_GROUP, minutes, app, user: user || 'all', count: items.length, invocations: items });
}

// ---------------------------------------------------------------- inventory (CloudFormation is the source of truth)
export const inventory = () => cached('inventory', 120_000, async () => {
  const stacks = [];
  let token;
  do {
    const r = await cfn.send(new DescribeStacksCommand({ NextToken: token }));
    stacks.push(...r.Stacks.filter((s) => s.StackName.startsWith('TrialScout')));
    token = r.NextToken;
  } while (token);
  const out = { stacks: [], byType: {}, totalResources: 0 };
  for (const s of stacks) {
    const resources = [];
    let t;
    do {
      const r = await cfn.send(new ListStackResourcesCommand({ StackName: s.StackName, NextToken: t }));
      resources.push(...r.StackResourceSummaries); t = r.NextToken;
    } while (t);
    for (const r of resources) out.byType[r.ResourceType] = (out.byType[r.ResourceType] || 0) + 1;
    out.totalResources += resources.length;
    out.stacks.push({
      name: s.StackName, status: s.StackStatus, description: s.Description, lastUpdated: (s.LastUpdatedTime || s.CreationTime)?.toISOString(),
      outputs: (s.Outputs || []).filter((o) => !/secret/i.test(o.OutputKey)).map((o) => ({ key: o.OutputKey, value: o.OutputValue })),
      resources: resources.map((r) => ({ logicalId: r.LogicalResourceId, type: r.ResourceType, physicalId: clip(r.PhysicalResourceId, 140), status: r.ResourceStatus })),
    });
  }
  out.distinctTypes = Object.keys(out.byType).length;
  out.awsServices = [...new Set(Object.keys(out.byType).filter((t) => t.startsWith('AWS::') && t !== 'AWS::CDK::Metadata').map((t) => t.split('::')[1]))].sort();
  return redact(out);
});

export async function invocationLoggingStatus() {
  const r = await bedrock.send(new GetModelInvocationLoggingConfigurationCommand({}));
  const c = r.loggingConfig || {};
  return { enabled: Boolean(c.cloudWatchConfig || c.s3Config), logGroup: c.cloudWatchConfig?.logGroupName,
    text: c.textDataDeliveryEnabled, embeddings: c.embeddingDataDeliveryEnabled };
}

// ---------------------------------------------------------------- metrics (fixed catalog)
const M = (id, ns, name, stat, dims = {}, label = name) => ({ id, label, ns, name, stat, dims });
export const METRICS = [
  M('chat_latency_p90', 'TrialScout', 'ChatLatency', 'p90', { Service: 'agent' }, 'Agent answer latency p90 (ms)'),
  M('agent_errors', 'TrialScout', 'AgentErrors', 'Sum', { Service: 'agent' }, 'Agent errors'),
  M('guardrail_blocks', 'TrialScout', 'GuardrailBlocked', 'Sum', { Service: 'agent' }, 'Guardrail blocks'),
  M('api_requests', 'AWS/ApiGateway', 'Count', 'Sum', { ApiName: `${PREFIX}-api`, Stage: 'prod' }, 'TrialScout API requests'),
  M('api_5xx', 'AWS/ApiGateway', '5XXError', 'Sum', { ApiName: `${PREFIX}-api`, Stage: 'prod' }, 'TrialScout API 5xx'),
  M('proxy_invocations', 'AWS/Lambda', 'Invocations', 'Sum', { FunctionName: `${PREFIX}-chat-proxy` }, 'Chat proxy invocations'),
  M('interceptor_invocations', 'AWS/Lambda', 'Invocations', 'Sum', { FunctionName: `${PREFIX}-gateway-rbac` }, 'Gateway interceptor invocations'),
  M('bedrock_invocations', 'AWS/Bedrock', 'Invocations', 'Sum', { ModelId: process.env.MODEL_ID }, 'Claude invocations (all apps)'),
  M('bedrock_input_tokens', 'AWS/Bedrock', 'InputTokenCount', 'Sum', { ModelId: process.env.MODEL_ID }, 'Claude input tokens'),
  M('bedrock_output_tokens', 'AWS/Bedrock', 'OutputTokenCount', 'Sum', { ModelId: process.env.MODEL_ID }, 'Claude output tokens'),
  M('insights_llm_calls', 'TrialScoutInsights', 'LlmCalls', 'Sum', {}, 'Insights chatbot LLM calls'),
];
export async function metrics({ hours = 24 }) {
  hours = bound(hours, 1, 24 * 14, 24);
  const period = hours <= 6 ? 300 : hours <= 48 ? 3600 : 21600;
  const r = await cw.send(new GetMetricDataCommand({
    StartTime: new Date(Date.now() - hours * 3600_000), EndTime: new Date(),
    MetricDataQueries: METRICS.map((m) => ({ id: m.id, label: m.label, ReturnData: true,
      MetricStat: { Period: period, Stat: m.stat, Metric: { Namespace: m.ns, MetricName: m.name,
        Dimensions: Object.entries(m.dims).map(([Name, Value]) => ({ Name, Value })) } } })),
  }));
  return { hours, periodSeconds: period, series: r.MetricDataResults.map((d) => {
    const pts = d.Timestamps.map((t, i) => ({ t: t.toISOString(), v: Math.round(d.Values[i] * 100) / 100 })).reverse();
    const vals = pts.map((p) => p.v);
    const isPct = METRICS.find((m) => m.id === d.Id).stat.startsWith('p');
    return { id: d.Id, label: d.Label, total: isPct ? undefined : vals.reduce((a, b) => a + b, 0),
      max: vals.length ? Math.max(...vals) : 0, points: pts };
  }) };
}
