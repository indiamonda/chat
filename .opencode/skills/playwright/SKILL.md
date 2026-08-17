---
name: playwright
description: Use when the user asks to automate, browse, click, fill forms, screenshot, or test the web UI of this project with a real headless browser. Covers the chat app (served at /, dev http://localhost:3000) and the Schoology dashboard (at /schoology/, prod https://jchat.fly.dev). Drives this repo's Node Playwright via the bundled run.mjs helper instead of an MCP server.
---

# Playwright browser automation (this project)

Use Playwright to drive a real Chromium browser against this repo's web UI —
the main chat app and the Schoology dashboard — without touching app code. This
is a **pure skill**: it runs a script against the project's existing
`playwright` npm dependency. No MCP server is involved.

## What's already available

- `playwright@1.58.2` is a dependency in the repo root `package.json`.
- Chromium for that version is already installed
  (`~/Library/Caches/ms-playwright`), so `chromium.launch()` works with no
  extra `playwright install` step.
- The repo root `package.json` sets `"type": "module"`. Always use ESM
  (`import { chromium } from 'playwright'`) and `.mjs` files so scripts run
  regardless of where they live. Do **not** use `require()` in a file; it only
  happens to work in `node -e` (which ignores `"type"`).

## How to run

The skill ships a helper runner that launches Chromium, runs your scenario, and
captures console logs, network requests, and a screenshot.

```bash
node .opencode/skills/playwright/run.mjs <scenario.mjs> [--headed] [--url <baseURL>]
```

- `<scenario.mjs>` — a file you write (see template below). Its default export
  is `async (ctx) => { ... }`.
- `--headed` — launch a visible browser (default is headless).
- `--url <baseURL>` — sets `ctx.baseURL` (default `http://localhost:3000`).
- Artifacts are written to `./playwright-out/` (screenshot + logs). Read the
  screenshot back with the `read` tool to see what happened.

## Scenario template

Write this to a temp path (e.g. `/tmp/pw-scenario.mjs`), then run it. The
scenario only needs to export a function — it never imports Playwright itself.

```js
export default async ({ page, context, browser, chromium, baseURL, outDir, screenshot }) => {
  await page.goto(baseURL, { waitUntil: 'networkidle' });

  // Interact
  await page.getByText('Sign in').click();
  await page.locator('input[name="username"]').fill('test');
  await page.getByRole('button', { name: 'Login' }).click();

  // Assert / inspect
  await page.waitForSelector('.some-element');
  const title = await page.title();
  console.log('TITLE:', title);

  // Extra screenshots land in outDir
  await screenshot('after-login');
};
```

`ctx` fields:

| key         | what it is                                                    |
|-------------|---------------------------------------------------------------|
| `page`      | Playwright `Page` (already listening for console/network)      |
| `context`   | Browser `Context` (1280x800 viewport)                          |
| `browser`   | Chromium `Browser`                                             |
| `chromium`  | the `chromium` module                                          |
| `baseURL`   | from `--url`, default `http://localhost:3000`                  |
| `outDir`    | absolute path to `./playwright-out/`                           |
| `screenshot`| `async (name) => path` — saves `outDir/<name>.png`, returns path |

## App specifics

- **Main chat**: dev `http://localhost:3000` (`npm run dev`), prod
  `https://jchat.fly.dev`. Auth is a session cookie set on signup/login.
- **Schoology dashboard**: lives behind the Node proxy at `/schoology/` and
  needs the full Docker image locally — for UI automation, use prod
  `https://jchat.fly.dev/schoology/`. Its APIs use **HTTP Basic auth**
  (`Authorization: Basic ...`); when driving the UI, fill the login form rather
  than hand-building headers.
- The dashboard is slow to cold-start (Playwright daemon pool + upstream
  Schoology scrape). Wait generously (`waitUntil: 'networkidle'` is often too
  eager; prefer `waitForSelector` on the section containers).

## Reading results

1. The runner prints `=== CONSOLE ===`, `=== NETWORK ===` (including 4xx/5xx
   responses), and the screenshot path.
2. `read` the screenshot file (`./playwright-out/screenshot.png`) — the Read
   tool renders images.
3. Use `--headed` when you need to watch an interaction live or debug a
   timing/visibility issue.

## Pitfalls

- Use ESM `.mjs` (see above) — `require()` in a file will break under
  `"type": "module"`.
- Headless vs headed can behave differently (animations, `hover`, timing).
- Don't commit `playwright-out/` or temp scenario files into the repo.
- Only drive the real UI against localhost or the user's own prod deployment;
  never against a third party's site.
- This skill automates the **web UI only**. It is unrelated to the headless
  Playwright browser inside `schoology-mcp/` that the dashboard itself uses to
  scrape Schoology — don't confuse the two.
