// Headless browser check: self-sign-up through the page form at https://www.awsteach.com (role chosen at sign-up), streamed chat,
// role badge, phone-width layout. The test account is created through the sign-up form and deleted at the end.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const SITE = 'https://www.awsteach.com';
const ROLE = process.argv[2] || 'analyst';
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
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const evidence = { role: ROLE, username: USERNAME };
try {
  await page.goto(SITE);
  await createAccount(page);
  await page.locator('#chat').waitFor({ state: 'visible', timeout: 20000 });
  await page.locator('#roleBadge').filter({ hasText: /analyst|reader/ }).waitFor({ timeout: 20000 });
  evidence.roleBadge = await page.locator('#roleBadge').textContent();

  await page.locator('#prompt').fill('List the Oncology studies with their enrollment progress as a table.');
  await page.locator('#send').click();
  const meta = page.locator('.msg.assistant .meta').last();
  await meta.filter({ hasText: 'correlation' }).waitFor({ timeout: 150000 });
  const bubble = page.locator('.msg.assistant').last();
  evidence.tools = await bubble.locator('.chip').allTextContents();
  evidence.renderedTable = (await bubble.locator('table').count()) > 0;
  evidence.answerExcerpt = (await bubble.locator('.body').innerText()).slice(0, 300);
  evidence.meta = await meta.textContent();
  await page.screenshot({ path: `${OUT}ui-chat-desktop.png`, fullPage: false });

  await page.setViewportSize({ width: 390, height: 844 });
  evidence.phoneNoHorizontalScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  await page.screenshot({ path: `${OUT}ui-chat-phone.png` });
  evidence.ok = evidence.roleBadge === ROLE && evidence.tools.length > 0 && evidence.phoneNoHorizontalScroll;
} catch (e) {
  evidence.ok = false;
  evidence.error = String(e).slice(0, 400);
  await page.screenshot({ path: `${OUT}ui-failure.png` }).catch(() => {});
} finally {
  await browser.close();
  try { aws('cognito-idp', 'admin-delete-user', '--user-pool-id', poolId, '--username', USERNAME); evidence.cleanedUp = true; } catch { evidence.cleanedUp = false; }
}
writeFileSync(`${OUT}ui-evidence.json`, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
process.exit(evidence.ok ? 0 : 1);
