import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const scenarioPath = args[0];
const headed = args.includes('--headed');
const urlIdx = args.indexOf('--url');
const baseURL = urlIdx !== -1 ? args[urlIdx + 1] : 'http://localhost:3000';

if (!scenarioPath) {
  console.error('Usage: node run.mjs <scenario.mjs> [--headed] [--url <baseURL>]');
  process.exit(1);
}

const outDir = path.join(process.cwd(), 'playwright-out');
mkdirSync(outDir, { recursive: true });

const scenario = (await import(path.resolve(scenarioPath))).default;
if (typeof scenario !== 'function') {
  throw new Error('scenario must export default async (ctx) => {}');
}

const browser = await chromium.launch({ headless: !headed });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();

const consoleMsgs = [];
const requests = [];
page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => consoleMsgs.push(`[pageerror] ${e.message}`));
page.on('request', (r) => {
  if (!/\.(png|jpe?g|gif|svg|webp|ico|woff2?|ttf)$/i.test(r.url())) {
    requests.push(`${r.method()} ${r.url()}`);
  }
});
page.on('response', async (r) => {
  if (r.status() >= 400) requests.push(`  -> ${r.status()} ${r.url()}`);
});

const screenshot = async (name) => {
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return file;
};

const ctx = { page, context, browser, chromium, baseURL, outDir, screenshot };

try {
  await scenario(ctx);
  await screenshot('screenshot');
} catch (err) {
  console.error('=== SCENARIO ERROR ===');
  console.error(err);
  try {
    await screenshot('error');
  } catch {}
} finally {
  await browser.close();
}

writeFileSync(path.join(outDir, 'console.log'), consoleMsgs.join('\n') || '(none)');
writeFileSync(path.join(outDir, 'network.log'), requests.join('\n') || '(none)');

console.log('=== CONSOLE ===');
console.log(consoleMsgs.join('\n') || '(none)');
console.log('=== NETWORK ===');
console.log(requests.join('\n') || '(none)');
console.log('=== ARTIFACTS ===');
console.log(outDir);
