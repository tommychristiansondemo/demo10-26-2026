// TrialScout Insights API (buffered JSON). Behind CloudFront OAC -> Lambda Function URL (AWS_IAM).
// Every route except /api/health requires a Cognito access token from the Insights app client (X-Insights-Token).
import {
  LOG_SOURCES, METRICS, getKnowledge, getSourceManifest, inventory, invocationLoggingStatus, llmInvocations, log,
  metrics, queryLogs, readSourceFile, tokenFrom, verifyToken,
} from './lib.mjs';

const json = (statusCode, body) => ({
  statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body),
});

const ROUTES = {
  '/api/overview': async () => {
    const [inv, logging, knowledge] = await Promise.all([inventory(), invocationLoggingStatus().catch(() => null), getKnowledge()]);
    return {
      stacks: inv.stacks.map(({ resources, ...s }) => ({ ...s, resourceCount: resources.length })),
      totalResources: inv.totalResources, distinctTypes: inv.distinctTypes, byType: inv.byType, awsServices: inv.awsServices,
      model: process.env.MODEL_ID, invocationLogging: logging,
      knowledge: { lastModified: knowledge.lastModified, versionId: knowledge.versionId, chars: knowledge.text.length },
    };
  },
  '/api/inventory': async () => inventory(),
  '/api/knowledge': async () => getKnowledge(),
  '/api/log-sources': async () => ({ sources: Object.entries(LOG_SOURCES).map(([id, s]) => ({ id, label: s.label })) }),
  '/api/logs': async (q) => queryLogs({ source: q.source, minutes: q.minutes, filter: q.filter, limit: q.limit }),
  '/api/llm': async (q) => llmInvocations({ app: q.app || 'all', user: q.user || '', minutes: q.minutes, limit: q.limit,
    include_system_prompt: q.system === '1', request_id: q.requestId }),
  '/api/metrics': async (q) => ({ catalog: METRICS.map((m) => m.label), ...(await metrics({ hours: q.hours })) }),
  '/api/source': async (q) => (q.path ? readSourceFile(q.path) : getSourceManifest()),
};

export const handler = async (event) => {
  const path = event.rawPath || '/';
  const t0 = Date.now();
  if (path === '/api/health') return json(200, { ok: true });
  const route = ROUTES[path];
  if (!route) return json(404, { error: 'not found' });
  if ((event.requestContext?.http?.method || 'GET') !== 'GET') return json(405, { error: 'GET only' });
  let user;
  try { user = await verifyToken(tokenFrom(event.headers)); } catch (e) { return json(401, { error: 'sign in required' }); }
  try {
    const body = await route(event.queryStringParameters || {});
    log('api_ok', { path, ms: Date.now() - t0, user: user.username });
    return json(body?.error ? 400 : 200, body);
  } catch (e) {
    log('api_error', { path, error: e.name, detail: String(e.message).slice(0, 200) });
    return json(500, { error: `${e.name}: could not load ${path}` });
  }
};
