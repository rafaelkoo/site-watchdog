# Site watchdog

Every morning this opens each of my websites in a real browser, at desktop and phone size, and checks that it still works and hasn't got worse. When something breaks it opens a GitHub issue, and it closes the issue itself once the next check is clean.

**Live results:** the "Website watchdog" period on [my portfolio](https://rafaelkoo.github.io/) reads `data/latest.json` from this repo.

## Why

I build and run several sites on my own: my portfolio, two demos, and a couple of apps. Nobody tells me when one of them breaks. A broken link, a script error, or a layout that suddenly scrolls sideways on phones could sit there for weeks. AI-assisted code makes building fast. This makes sure it keeps working afterwards.

## What it checks

For every site in [`sites.json`](sites.json), on desktop (1366 px) and phone (390 px):

| Check | How |
|---|---|
| Up | The page answers with a status below 400 |
| Speed | Time to first byte, full load time and page weight, read from the browser's own timing |
| Page errors | JavaScript errors while the page starts up |
| Broken files | Any file from the site's own address that fails to load |
| Broken links | Every link to the same site (up to 40) is fetched |
| Accessibility | [axe-core](https://github.com/dequelabs/axe-core) rules, grouped by impact |
| Phone fit | The page must not scroll sideways at phone width |
| Basics | A page title, and images that all have an `alt` text |

The page is checked with reduced motion turned on, so the result describes the finished page and not something caught half-way through an animation.

Each site gets a **score out of 100**: points come off for errors, accessibility issues (8 for critical, 4 for serious, 1 for moderate), sideways scrolling, broken links, missing `alt` text and slow loading.

## When it raises an alert

An issue titled `[watchdog] <site>` is opened (label `watchdog`) when:

- the site is down on desktop or phone
- there is a page error, a broken link or a missing file
- it scrolls sideways on a phone
- a **new** critical or serious accessibility issue appears
- the score drops by 10 or more since the last check

If the problems change, the issue is updated. When a check is clean again, it comments "Recovered" and closes the issue.

Accepted exceptions live in `sites.json` with the reason written next to them. For example, Just a Dungeon turns off pinch-zoom on purpose, because zooming would fight the game's touch controls.

## Running it

```bash
npm ci
npx playwright install chromium
node watchdog.mjs --dry-run   # check and print only
node watchdog.mjs             # also update data/
```

GitHub Actions runs it daily at 06:17 UTC ([`.github/workflows/watch.yml`](.github/workflows/watch.yml)) using the built-in `GITHUB_TOKEN`. Nothing else needs setting up.

## Files

| File | What it is |
|---|---|
| `watchdog.mjs` | The checker, scoring and alerts |
| `sites.json` | The sites to watch, plus any accepted exceptions |
| `data/latest.json` | Full details of the last check |
| `data/history.json` | A short record of the last 120 checks, for the trend charts |

## First run

On its first local run, the watchdog found three real problems:
- low-contrast status labels on my portfolio;
- faint names on the tracker demo's bar;
- zoom turned off in Just a Dungeon.

I fixed the first two, and recorded the third as an accepted exception.

Built with AI assistance (Claude). I decided what to check and how to score it, and tested it against my own sites.
