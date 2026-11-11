// Website watchdog: opens each site in a real browser at desktop and phone size, checks that it is up, fast,
// error-free, accessible and fits a phone, keeps a history, and raises a GitHub issue when something breaks or
// gets worse (and closes it again when it recovers).
//
//   node watchdog.mjs                 check every site in sites.json and update data/
//   node watchdog.mjs --dry-run       check and print, but write nothing and raise no issues
//
// In GitHub Actions it uses GITHUB_TOKEN and GITHUB_REPOSITORY for the issues. Nothing else is needed.

import { chromium } from 'playwright';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const AXE = await readFile(require.resolve('axe-core/axe.min.js'), 'utf8');
const DRY = process.argv.includes('--dry-run');
const SITES = JSON.parse(await readFile(process.env.SITES_FILE || new URL('./sites.json', import.meta.url), 'utf8'));
const DATA = new URL('./data/', import.meta.url);
const KEEP_RUNS = 120;
const VIEWS = {
  // reducedMotion: judge the finished page, not content caught half-way through an entrance animation
  desktop: { viewport: { width: 1366, height: 900 }, reducedMotion: 'reduce' },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, reducedMotion: 'reduce' },
};

/* ---------------- one page, one viewport ---------------- */
async function checkView(browser, site, view) {
  const ctx = await browser.newContext({ ...VIEWS[view], userAgent: undefined });
  const page = await ctx.newPage();
  const origin = new URL(site.url).origin;
  const jsErrors = [], failed = [];
  page.on('pageerror', e => jsErrors.push(String(e.message || e).slice(0, 200)));
  page.on('response', r => { if (r.status() >= 400 && r.url().startsWith(origin)) failed.push(`${r.status()} ${r.url()}`); });
  page.on('requestfailed', r => { if (r.url().startsWith(origin)) failed.push(`failed ${r.url()}`); });
  const out = { view, up: false };
  try {
    const resp = await page.goto(site.url, { waitUntil: 'load', timeout: 45000 });
    out.status = resp ? resp.status() : 0;
    out.up = !!resp && resp.status() < 400;
    await page.waitForTimeout(1500); // let start-up scripts run so their errors are caught
    Object.assign(out, await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] || {};
      const res = performance.getEntriesByType('resource');
      const bytes = res.reduce((a, r) => a + (r.transferSize || r.encodedBodySize || 0), nav.transferSize || nav.encodedBodySize || 0);
      return {
        title: document.title.trim(),
        hasDescription: !!document.querySelector('meta[name="description"][content]'),
        ttfbMs: Math.round(nav.responseStart || 0),
        loadMs: Math.round(nav.loadEventEnd || nav.duration || 0),
        kb: Math.round(bytes / 1024),
        requests: res.length + 1,
        overflowPx: Math.max(0, document.documentElement.scrollWidth - innerWidth),
        imgNoAlt: [...document.images].filter(i => !i.hasAttribute('alt')).length,
      };
    }));
    await page.addScriptTag({ content: AXE });
    const axe = await page.evaluate(async () => {
      const r = await window.axe.run(document, { resultTypes: ['violations'] });
      return r.violations.map(v => ({ id: v.id, impact: v.impact || 'minor', help: v.help, nodes: v.nodes.length, where: v.nodes.slice(0, 5).map(n => n.target.join(' ')) }));
    });
    const ignore = new Set(site.ignore || []);   // accepted exceptions, each with a reason in sites.json
    out.axe = axe.filter(x => !ignore.has(x.id));
    if (view === 'desktop') {
      const hrefs = await page.evaluate(o => [...new Set([...document.querySelectorAll('a[href]')].map(a => a.href.split('#')[0])
        .filter(h => h.startsWith(o)))].slice(0, 40), origin);
      out.linksChecked = hrefs.length;
      out.brokenLinks = [];
      for (const h of hrefs) {
        try { const r = await page.request.get(h, { timeout: 20000, maxRedirects: 5 }); if (r.status() >= 400) out.brokenLinks.push(`${r.status()} ${h}`); }
        catch (e) { out.brokenLinks.push(`error ${h}`); }
      }
    }
  } catch (e) {
    out.error = String(e.message || e).split('\n')[0].slice(0, 200);
  }
  out.jsErrors = [...new Set(jsErrors)];
  out.failedRequests = [...new Set(failed)].slice(0, 10);
  await ctx.close();
  return out;
}

/* ---------------- scoring: 100 is perfect ---------------- */
const IMPACT = { critical: 8, serious: 4, moderate: 1, minor: 0.5 };
function scoreView(v) {
  if (!v.up) return 0;
  let s = 100;
  s -= Math.min(30, 10 * v.jsErrors.length);
  s -= Math.min(40, (v.axe || []).reduce((a, x) => a + (IMPACT[x.impact] || 0.5), 0));
  s -= v.overflowPx > 1 ? 10 : 0;
  s -= Math.min(20, 5 * ((v.brokenLinks || []).length + v.failedRequests.length));
  s -= Math.min(10, 2 * (v.imgNoAlt || 0));
  s -= v.loadMs > 6000 ? 10 : v.loadMs > 3000 ? 5 : 0;
  s -= v.title ? 0 : 5;
  return Math.max(0, Math.round(s));
}

/* ---------------- what counts as a problem worth an alert ---------------- */
function problemsOf(site, prev) {
  const p = [];
  for (const v of [site.desktop, site.phone]) {
    if (!v.up) p.push(`Down on ${v.view}: ${v.error || 'HTTP ' + v.status}`);
    if (v.jsErrors.length) p.push(`${v.jsErrors.length} page error(s) on ${v.view}: ${v.jsErrors[0]}`);
    if (v.overflowPx > 1) p.push(`Scrolls sideways on ${v.view} by ${v.overflowPx}px`);
    for (const b of v.brokenLinks || []) p.push(`Broken link: ${b}`);
    for (const f of v.failedRequests) p.push(`Failed file on ${v.view}: ${f}`);
    const bad = (v.axe || []).filter(x => x.impact === 'critical' || x.impact === 'serious');
    const before = new Set(((prev && prev[v.view] && prev[v.view].axe) || []).map(x => x.id));
    for (const x of bad) if (!before.has(x.id)) p.push(`New ${x.impact} accessibility issue on ${v.view}: ${x.help} (${x.nodes} place(s))`);
  }
  if (prev && typeof prev.score === 'number' && site.score <= prev.score - 10) p.push(`Score dropped from ${prev.score} to ${site.score}`);
  return p;
}

/* ---------------- GitHub issues as alerts ---------------- */
const GH = process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY ? { token: process.env.GITHUB_TOKEN, repo: process.env.GITHUB_REPOSITORY } : null;
async function gh(path, init = {}) {
  const r = await fetch(`https://api.github.com/repos/${GH.repo}${path}`, { ...init, headers: { authorization: `Bearer ${GH.token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`GitHub ${r.status} on ${path}: ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json();
}
async function alert(site, problems, run) {
  if (!GH || DRY) return;
  const title = `[watchdog] ${site.name}`;
  const open = (await gh(`/issues?state=open&labels=watchdog&per_page=100`)).find(i => i.title === title);
  if (problems.length) {
    const body = `**${site.name}** (${site.url}) needs a look. Checked ${run}.\n\n${problems.map(x => '- ' + x).join('\n')}\n\nScore: ${site.score}/100. This issue closes itself when the next check is clean.`;
    const hash = createHash('sha1').update(problems.join('|')).digest('hex').slice(0, 10);
    if (!open) await gh('/issues', { method: 'POST', body: JSON.stringify({ title, body: body + `\n\n<!-- ${hash} -->`, labels: ['watchdog'] }) });
    else if (!(open.body || '').includes(hash)) await gh(`/issues/${open.number}/comments`, { method: 'POST', body: JSON.stringify({ body: `Still not right, and it changed:\n\n${problems.map(x => '- ' + x).join('\n')}\n\n<!-- ${hash} -->` }) }), await gh(`/issues/${open.number}`, { method: 'PATCH', body: JSON.stringify({ body: body + `\n\n<!-- ${hash} -->` }) });
  } else if (open) {
    await gh(`/issues/${open.number}/comments`, { method: 'POST', body: JSON.stringify({ body: `Recovered: the check on ${run} was clean (score ${site.score}/100). Closing.` }) });
    await gh(`/issues/${open.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
  }
}

/* ---------------- run ---------------- */
const readJson = async (name, fallback) => { try { return JSON.parse(await readFile(new URL(name, DATA), 'utf8')); } catch { return fallback; } };
const prevLatest = await readJson('latest.json', { sites: [] });
const history = await readJson('history.json', []);
const at = new Date().toISOString();
const browser = await chromium.launch();
const sites = [];
for (const s of SITES) {
  const desktop = await checkView(browser, s, 'desktop');
  const phone = await checkView(browser, s, 'phone');
  const site = { name: s.name, url: s.url, desktop, phone };
  site.score = Math.round((scoreView(desktop) + scoreView(phone)) / 2);
  site.up = desktop.up && phone.up;
  const prev = prevLatest.sites.find(x => x.url === s.url);
  site.problems = problemsOf(site, prev);
  site.state = !site.up ? 'down' : site.problems.length ? 'warn' : 'ok';
  sites.push(site);
  console.log(`${site.state.padEnd(4)} ${String(site.score).padStart(3)}  ${s.name}  ${desktop.loadMs ?? '-'}ms  ${site.problems.length} problem(s)`);
  for (const p of site.problems) console.log('       - ' + p);
}
await browser.close();

const latest = { checkedAt: at, sites };
const runRow = { at, sites: sites.map(s => ({ url: s.url, score: s.score, up: s.up, loadMs: s.desktop.loadMs || 0, kb: s.desktop.kb || 0,
  axe: [...(s.desktop.axe || []), ...(s.phone.axe || [])].length, problems: s.problems.length })) };
history.push(runRow);
while (history.length > KEEP_RUNS) history.shift();

if (!DRY) {
  await mkdir(DATA, { recursive: true });
  await writeFile(new URL('latest.json', DATA), JSON.stringify(latest, null, 1));
  await writeFile(new URL('history.json', DATA), JSON.stringify(history));
  for (const s of sites) { try { await alert(s, s.problems, at); } catch (e) { console.error('Alert failed for', s.name, e.message); } }
}
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = sites.map(s => `| ${s.state === 'ok' ? '✅' : s.state === 'warn' ? '⚠️' : '❌'} | [${s.name}](${s.url}) | ${s.score} | ${s.desktop.loadMs ?? '-'} ms | ${s.problems.length} |`).join('\n');
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Website watchdog, ${at}\n\n| | Site | Score | Load (desktop) | Problems |\n|---|---|---|---|---|\n${rows}\n`);
}
// exit 0 even when a site has problems: the issue is the alert, the run itself succeeded
