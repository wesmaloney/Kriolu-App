// Checks the per-lesson conversations in data/kriolu.js (KR_LESSON_DIALOGUES):
//   node tools/check-lesson-dialogues.js
// Every Kriolu word in a conversation, and in its wrong replies, must be taught by that lesson or an earlier
// required lesson (the same rule the app uses, see teachTokens/taughtIndex in index.html). Names of the speakers
// and a few place names are allowed. Each reply must name vocabulary items that really are in the lesson.
const fs = require('fs'), vm = require('vm'), path = require('path');
const ctx = vm.createContext({ window: {} });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'data', 'kriolu.js'), 'utf8') + ';this.X={L:KR_LESSONS,P:KR_LEARNING_PATH,D:typeof KR_LESSON_DIALOGUES!=="undefined"?KR_LESSON_DIALOGUES:{}}', ctx);
const { L, P, D } = ctx.X;
const PLACES = new Set(['praia', 'mindelo', 'santiago', 'kabu', 'verdi', 'lisboa', 'boston', 'fogu']);
const tokens = text => { const out = []; String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/(\p{L}+)\/a\b/gu, (m, w) => w + ' ' + (/[uo]$/.test(w) ? w.slice(0, -1) + 'a' : w + 'a'))
  .replace(/[\p{L}\d]+(?:[-'’][\p{L}]+)*/gu, t => { out.push(t); return t; }); return out; };
const byId = new Map(L.map(l => [l.id, l]));
const order = P.filter(u => u.track !== 'extra').flatMap(u => u.lessons);
const first = new Map();
order.forEach((id, i) => byId.get(id).vocab.forEach(v => tokens(v.k + ' ' + (v.full || '')).forEach(t => [t, ...t.split(/[-'’]/)].forEach(p => { if (p && !first.has(p)) first.set(p, i); }))));
let problems = 0, scenes = 0, asks = 0, covered = 0;
const bad = (id, msg) => { problems++; console.log('✗ ' + id + ': ' + msg); };
Object.entries(D).forEach(([id, list]) => {
  const lesson = byId.get(id), r = order.indexOf(id);
  if (!lesson || r < 0) return bad(id, 'not a required lesson');
  const keys = new Set(lesson.vocab.map(v => v.k));
  const used = new Set();
  list.forEach((d, n) => {
    scenes++;
    const names = new Set(d.lines.flatMap(l => tokens(l.sp)));
    const known = t => names.has(t) || PLACES.has(t) || /^\d+$/.test(t) || (first.has(t) && first.get(t) <= r);
    const check = (text, where) => tokens(text).forEach(t => { if (!(known(t) || t.split(/[-'’]/).every(p => !p || known(p)))) bad(id, `"${t}" is not taught yet (${where}: ${text})`); });
    if (!d.scene) bad(id, 'scene ' + (n + 1) + ' has no setting');
    d.lines.forEach((l, i) => { if (!l.sp || !l.k || !l.e) bad(id, 'line ' + i + ' incomplete'); check(l.k, 'line ' + i); });
    (d.ask || []).forEach(a => {
      asks++;
      const line = d.lines[a.i];
      if (!line || a.i < 1) return bad(id, 'reply index ' + a.i + ' is not a reply');
      if (!a.wrong || a.wrong.length !== 2) bad(id, 'reply ' + a.i + ' needs exactly two wrong replies');
      (a.wrong || []).forEach(w => { check(w, 'wrong reply'); if (w === line.k) bad(id, 'a wrong reply equals the right one'); });
      if (!a.for || !a.for.length) bad(id, 'reply ' + a.i + ' practises no vocabulary');
      (a.for || []).forEach(k => { if (!keys.has(k)) bad(id, `"${k}" is not a vocabulary item of this lesson`); else used.add(k);
        const need = tokens(k).filter(t => t.length >= 3 && !['kel', 'ten', 'sta', 'ki'].includes(t)), have = new Set(d.lines.slice(0, a.i + 1).flatMap(l => tokens(l.k)));   // in the reply, or in what leads up to it
        if (need.length && !need.some(t => have.has(t))) bad(id, `the exchange ending "${line.k}" does not use "${k}"`); });
    });
  });
  covered += used.size;
});
console.log(`${Object.keys(D).length} lessons, ${scenes} scenes, ${asks} replies, ${covered} vocabulary items practised; ${problems} problem(s)`);
process.exit(problems ? 1 : 0);
