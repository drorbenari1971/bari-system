// Builds the in-browser demo and publishes it to the gh-pages branch (the branch GitHub Pages serves).
// Run from the frontend folder: npm run deploy:pages
import { execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const out = path.resolve('dist-pages');
const git = (args, cwd = process.cwd()) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const remote = git(['remote', 'get-url', 'origin']);
const name = git(['config', 'user.name']);
const email = git(['config', 'user.email']);

execSync('npm run build:pages', { stdio: 'inherit' });

// 404.html lets direct links such as /bari-system/calendar load the app; .nojekyll serves files as they are.
fs.copyFileSync(path.join(out, 'index.html'), path.join(out, '404.html'));
fs.writeFileSync(path.join(out, '.nojekyll'), '');

git(['init', '-q', '-b', 'gh-pages'], out);
git(['add', '-A'], out);
git(['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '-m',
  'Deploy in-browser demo to GitHub Pages\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'], out);
// The branch holds only build output, so each deploy replaces it.
git(['push', '-q', '-f', remote, 'gh-pages'], out);
fs.rmSync(path.join(out, '.git'), { recursive: true, force: true });

console.log('Published to the gh-pages branch.');
