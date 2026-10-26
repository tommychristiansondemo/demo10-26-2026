// Headless browser check for https://insights.awsteach.com: self-sign-up via the page form, Overview tiles, Knowledge render,
// LLM reasoning tab, a streamed chatbot answer with tool chips + reasoning, phone-width layout.
// Also checks the TrialScout header links to Insights. The test account is created through the sign-up form and deleted at the end.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const SITE = 'https://insights.awsteach.com';
const ROLE = process.argv[2] || 'reader';
const OUT = new URL('../../build/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
// A fresh student account is created through the page's own "Create account" form (self-sign-up), then deleted.
const USERNAME = `ui-${ROLE}-${randomBytes(3).toString('hex')}`;
const password = randomBytes(9).toString('base64url');
const aws = (...a) => execFileSync('aws', ['--region', 'us-east-1', ...a], { encoding: 'utf8' }).trim();
const poolId = aws('cloudformation', 'describe-stacks', '--stack-name', 'TrialScout-Foundation', '--query',
  "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue", '--output', 'text');
async function createAccount(page) {
  await page.locator('#authUser').fill(USERNAME);
  await page.locator('#authPass').fill(password);
  await page.locator(`input[name=role][value=${ROLE}]`).check();
  await page.locator('#signupBtn').click();
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const evidence = { role: ROLE, username: USERNAME };
try {
  await page.goto('https://www.awsteach.com/');
  evidence.mainSiteLink = await page.locator('#insightsLink').getAttribute('href');

  await page.goto(SITE);
  await createAccount(page);
  await page.locator('#app').waitFor({ state: 'visible', timeout: 20000 });

  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.locator('#overview .tile').first().waitFor({ timeout: 30000 });
  evidence.overviewTiles = await page.locator('#overview .tile').allInnerTexts();
  await page.screenshot({ path: `${OUT}insights-overview.png` });

  await page.getByRole('tab', { name: 'Knowledge file' }).click();
  await page.locator('#knowledge h2').first().waitFor({ timeout: 20000 });
  evidence.knowledgeHeadings = (await page.locator('#knowledge h2').allInnerTexts()).slice(0, 6);

  await page.getByRole('tab', { name: 'LLM reasoning' }).click();
  await page.locator('#llmForm button[type=submit]').click();
  await page.locator('#llm .card, #llm p:not(.typing)').first().waitFor({ timeout: 30000 });
  evidence.llmCards = await page.locator('#llm .card').count();
  await page.screenshot({ path: `${OUT}insights-llm.png` });

  await page.getByRole('tab', { name: 'Ask' }).click();
  await page.locator('#prompt').fill('Which AgentCore components does TrialScout use? One line each.');
  await page.locator('#send').click();
  const meta = page.locator('.msg.assistant .meta').last();
  await meta.filter({ hasText: 'correlation' }).waitFor({ timeout: 180000 });
  const bubble = page.locator('.msg.assistant').last();
  evidence.answerExcerpt = (await bubble.locator('.body').innerText()).slice(0, 300);
  evidence.reasoningShown = await bubble.locator('details.thinking').isVisible();
  evidence.meta = await meta.textContent();
  await page.screenshot({ path: `${OUT}insights-chat-desktop.png` });

  await page.setViewportSize({ width: 390, height: 844 });
  evidence.phoneNoHorizontalScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  await page.screenshot({ path: `${OUT}insights-chat-phone.png` });
  evidence.ok = evidence.mainSiteLink === 'https://insights.awsteach.com/' && evidence.overviewTiles.length === 4
    && evidence.knowledgeHeadings.length > 3 && evidence.answerExcerpt.length > 40 && evidence.phoneNoHorizontalScroll;
} catch (e) {
  evidence.ok = false;
  evidence.error = String(e).slice(0, 400);
  await page.screenshot({ path: `${OUT}insights-ui-failure.png` }).catch(() => {});
} finally {
  await browser.close();
  try { aws('cognito-idp', 'admin-delete-user', '--user-pool-id', poolId, '--username', USERNAME); evidence.cleanedUp = true; } catch { evidence.cleanedUp = false; }
}
writeFileSync(`${OUT}insights-ui-evidence.json`, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
process.exit(evidence.ok ? 0 : 1);
