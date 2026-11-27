// Reports Kriolu vocabulary and example sentences that have no English:
//   node tools/check-translations.js          (summary by level)
//   node tools/check-translations.js B1x      (also lists the untranslated sentences of one group; "x" = optional lessons)
// A sentence is translated when the item has exE, or the sentence is a key of COURSE_PARTS.kriolu.EX_TRANS
// (the same lookup the app uses, see exTranslation in index.html). Alphabet cards carry their gloss inline.
const fs = require('fs'), vm = require('vm'), path = require('path');
const ctx = vm.createContext({ window: {} });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'data', 'kriolu.js'), 'utf8') + ';this.X={L:KR_LESSONS,P:KR_LEARNING_PATH,T:window.COURSE_PARTS.kriolu.EX_TRANS}', ctx);
const { L, P, T } = ctx.X, group = {}, idx = {};
Object.keys(T).forEach(k => { idx[k.trim().normalize('NFC')] = T[k]; });
P.forEach(u => u.lessons.forEach(id => { group[id] = u.level + (u.track === 'extra' ? 'x' : ''); }));
const tot = {}, noE = {}, noEx = {}, list = [];
L.forEach(l => l.vocab.forEach(v => {
  const g = group[l.id] || '?'; tot[g] = (tot[g] || 0) + 1;
  if (!String(v.e || '').trim()) noE[g] = (noE[g] || 0) + 1;
  if (l.id === 'alphabet' || !v.ex) return;
  if (!(v.exE || idx[v.ex.trim().normalize('NFC')])) { noEx[g] = (noEx[g] || 0) + 1; list.push([g, l.id, v.ex]); }
}));
console.log('group  words  word-without-meaning  sentence-without-translation');
Object.keys(tot).sort().forEach(g => console.log(g.padEnd(6), String(tot[g]).padStart(5), String(noE[g] || 0).padStart(12), String(noEx[g] || 0).padStart(22)));
console.log('total untranslated sentences:', list.length);
if (process.argv[2]) list.filter(x => x[0] === process.argv[2]).forEach(x => console.log(x[1] + ' | ' + x[2]));
