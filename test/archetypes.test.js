'use strict';

// Builds small throwaway repos with chosen dates, messages and files, runs git-dna on each,
// and checks which archetype wins. Run with: npm test

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'git-dna.js');
const DAY = 864e5;
// 2025-01-06 is a Monday.
const MONDAY = Date.UTC(2025, 0, 6);

function at(dayOffset, hour, minute = 0) {
  const d = new Date(MONDAY + dayOffset * DAY);
  return `${d.toISOString().slice(0, 10)}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+00:00`;
}

// Every other Monday to Thursday at 7pm: not night, not dawn, not office hours, not a weekend,
// not a Friday evening, and no streak.
function weekdayEvenings(count) {
  const out = [];
  for (let d = 0; out.length < count; d += 2) {
    const dow = (d % 7) + 1; // 1=Mon
    if (dow <= 4) out.push(d);
  }
  return out;
}

function makeRepo(commits) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-dna-test-'));
  const git = (args, env = {}) => execFileSync('git', ['-C', dir, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env },
  });
  git(['init', '-q']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'commit.gpgsign', 'false']);
  commits.forEach((c, i) => {
    const files = c.files || { [`file${i}.txt`]: `line ${i}\n` };
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), content);
    }
    git(['add', '-A']);
    git(['commit', '-q', '--allow-empty', '-m', c.msg || `Update the parser for case ${i}`], {
      GIT_AUTHOR_DATE: c.date, GIT_COMMITTER_DATE: c.date,
      GIT_AUTHOR_NAME: c.author || 'Test', GIT_AUTHOR_EMAIL: `${(c.author || 'test').toLowerCase().replace(/\s+/g, '')}@example.com`,
    });
  });
  return dir;
}

function run(dir, ...args) {
  const out = execFileSync(process.execPath, [CLI, dir, '--json', '--no-card', ...args], { encoding: 'utf8' });
  return JSON.parse(out);
}

function expectArchetype(name, commits) {
  test(name, () => {
    const dir = makeRepo(commits);
    try {
      const s = run(dir);
      assert.strictEqual(s.archetype.name, name, `got ${s.archetype.name} (traits: ${s.traits.join(', ')})`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

const evenings = (count, extra = {}) => weekdayEvenings(count).map((d, i) => ({ date: at(d, 19), ...(typeof extra === 'function' ? extra(i) : extra) }));

expectArchetype('The Night Owl', weekdayEvenings(20).map((d) => ({ date: at(d, 2, 15) })));
expectArchetype('The Dawn Patrol', weekdayEvenings(20).map((d) => ({ date: at(d, 6) })));
expectArchetype('The Weekend Warrior', Array.from({ length: 20 }, (_, i) => ({ date: at(5 + i * 7, 19) })));
expectArchetype('The Firefighter', evenings(20, (i) => ({ msg: `fix crash in parser case ${i}` })));
expectArchetype('The Friday Deployer', Array.from({ length: 20 }, (_, i) => ({ date: at(4 + i * 7, 17) })));
expectArchetype('The Monolith Mover', evenings(20, (i) => ({ files: { [`big${i}.txt`]: 'x\n'.repeat(500) } })));
expectArchetype('The Surgeon', evenings(35));
expectArchetype('The Novelist', evenings(20, (i) => ({ msg: `Rework the parser so case ${i} handles nested quotes and trailing commas the same way` })));
expectArchetype('The Silent Committer', evenings(20, (i) => ({ msg: i % 2 ? 'update' : 'changes' })));
// 3pm keeps Fridays out of Friday Deployer; 40-line files keep it from reading as The Surgeon.
expectArchetype('The Streak Machine', Array.from({ length: 30 }, (_, i) => ({ date: at(i, 15), files: { [`s${i}.txt`]: 'x\n'.repeat(40) } })));
expectArchetype('The 9-to-5 Professional', weekdayEvenings(20).map((d) => ({ date: at(d, 11) })));
expectArchetype('The Emoji Enthusiast', evenings(20, (i) => ({ msg: `✨ polish the parser for case ${i}` })));
expectArchetype('The Conventionalist', evenings(20, (i) => ({ msg: `feat: parse case ${i}` })));
expectArchetype('The Committee', evenings(24, (i) => ({ author: `Person ${i % 12}` })));
expectArchetype('The Comeback Kid', [
  ...weekdayEvenings(10).map((d) => ({ date: at(d, 19) })),
  ...weekdayEvenings(10).map((d) => ({ date: at(d + 133, 19) })), // 19 weeks later, same weekdays
]);
expectArchetype('The Deadline Crammer', [
  ...weekdayEvenings(8).map((d) => ({ date: at(d, 19) })),
  ...Array.from({ length: 6 }, (_, i) => ({ date: at(30, 19, i * 5) })),
  ...Array.from({ length: 6 }, (_, i) => ({ date: at(31, 20, i * 5) })),
]);
expectArchetype('The Rage Committer', evenings(20, (i) => ({ msg: i < 5 ? `damn it, the parser broke again (${i})` : `Update the parser for case ${i}` })));
expectArchetype('The One-File Wonder', evenings(25, (i) => ({ files: { 'app.py': `print(${i})\n`.repeat(i + 1) } })));
expectArchetype('The Hatchling', evenings(5));
expectArchetype('The Steady Hand', evenings(20, (i) => ({ msg: `Update parser ${i}`, files: { [`f${i}.txt`]: 'x\n'.repeat(40) } })));

test('"callback hell" is not a swear', () => {
  const dir = makeRepo(evenings(20, (i) => ({ msg: `Get out of callback hell in module ${i}` })));
  try {
    const s = run(dir);
    assert.strictEqual(s.swears, 0);
    assert.notStrictEqual(s.archetype.name, 'The Rage Committer');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fun facts and the share line', () => {
  const commits = evenings(12, (i) => ({ msg: i < 4 ? 'WIP' : `Update the parser for case ${i}` }));
  commits.push({ date: at(40, 3, 47), msg: 'fix it for real this time' });
  const dir = makeRepo(commits);
  try {
    const s = run(dir);
    assert.deepStrictEqual(s.lateNightCommit && [s.lateNightCommit.time, s.lateNightCommit.subject], ['3:47', 'fix it for real this time']);
    assert.deepStrictEqual(s.onRepeat, { message: 'WIP', times: 4 });
    assert.match(s.share, /^git-dna called me The .+ “.+” Try yours: npx git-dna$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a shared repo is "this repo", not "me"', () => {
  const dir = makeRepo(evenings(12, (i) => ({ author: i % 2 ? 'Someone Else' : 'Test' })));
  try {
    assert.match(run(dir).share, /^git-dna called this repo /);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('steady work on a few days is not a Deadline Crammer', () => {
  const dir = makeRepo([0, 3, 7, 10, 14, 17].flatMap((d) => [0, 1, 2].map((k) => ({ date: at(d, 19, k * 10) }))));
  try {
    assert.notStrictEqual(run(dir).archetype.name, 'The Deadline Crammer');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Rust paths are not emoji, and escape codes never reach the output', () => {
  const dir = makeRepo(evenings(20, (i) => ({ msg: i % 2 ? `Use std::io::Write in module ${i}` : `\x1b]0;pwned\x07\x1b[2Jclear screen ${i}` })));
  try {
    const s = run(dir);
    assert.strictEqual(s.emojiPct, 0);
    assert.match(s.shortestMessage, /clear screen/);
    assert.ok(!/[\x00-\x1f]/.test(s.shortestMessage + s.biggestCommit.subject), 'control characters leaked');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lockfiles and READMEs do not make a One-File Wonder', () => {
  const dir = makeRepo(evenings(25, (i) => ({ files: { 'package-lock.json': `{"v":${i}}\n`, 'README.md': `v${i}\n`, [`src/m${i}.js`]: `x\n` } })));
  try {
    const s = run(dir);
    assert.notStrictEqual(s.archetype.name, 'The One-File Wonder');
    assert.ok(!/package-lock|README/.test(s.mainFile || ''), `mainFile was ${s.mainFile}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
