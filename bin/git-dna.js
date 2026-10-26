#!/usr/bin/env node
'use strict';

// git-dna: read the habits in a repository's commit history.
// Zero dependencies. Reads `git log`, prints a report, writes a shareable SVG card.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const VERSION = require('../package.json').version;
const BOOL_FLAGS = ['--me', '--json', '--no-card', '--no-png', '--no-open', '-h', '--help', '-v', '--version'];
const VALUE_FLAGS = ['--author', '--out', '--since', '--until'];

const args = process.argv.slice(2);
const flags = new Set();
const values = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (BOOL_FLAGS.includes(a)) flags.add(a);
  else if (VALUE_FLAGS.includes(a)) {
    if (args[i + 1] === undefined) fail(`${a} needs a value.`);
    values[a] = args[++i];
  } else if (a.startsWith('-')) fail(`Unknown option ${a}. Run git-dna --help.`);
  else positional.push(a);
}
const flag = (name) => flags.has(name);
const opt = (name) => values[name];

function fail(msg) {
  console.error(`\n  ✖ ${msg}\n`);
  process.exit(1);
}

if (flag('-v') || flag('--version')) {
  console.log(VERSION);
  process.exit(0);
}

if (flag('-h') || flag('--help')) {
  console.log(`
  git-dna ${VERSION}: read the habits in a repo's commit history

  Usage:  git-dna [path] [options]

  Options:
    --me              only your commits (matches git config user.email)
    --author <text>   only commits whose author name or email contains <text>
    --since <date>    only commits after <date>, e.g. 2025-01-01 or "1 year ago"
    --until <date>    only commits before <date>
    --out <file>      where to write the card (default: git-dna.svg)
    --no-card         skip the card (SVG and PNG)
    --no-png          keep the SVG card but skip the PNG
    --no-open         don't open the PNG or copy it to the clipboard
    --json            print the raw stats as JSON
    -v, --version     print the version
`);
  process.exit(0);
}

if (positional.length > 1) fail('Pass at most one repository path.');
const startDir = path.resolve(positional[0] || '.');
if (!fs.existsSync(startDir)) fail(`${startDir} does not exist.`);

function git(dir, ...a) {
  return execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] });
}

let repoDir;
try {
  repoDir = git(startDir, 'rev-parse', '--show-toplevel').trim();
} catch (e) {
  if (e.code === 'ENOENT') fail('git is not installed or not on your PATH.');
  fail(`${startDir} is not inside a git repository.`);
}

let authorFilter = opt('--author');
if (flag('--me')) {
  try {
    authorFilter = git(repoDir, 'config', 'user.email').trim();
  } catch {
    console.error('\n  ✖ --me needs `git config user.email` to be set.\n');
    process.exit(1);
  }
}

// ---------- collect ----------

const RS = '\x1e', US = '\x1f';
// quotepath=false keeps non-ASCII file names readable instead of octal-escaped.
const logArgs = ['-c', 'core.quotepath=false', 'log', '--no-merges', '--numstat', '--date=format:%Y-%m-%d|%H|%u|%M',
  `--pretty=format:${RS}%H${US}%an${US}%ae${US}%ad${US}%s`];
if (authorFilter) logArgs.push(`--author=${authorFilter}`, '--regexp-ignore-case', '--fixed-strings');
if (opt('--since')) logArgs.push(`--since=${opt('--since')}`);
if (opt('--until')) logArgs.push(`--until=${opt('--until')}`);

// Shallow clones fake a root commit at the cut-off that "adds" the whole tree; skip those.
const shallowRoots = new Set();
try {
  const shallowFile = path.resolve(repoDir, git(repoDir, 'rev-parse', '--git-path', 'shallow').trim());
  if (fs.existsSync(shallowFile)) fs.readFileSync(shallowFile, 'utf8').split(/\s+/).filter(Boolean).forEach((h) => shallowRoots.add(h));
} catch { /* not shallow */ }

if (process.stderr.isTTY && !flag('--json')) process.stderr.write('  reading history…\r');
let raw = '';
try {
  raw = git(repoDir, ...logArgs);
} catch (e) {
  // An empty repo has no HEAD; anything else is a real error.
  if (!/does not have any commits|bad default revision|unknown revision/.test(String(e.stderr))) {
    fail(`git log failed: ${String(e.stderr || e.message).trim()}`);
  }
}

const commits = [];
for (const chunk of raw.split(RS)) {
  if (!chunk.trim()) continue;
  const [head, ...rest] = chunk.split('\n');
  const [hash, name, email, date, subject = ''] = head.split(US);
  if (!date || shallowRoots.has(hash)) continue; // no date: a stray RS byte in a subject split the record
  const [day, hour, dow, minute = '0'] = date.split('|');
  let add = 0, del = 0;
  const files = [];
  for (const line of rest) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    const a = m[1] === '-' ? 0 : +m[1];
    const d = m[2] === '-' ? 0 : +m[2];
    add += a; del += d;
    files.push({ file: renamedTo(m[3]), a, d });
  }
  // Control characters are dropped so a hostile commit message can't drive the terminal.
  commits.push({ hash, name, email, day, hour: +hour, minute: +minute, dow: +dow, subject: subject.replace(/[\x00-\x1f\x7f-\x9f]/g, ''), add, del, files });
}

// numstat writes renames as "old => new" or "dir/{old => new}/file"; keep the new path.
function renamedTo(file) {
  return file.replace(/\{[^{}]* => ([^{}]*)\}/g, '$1').replace(/^.* => /, '').replace(/\/\//g, '/');
}

if (process.stderr.isTTY && !flag('--json')) process.stderr.write('                  \r');
if (!commits.length && shallowRoots.size && raw.trim()) fail('Only the shallow cut-off commit was fetched. Run `git fetch --unshallow` first.');
if (!commits.length) fail(`No commits found${authorFilter ? ` for "${authorFilter}"` : ''}.`);

// ---------- analyze ----------

const n = commits.length;
const pct = (x) => Math.round((x / n) * 100);
const hours = Array(24).fill(0);
const days = Array(8).fill(0); // 1=Mon..7=Sun
const dayset = new Set();
const authors = new Map();
const langs = new Map();
const churn = new Map();
const firstWords = new Map();
const dayCounts = new Map();
const repeats = new Map();
let night = 0, dawn = 0, office = 0, weekend = 0, friLate = 0;
let fixes = 0, wips = 0, oneWord = 0, reverts = 0, swears = 0, emojis = 0, conventional = 0, msgLen = 0;
let totalAdd = 0, totalDel = 0;
let biggest = commits[0], shortest = commits[0];
let lateNight = null; // the commit closest to dawn, from the midnight-to-5am window

const EXT_LANG = {
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript',
  py: 'Python', rb: 'Ruby', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', swift: 'Swift', c: 'C', h: 'C',
  cc: 'C++', cpp: 'C++', hpp: 'C++', cs: 'C#', php: 'PHP', scala: 'Scala', ex: 'Elixir', exs: 'Elixir',
  hs: 'Haskell', lua: 'Lua', dart: 'Dart', zig: 'Zig', sh: 'Shell', bash: 'Shell', vue: 'Vue', svelte: 'Svelte',
  css: 'CSS', scss: 'CSS', html: 'HTML', md: 'Markdown', sql: 'SQL', clj: 'Clojure', ml: 'OCaml', r: 'R',
};
// "hell" is left out on purpose: "dependency hell" and "callback hell" are descriptions, not rage.
// (?!::) skips identifiers like WebKit's WTF:: namespace.
const SWEAR = /\b(fuck\w*|shit\w*|damn\w*|crap|wtf|ffs)\b(?!::)/i;
// A :shortcode: has to stand alone, so Rust and C++ paths like std::io::Write don't count.
const EMOJI = /\p{Extended_Pictographic}|(^|\s):[a-z0-9_+-]+:(?=\s|$)/u;
const CONVENTIONAL = /^(feat|fix|chore|docs|refactor|test|tests|style|perf|build|ci|revert)(\([^)]*\))?!?:/i;
// Files nearly every commit touches for bookkeeping; they say nothing about where the work is.
const BOOKKEEPING = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|go\.mod|poetry\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|package\.json|(README|CHANGELOG|CHANGES|HISTORY|LICENSE|COPYING)(\.(md|txt|rst|markdown))?|\.gitignore)$/i;

for (const c of commits) {
  hours[c.hour]++;
  days[c.dow]++;
  dayset.add(c.day);
  dayCounts.set(c.day, (dayCounts.get(c.day) || 0) + 1);
  authors.set(c.name, (authors.get(c.name) || 0) + 1);
  if (c.hour < 5) {
    if (!lateNight || c.hour * 60 + c.minute > lateNight.hour * 60 + lateNight.minute) lateNight = c;
  }
  if (c.hour < 5) night++;
  else if (c.hour < 8) dawn++;
  if (c.hour >= 9 && c.hour < 18 && c.dow <= 5) office++;
  if (c.dow >= 6) weekend++;
  if (c.dow === 5 && c.hour >= 16) friLate++;
  const s = c.subject.trim();
  const sl = s.toLowerCase();
  if (/\b(fix|fixes|fixed|bug|hotfix|patch|oops)\b/.test(sl)) fixes++;
  if (/\b(wip|tmp|temp|todo|stuff|things|asdf)\b/.test(sl)) wips++;
  if (/^revert/.test(sl)) reverts++;
  if (s.split(/\s+/).length <= 1) oneWord++;
  if (SWEAR.test(s)) swears++;
  if (EMOJI.test(s)) emojis++;
  if (CONVENTIONAL.test(s)) conventional++;
  if (s) repeats.set(sl, [repeats.get(sl)?.[0] || s, (repeats.get(sl)?.[1] || 0) + 1]); // keep the user's own casing
  msgLen += s.length;
  const fw = sl.split(/[\s:(]/)[0];
  if (fw) firstWords.set(fw, (firstWords.get(fw) || 0) + 1);
  totalAdd += c.add; totalDel += c.del;
  if (c.add + c.del > biggest.add + biggest.del) biggest = c;
  if (s && s.length < shortest.subject.trim().length) shortest = c;
  for (const f of c.files) {
    const ext = (f.file.match(/\.([a-z0-9]+)"?$/i) || [])[1];
    const lang = ext && EXT_LANG[ext.toLowerCase()];
    if (lang) langs.set(lang, (langs.get(lang) || 0) + f.a + f.d);
    churn.set(f.file, (churn.get(f.file) || 0) + 1);
  }
}

// streak: longest run of consecutive days with commits.
// gap: longest silence with real work on both sides, so one stray commit (or a bogus 1970 import date) doesn't count.
const sortedDays = [...dayset].sort();
let streak = 1, best = 1, bestEnd = sortedDays[0];
let maxGap = 0, gapEnd = null, before = 0;
for (let i = 1; i < sortedDays.length; i++) {
  const gap = Math.round((Date.parse(sortedDays[i]) - Date.parse(sortedDays[i - 1])) / 864e5);
  before += dayCounts.get(sortedDays[i - 1]);
  streak = gap === 1 ? streak + 1 : 1;
  if (streak > best) { best = streak; bestEnd = sortedDays[i]; }
  if (gap > maxGap && before >= 5 && n - before >= 5) { maxGap = gap; gapEnd = sortedDays[i]; }
}

const top = (map, k) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
const peakHour = hours.indexOf(Math.max(...hours));
const DOW = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const peakDay = DOW[days.indexOf(Math.max(...days.slice(1)))];
const avgSize = Math.round((totalAdd + totalDel) / n);
const avgMsg = Math.round(msgLen / n);
const langTotal = [...langs.values()].reduce((a, b) => a + b, 0) || 1;
const topLangs = top(langs, 4).map(([l, v]) => [l, Math.round((v / langTotal) * 100)]);
const firstDay = sortedDays[0], lastDay = sortedDays[sortedDays.length - 1];
const spanDays = Math.max(1, Math.round((Date.parse(lastDay) - Date.parse(firstDay)) / 864e5) + 1);
const topAuthorPct = pct(top(authors, 1)[0][1]);
const top2DaysPct = pct([...dayCounts.values()].sort((a, b) => b - a).slice(0, 2).reduce((a, b) => a + b, 0));
const [mainFile, mainFileTouches] = top(new Map([...churn].filter(([f]) => !BOOKKEEPING.test(f))), 1)[0] || [null, 0];
const [repeatMsg, repeatCount] = [...repeats.values()].sort((a, b) => b[1] - a[1])[0] || [null, 0];

let repoName = path.basename(repoDir);
try {
  const url = git(repoDir, 'config', '--get', 'remote.origin.url').trim();
  // Only hosted remotes (https://host/owner/repo or git@host:owner/repo) carry a useful owner/repo name.
  const m = url.match(/^(?:[a-z+]+:\/\/[^/]+\/|[^@/]+@[^:/]+:)(?:.*\/)?([^/]+\/[^/]+?)(?:\.git)?\/?$/i);
  if (m && !/^file:/i.test(url)) repoName = m[1];
} catch { /* no remote */ }

let myName = '';
try { myName = git(repoDir, 'config', 'user.name').trim(); } catch { /* not set */ }
const authorLabel = flag('--me') ? myName || authorFilter : authorFilter;
const shallow = shallowRoots.size > 0;

const stats = {
  repo: repoName, author: authorFilter || null, shallow, commits: n, authors: authors.size,
  firstDay, lastDay, activeDays: dayset.size, longestStreak: best, streakEnded: bestEnd,
  linesAdded: totalAdd, linesDeleted: totalDel, avgCommitSize: avgSize, avgMessageLength: avgMsg,
  peakHour, peakDay, hours, weekdays: days.slice(1),
  nightOwlPct: pct(night), dawnPct: pct(dawn), officeHoursPct: pct(office), weekendPct: pct(weekend),
  fridayEveningPct: pct(friLate), fixPct: pct(fixes), wipPct: pct(wips), oneWordPct: pct(oneWord),
  reverts, swears, emojiPct: pct(emojis), conventionalPct: pct(conventional),
  topAuthorPct, top2DaysPct, longestGapDays: maxGap, gapEndedOn: gapEnd,
  mainFile, mainFilePct: pct(mainFileTouches),
  lateNightCommit: lateNight ? { hash: lateNight.hash.slice(0, 7), time: `${lateNight.hour}:${String(lateNight.minute).padStart(2, '0')}`, day: lateNight.day, subject: lateNight.subject.trim() } : null,
  onRepeat: repeatCount >= 3 ? { message: repeatMsg, times: repeatCount } : null,
  topLanguages: topLangs, mostTouchedFiles: top(churn, 3),
  favoriteOpener: top(firstWords, 1)[0]?.[0] || null,
  biggestCommit: { hash: biggest.hash.slice(0, 7), lines: biggest.add + biggest.del, subject: biggest.subject },
  shortestMessage: shortest.subject.trim(),
  topAuthors: top(authors, 3),
};

// ---------- archetype ----------
// Each archetype scores how far past its threshold the repo is; the highest wins.

const ARCHETYPES = [
  { id: 'owl', emoji: '🦉', name: 'The Night Owl', score: stats.nightOwlPct / 15,
    blurb: `${stats.nightOwlPct}% of commits land between midnight and 5am.`,
    roast: 'Your best ideas arrive right after your worst decisions.' },
  { id: 'dawn', emoji: '🌅', name: 'The Dawn Patrol', score: stats.dawnPct / 12,
    blurb: `${stats.dawnPct}% of commits happen before 8am.`,
    roast: 'Shipping before the coffee machine has finished booting.' },
  { id: 'weekend', emoji: '⚔️', name: 'The Weekend Warrior', score: stats.weekendPct / 25,
    blurb: `${stats.weekendPct}% of commits are on Saturday or Sunday.`,
    roast: 'Touching grass is on the roadmap. Next quarter. Probably.' },
  { id: 'fire', emoji: '🧯', name: 'The Firefighter', score: stats.fixPct / 30,
    blurb: `${stats.fixPct}% of commit messages are fixes.`,
    roast: 'You don\'t write features. You write sequels to bugs.' },
  { id: 'friday', emoji: '🎲', name: 'The Friday Deployer', score: stats.fridayEveningPct / 10,
    blurb: `${stats.fridayEveningPct}% of commits ship after 4pm on a Friday.`,
    roast: 'Your on-call rotation has filed a restraining order.' },
  { id: 'mono', emoji: '🧱', name: 'The Monolith Mover', score: avgSize / 350,
    blurb: `The average commit touches ${avgSize.toLocaleString()} lines.`,
    roast: 'Code review is less "review" and more "hostage negotiation".' },
  { id: 'surgeon', emoji: '🔬', name: 'The Surgeon', score: n >= 30 && avgSize > 0 ? 18 / avgSize : 0,
    blurb: `Tiny, precise commits: ${avgSize} line${avgSize === 1 ? '' : 's'} on average.`,
    roast: 'Your PRs get approved before the page finishes loading.' },
  { id: 'novel', emoji: '📜', name: 'The Novelist', score: avgMsg / 60,
    blurb: `Commit messages average ${avgMsg} characters.`,
    roast: 'Your commit log has chapters and a foreword.' },
  { id: 'ninja', emoji: '🥷', name: 'The Silent Committer', score: stats.oneWordPct / 20,
    blurb: `${stats.oneWordPct}% of commit messages are a single word.`,
    roast: 'Update what? Nobody will ever know.' },
  { id: 'streak', emoji: '🔥', name: 'The Streak Machine', score: best / 21,
    blurb: `Longest streak: ${best} days in a row.`,
    roast: 'Rest days are a rumor to your contribution graph.' },
  { id: 'nine', emoji: '☕', name: 'The 9-to-5 Professional', score: stats.officeHoursPct / 90,
    blurb: `${stats.officeHoursPct}% of commits land during office hours.`,
    roast: 'Healthy boundaries. Your therapist is very proud.' },
  { id: 'emoji', emoji: '🎉', name: 'The Emoji Enthusiast', score: n >= 20 ? stats.emojiPct / 12 : 0,
    blurb: `${stats.emojiPct}% of commit messages have an emoji in them.`,
    roast: 'Your commit history has better emoji game than your group chat.' },
  { id: 'conv', emoji: '📋', name: 'The Conventionalist', score: n >= 20 ? stats.conventionalPct / 60 : 0,
    blurb: `${stats.conventionalPct}% of commits start with feat:, fix: and friends.`,
    roast: 'feat: add personality. fix: remove personality.' },
  { id: 'committee', emoji: '🏛️', name: 'The Committee', score: authors.size >= 8 && topAuthorPct <= 60 ? Math.min(authors.size / 12, 2) : 0,
    blurb: `${authors.size.toLocaleString('en-US')} authors, and the top one wrote just ${topAuthorPct}%.`,
    roast: 'Everyone owns this repo, which means nobody does.' },
  { id: 'comeback', emoji: '🧟', name: 'The Comeback Kid', score: maxGap >= 60 ? Math.min(maxGap / 90, 1.6) : 0, // capped: a year off shouldn't drown out real habits
    blurb: `Went quiet for ${maxGap.toLocaleString('en-US')} days, then came back.`,
    roast: 'Ghosted your own repo, then came back like nothing happened.' },
  { id: 'crammer', emoji: '⏰', name: 'The Deadline Crammer', score: n >= 15 && dayset.size >= 10 && spanDays >= 14 ? top2DaysPct / 50 : 0, // 10+ days: steady work can't reach 50% on 2 of them
    blurb: `${top2DaysPct}% of all commits happened on just 2 days.`,
    roast: 'Weeks of nothing, then one heroic night before the deadline.' },
  { id: 'rage', emoji: '🤬', name: 'The Rage Committer', score: swears >= 3 ? pct(swears) / 4 : 0,
    blurb: `${swears} commit messages contain a swear word.`,
    roast: 'Your git log is rated R.' },
  { id: 'onefile', emoji: '🗿', name: 'The One-File Wonder', score: n >= 20 && mainFile ? stats.mainFilePct / 60 : 0,
    blurb: `${stats.mainFilePct}% of commits touch ${(mainFile || '').split('/').pop()}.`,
    roast: 'Who needs architecture when you have one very large file?' },
];
const ranked = ARCHETYPES.slice().sort((a, b) => b.score - a.score);
// Nothing stands out: that is a personality too.
// Too few commits to say anything honest, or nothing stands out.
const MIN_COMMITS = 10;
const archetype = n < MIN_COMMITS ? {
  emoji: '🥚', name: 'The Hatchling',
  blurb: `Only ${n} commit${n === 1 ? '' : 's'} so far. Not enough to read yet.`,
  roast: `Come back after ${MIN_COMMITS} commits. The DNA is still forming.`,
} : ranked[0].score >= 0.8 ? ranked[0] : {
  emoji: '🧘', name: 'The Steady Hand',
  blurb: 'No extreme habits. Just sane, steady commits.',
  roast: 'No bad habits detected. Highly suspicious.',
};
// Runner-up traits have to clear the same bar as the winner.
const traits = n < MIN_COMMITS ? [] : ranked.filter((t) => t !== archetype && t.score >= 0.8).slice(0, 2);
stats.archetype = { name: archetype.name, emoji: archetype.emoji, blurb: archetype.blurb, roast: archetype.roast };
stats.traits = traits.map((t) => t.name);
// One line people can paste into a comment or a post. "me" only when these are your own commits.
const sole = authors.size === 1 ? [...authors.keys()][0] : null;
const who = flag('--me') || (sole && sole === myName) ? 'me' : authorFilter && sole ? sole : 'this repo';
stats.share = n < MIN_COMMITS ? null : `git-dna called ${who} ${archetype.name} ${archetype.emoji} “${archetype.roast}” Try yours: npx git-dna`;

if (flag('--json')) {
  console.log(JSON.stringify(stats, null, 2));
  process.exit(0);
}

// ---------- terminal report ----------

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = paint('1'), dim = paint('2'), cyan = paint('36'), magenta = paint('35'), yellow = paint('33'), green = paint('32');
const BARS = ' ▁▂▃▄▅▆▇█';
const spark = (arr) => {
  const max = Math.max(...arr) || 1;
  return arr.map((v) => BARS[Math.round((v / max) * 8)]).join('');
};
const fmt = (x) => x.toLocaleString('en-US');
const plural = (k, word, many = word + 's') => `${fmt(k)} ${k === 1 ? word : many}`;
const hr12 = (h) => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;

const out = [];
out.push('');
out.push(`  ${magenta('🧬 git-dna')}  ${dim(stats.repo + (authorLabel ? `  ·  ${authorLabel}` : ''))}`);
if (shallow) out.push(`  ${yellow('!')} ${dim('shallow clone: only the fetched history is counted')}`);
out.push('');
out.push(`  ${archetype.emoji}  ${bold(archetype.name.toUpperCase())}`);
out.push(`     ${archetype.blurb}`);
out.push(`     ${yellow('“' + archetype.roast + '”')}`);
if (traits.length) out.push(`     ${dim('also: ' + traits.map((t) => `${t.emoji} ${t.name}`).join('  ·  '))}`);
out.push('');
out.push(`  ${cyan('commits')}      ${bold(fmt(n))} over ${plural(spanDays, 'day')} by ${plural(authors.size, 'author')}`);
out.push(`  ${cyan('lines')}        ${green('+' + fmt(totalAdd))} ${paint('31')('-' + fmt(totalDel))}`);
out.push(`  ${cyan('streak')}       ${bold(plural(best, 'day'))} in a row ${dim('(ended ' + bestEnd + ')')}`);
out.push(`  ${cyan('peak')}         ${peakDay}s around ${hr12(peakHour)}`);
out.push('');
out.push(`  ${cyan('by hour')}      ${spark(hours)}`);
out.push(`               ${dim('12am  6am   12pm  6pm')}`);
out.push(`  ${cyan('by weekday')}   ${spark(days.slice(1))}`);
out.push(`               ${dim('MTWTFSS')}`);
out.push('');
if (topLangs.length) out.push(`  ${cyan('languages')}    ${topLangs.map(([l, p]) => `${l} ${p}%`).join(dim('  ·  '))}`);
out.push(`  ${cyan('fixes')}        ${stats.fixPct}% of commits   ${dim(plural(reverts, 'revert') + '  ·  ' + plural(swears, 'swear'))}`);
out.push(`  ${cyan('biggest')}      ${plural(stats.biggestCommit.lines, 'line')} in ${stats.biggestCommit.hash} ${dim('"' + trunc(biggest.subject, 40) + '"')}`);
out.push(`  ${cyan('shortest')}     ${dim('"')}${stats.shortestMessage}${dim('"')}`);
if (stats.favoriteOpener) out.push(`  ${cyan('first word')}   ${dim('"')}${stats.favoriteOpener}${dim('"')} ${dim('starts ' + plural(top(firstWords, 1)[0][1], 'commit message'))}`);
if (lateNight) out.push(`  ${cyan('still up')}     ${bold(`${lateNight.hour % 12 || 12}:${String(lateNight.minute).padStart(2, '0')}am`)} ${dim(DOW[lateNight.dow].slice(0, 3) + ' ' + lateNight.day)} ${dim('"')}${trunc(lateNight.subject.trim() || '(no message)', 44)}${dim('"')}`);
if (stats.onRepeat) out.push(`  ${cyan('on repeat')}    ${dim('"')}${trunc(stats.onRepeat.message, 40)}${dim('"')} ${bold('×' + fmt(stats.onRepeat.times))}`);

function trunc(s, k) {
  const cp = [...s]; // by code point, so an emoji is never cut in half
  return cp.length > k ? cp.slice(0, k - 1).join('') + '…' : s;
}

// ---------- SVG card ----------

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

// FNV-1a hash of the repo name: each repo gets its own stable helix colors.
function hashSeed(str) {
  let h = 2166136261;
  for (const ch of str) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function helix(x0, y0, w, h) {
  // Rungs walk the 24-hour clock left to right; brighter rungs are busier hours.
  const seed = hashSeed(stats.repo + n);
  const hue0 = seed % 360;
  const rungs = 48;
  const max = Math.max(...hours) || 1;
  let s = '';
  const strandA = [], strandB = [];
  for (let i = 0; i <= 160; i++) {
    const t = i / 160;
    const x = x0 + t * w;
    const ph = t * Math.PI * 4;
    strandA.push(`${x.toFixed(1)},${(y0 + h / 2 + Math.sin(ph) * h / 2).toFixed(1)}`);
    strandB.push(`${x.toFixed(1)},${(y0 + h / 2 - Math.sin(ph) * h / 2).toFixed(1)}`);
  }
  for (let i = 0; i < rungs; i++) {
    const t = (i + 0.5) / rungs;
    const x = x0 + t * w;
    const ph = t * Math.PI * 4;
    const ya = y0 + h / 2 + Math.sin(ph) * h / 2;
    const yb = y0 + h / 2 - Math.sin(ph) * h / 2;
    const v = hours[Math.floor((i / rungs) * 24)] / max;
    const hue = (hue0 + v * 140) % 360;
    const op = (0.25 + v * 0.75).toFixed(2);
    s += `<line x1="${x.toFixed(1)}" y1="${ya.toFixed(1)}" x2="${x.toFixed(1)}" y2="${yb.toFixed(1)}" stroke="hsl(${hue.toFixed(0)},85%,62%)" stroke-width="5" stroke-linecap="round" opacity="${op}"/>`;
  }
  s += `<polyline points="${strandA.join(' ')}" fill="none" stroke="url(#strand)" stroke-width="4"/>`;
  s += `<polyline points="${strandB.join(' ')}" fill="none" stroke="url(#strand)" stroke-width="4" opacity="0.7"/>`;
  return { svg: s, hue: hue0 };
}

function card() {
  const W = 1200, H = 630;
  const hx = helix(60, 470, 1080, 90);
  const accent = `hsl(${hx.hue},90%,66%)`;
  const max = Math.max(...hours) || 1;
  let bars = '';
  hours.forEach((v, i) => {
    const bh = Math.max(2, (v / max) * 110);
    bars += `<rect x="${760 + i * 16}" y="${330 - bh}" width="11" height="${bh}" rx="3" fill="${accent}" opacity="${(0.35 + 0.65 * v / max).toFixed(2)}"/>`;
  });
  const stat = (x, y, label, value) =>
    `<text x="${x}" y="${y}" class="lbl">${esc(label)}</text><text x="${x}" y="${y + 40}" class="val">${esc(value)}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0b0f1a"/><stop offset="1" stop-color="#151a2e"/></linearGradient>
  <linearGradient id="strand" x1="0" x2="1"><stop offset="0" stop-color="${accent}"/><stop offset="1" stop-color="hsl(${(hx.hue + 140) % 360},90%,66%)"/></linearGradient>
  <style>
    text{font-family:ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;fill:#e7eaf3}
    .lbl{font-size:18px;fill:#8a93ad;letter-spacing:1.5px;text-transform:uppercase}
    .val{font-size:34px;font-weight:700}
    .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  </style>
</defs>
<rect width="${W}" height="${H}" rx="28" fill="url(#bg)"/>
<text x="60" y="78" class="mono" font-size="22" fill="#8a93ad">🧬 git-dna  ·  ${esc(trunc(stats.repo, 48))}</text>
<text x="60" y="160" font-size="64" font-weight="800">${archetype.emoji} ${esc(archetype.name)}</text>
<text x="60" y="210" font-size="26" fill="#c5cbe0">${esc(trunc(archetype.blurb, 52))}</text>
<text x="60" y="252" font-size="${Math.min(24, Math.floor(1150 / (archetype.roast.length + 2)))}" font-style="italic" fill="${accent}">“${esc(archetype.roast)}”</text>
${stat(60, 320, 'commits', fmt(n))}
${stat(260, 320, 'streak', plural(best, 'day'))}
${stat(460, 320, 'peak', hr12(peakHour) + ' ' + peakDay.slice(0, 3))}
${stat(60, 410, 'fixes', stats.fixPct + '%')}
${stat(260, 410, 'night owl', stats.nightOwlPct + '%')}
${stat(460, 410, 'weekends', stats.weekendPct + '%')}
<text x="760" y="190" class="lbl">commits by hour</text>
${bars}
${['12am', '6am', '12pm', '6pm'].map((l, i) => `<text x="${760 + i * 96}" y="356" class="mono" font-size="15" fill="#5d6680">${l}</text>`).join('')}
${traits.length ? '<text x="760" y="398" class="lbl">also</text>' : ''}
${traits.map((t, i) => `<text x="760" y="${430 + i * 30}" font-size="22" fill="#c5cbe0">${t.emoji} ${esc(t.name)}</text>`).join('')}
${hx.svg}
<text x="${W - 60}" y="${H - 20}" text-anchor="end" class="mono" font-size="18" fill="#5d6680">npx git-dna</text>
</svg>
`;
}

// ---------- PNG ----------
// LinkedIn, X and most chats won't take an SVG upload, so the card is also saved as a PNG.
// git-dna has no dependencies, so it borrows a Chromium-based browser that is already installed,
// runs it headless on a throwaway profile with background networking off, and screenshots the SVG.

function findBrowser() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const pf = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
  const candidates = process.platform === 'win32'
    ? pf.flatMap((d) => [
      path.join(d, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(d, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(d, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      path.join(d, 'Chromium', 'Application', 'chrome.exe'),
    ])
    : process.platform === 'darwin'
      ? ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium', 'Arc']
        .map((app) => `/Applications/${app}.app/Contents/MacOS/${app}`)
      : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']
        .flatMap((bin) => (process.env.PATH || '').split(path.delimiter).map((dir) => path.join(dir, bin)));
  return candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

function svgToPng(svgFile, pngFile) {
  const browser = findBrowser();
  if (!browser) return false;
  const profile = fs.mkdtempSync(path.join(require('os').tmpdir(), 'git-dna-'));
  try { fs.rmSync(pngFile, { force: true }); } catch { /* not there yet */ }
  try {
    execFileSync(browser, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--disable-background-networking', '--disable-component-update', '--disable-sync',
      '--disable-default-apps', `--user-data-dir=${profile}`, '--window-size=1200,630',
      '--default-background-color=00000000', `--screenshot=${pngFile}`, require('url').pathToFileURL(svgFile).href,
    ], { stdio: 'ignore', timeout: 30000 });
  } catch { /* checked below */ } finally {
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* temp dir */ }
  }
  try { return fs.statSync(pngFile).size > 0; } catch { return false; }
}

// Pop the PNG open and put it on the clipboard, so it can go straight into a post with a paste.
// Both are best effort: if the OS has no viewer or clipboard tool, the file path is still printed.
function copyImage(pngFile) {
  const { spawnSync } = require('child_process');
  const quiet = { stdio: 'ignore', timeout: 15000 };
  try {
    if (process.platform === 'win32') {
      const p = pngFile.replace(/'/g, "''");
      return spawnSync('powershell', ['-NoProfile', '-STA', '-Command',
        `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; [System.Windows.Forms.Clipboard]::SetImage([System.Drawing.Image]::FromFile('${p}'))`], quiet).status === 0;
    }
    if (process.platform === 'darwin') {
      return spawnSync('osascript', ['-e', `set the clipboard to (read (POSIX file "${pngFile.replace(/"/g, '\\"')}") as «class PNGf»)`], quiet).status === 0;
    }
    if (spawnSync('wl-copy', ['--type', 'image/png'], { ...quiet, input: fs.readFileSync(pngFile), stdio: ['pipe', 'ignore', 'ignore'] }).status === 0) return true;
    return spawnSync('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-i', pngFile], quiet).status === 0;
  } catch { return false; }
}

function openFile(file) {
  const { spawn } = require('child_process');
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', file]]
    : process.platform === 'darwin' ? ['open', [file]] : ['xdg-open', [file]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref(); } catch { /* no viewer */ }
}

const interactive = process.stdout.isTTY && !process.env.CI && !flag('--no-open');

if (!flag('--no-card')) {
  const file = path.resolve(opt('--out') || 'git-dna.svg');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, card());
  const rel = (f) => path.relative(process.cwd(), f) || f;
  out.push('');
  out.push(`  ${green('✔')} card saved → ${bold(rel(file))}`);
  if (!flag('--no-png')) {
    const png = file.replace(/\.svg$/i, '') + '.png';
    if (process.stderr.isTTY) process.stderr.write('  making the PNG…\r');
    const ok = svgToPng(file, png);
    if (process.stderr.isTTY) process.stderr.write('                 \r');
    out.push(ok
      ? `  ${green('✔')} PNG saved  → ${bold(rel(png))}  ${dim('(post this one)')}`
      : `  ${dim('PNG skipped: needs Chrome, Edge or Brave installed (or CHROME_PATH). The SVG still works in a README.')}`);
    if (ok && interactive) {
      const copied = copyImage(png);
      openFile(png);
      out.push(`  ${green('✔')} opened it for you${copied ? `, and it's on your clipboard: ${bold(process.platform === 'darwin' ? '⌘V' : 'Ctrl+V')} it into a post` : ''}`);
    }
  }
  out.push(`    ${dim('drop it in your README:')} ![git-dna](./${path.basename(file)})`);
}
if (stats.share) {
  out.push('');
  out.push(`  ${magenta('share')}  ${stats.share}`);
}
if (!authorFilter && authors.size > 1) {
  out.push('');
  out.push(`  ${dim('tip: this counts all ' + plural(authors.size, 'author') + '. Add --me for just your own commits.')}`);
}
out.push('');
console.log(out.join('\n'));
