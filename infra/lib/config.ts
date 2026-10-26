// Single source of truth for names and demo settings.
export const PROJECT = 'TrialScout';
export const PREFIX = 'trialscout';
export const DOMAIN_ZONE = 'awsteach.com';
export const SITE_HOST = 'www.awsteach.com';
export const INSIGHTS_HOST = 'insights.awsteach.com';
export const MODEL_ID = 'us.anthropic.claude-sonnet-4-6'; // newest Claude model this account can invoke (5.x denied)
export const EMBED_MODEL_ID = 'amazon.titan-embed-text-v2:0';
export const MCP_SCOPE = 'trialscout-mcp/invoke';
export const BUDGET_USD = 100;

export const TAGS = { Project: PROJECT, Owner: 'instructor', Environment: 'demo' };

// Role -> tool authorization policy, enforced by the Gateway interceptor and mirrored in the agent.
export const ROLE_TOOLS: Record<string, string[]> = {
  reader: ['search_studies', 'get_site_performance', 'search_documents'],
  analyst: ['search_studies', 'get_site_performance', 'forecast_enrollment',
    'search_documents', 'check_compliance', 'summarize_amendment'],
};

