'use strict';
// Refuse to publish a CLI that only runs on Windows. A "\r" after the shebang makes
// macOS and Linux look for a program called "node\r", so `npx git-dna` fails there.
const fs = require('fs');
const path = require('path');

const cli = path.join(__dirname, '..', 'bin', 'git-dna.js');
const src = fs.readFileSync(cli, 'utf8');
if (src.includes('\r')) {
  console.error('bin/git-dna.js has Windows line endings. Convert it to LF before publishing.');
  process.exit(1);
}
if (!src.startsWith('#!/usr/bin/env node\n')) {
  console.error('bin/git-dna.js must start with "#!/usr/bin/env node".');
  process.exit(1);
}
console.log('bin/git-dna.js: LF line endings, shebang ok');
