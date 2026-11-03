// huddle/plugin/scripts/engine.mjs — ADVISOR 2026-11-03 — the model / effort a person chose for this agent in Huddle, applied on THEIR machine.
// Kfir 3.11: «שינוי מודל, שינוי מאמץ חשיבה … זמינות לכולם» · «זה לא צריך להיות תלוי במחשב שלי» · «שיהיה בהגדרות של האדל, ושיהיה דלוק בדיפולט».
// The person picks it on their Huddle page; each turn the Stop hook's status report brings back { want, apply } (apply = their «engineControl»
// setting, on by default). This writes `model` / `effortLevel` into the project's .claude/settings.local.json - Claude Code reads both at
// SESSION START, so the choice runs from the next session. Only the two keys Huddle set are ever touched: every other key stays, and when
// the choice is cleared or the setting is off, a key goes back to the user's own earlier value (or away) - only if it still holds what Huddle wrote.
// wired: scripts/mirror.mjs run() · test: test/engine.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = () => process.env.HUDDLE_HOME || path.join(os.homedir(), '.huddle');
const ledgerFile = () => path.join(HOME(), 'engine-applied.json');
const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return e.code === 'ENOENT' ? dflt : undefined; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, `${JSON.stringify(v, null, 2)}\n`); fs.renameSync(t, f); };

/** Apply (or withdraw) the person's choice for the project at `cwd`. → { changed, wrote?, removed?, skipped? } */
export function applyEngine(cwd, { want = null, apply = true } = {}) {
  if (!cwd) return { changed: false, skipped: 'no project' };
  const file = path.join(cwd, '.claude', 'settings.local.json');
  const cur = readJson(file, {});
  if (cur === undefined || typeof cur !== 'object' || Array.isArray(cur)) return { changed: false, skipped: 'settings.local.json is not JSON - left as it is' };
  const ledger = readJson(ledgerFile(), {}) || {}, mine = { ...(ledger[file] || {}) }, before = JSON.stringify(ledger[file] || {});
  const target = apply && want ? { model: want.model || null, effortLevel: want.effort || null } : { model: null, effortLevel: null };
  const next = { ...cur }, wrote = {}, removed = [];
  for (const key of ['model', 'effortLevel']) {
    const v = target[key];
    const prior = `prior:${key}`;
    if (v) { if (mine[key] === undefined && next[key] !== undefined && next[key] !== v) mine[prior] = next[key]; if (next[key] !== v) { next[key] = v; wrote[key] = v; } mine[key] = v; }   // the user's own value is kept, to give back
    else if (mine[key] !== undefined) { if (next[key] === mine[key]) { if (mine[prior] !== undefined) next[key] = mine[prior]; else delete next[key]; removed.push(key); } delete mine[key]; delete mine[prior]; }   // only what Huddle wrote, if unchanged since
  }
  const changed = Object.keys(wrote).length > 0 || removed.length > 0;
  if (changed) writeJson(file, next);
  if (JSON.stringify(mine) !== before) { if (Object.keys(mine).length) ledger[file] = mine; else delete ledger[file]; writeJson(ledgerFile(), ledger); }   // a quiet turn writes nothing
  return { changed, ...(Object.keys(wrote).length ? { wrote } : {}), ...(removed.length ? { removed } : {}) };
}
