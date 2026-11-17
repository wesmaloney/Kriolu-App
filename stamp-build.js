// Keeps the running-build label in index.html equal to the service worker's cache
// version, so there is ONE number to bump (CACHE_NAME in sw.js). Runs on every
// Netlify build (see netlify.toml) and can be run by hand: node stamp-build.js
const fs = require('fs');
const sw = fs.readFileSync('sw.js', 'utf8');
const m = sw.match(/CACHE_NAME\s*=\s*'kriolu-(v\d+)'/);
if (!m) { console.error('stamp-build: no CACHE_NAME found in sw.js'); process.exit(1); }
let html = fs.readFileSync('index.html', 'utf8');
const re = /const APP_BUILD = '[^']*';/;
if (!re.test(html)) { console.error('stamp-build: no APP_BUILD found in index.html'); process.exit(1); }
const next = html.replace(re, `const APP_BUILD = '${m[1]}';`);
if (next !== html) { fs.writeFileSync('index.html', next); console.log('stamp-build: index.html is now ' + m[1]); }
else console.log('stamp-build: already ' + m[1]);
