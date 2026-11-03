#!/usr/bin/env node
// huddle/plugin/scripts/rules.mjs — ADVISOR 2026-11-03 — Huddle's rules back into a Claude Code session after a compaction (Kfir 3.11: «צריך
// גם אחרי קומפקציה. זה מיני-מיני-סטרטה»). Claude Code's SessionStart hook, matcher «compact»: if this session ever joined a Huddle room (its
// transcript has a join_room), the rules from huddleapp.ai/rules.json go back into its context as additionalContext. The last copy is kept
// in ~/.huddle/rules.json for when the server does not answer in 5 s. A session that never used Huddle gets nothing - it costs nothing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const URL_ = () => process.env.HUDDLE_URL || 'https://huddleapp.ai';
const CACHE = () => path.join(process.env.HUDDLE_HOME || path.join(os.homedir(), '.huddle'), 'rules.json');

/** Does the file contain the word? Read in 1 MB pieces, stopped at the first hit - a transcript can be hundreds of MB. */
export function fileHas(file, word) {
  let fd; try { fd = fs.openSync(file, 'r'); } catch { return false; }
  try {
    const buf = Buffer.alloc(1 << 20), w = Buffer.from(word); let pos = 0, carry = Buffer.alloc(0);
    for (;;) { const n = fs.readSync(fd, buf, 0, buf.length, pos); if (!n) return false; const chunk = Buffer.concat([carry, buf.subarray(0, n)]); if (chunk.includes(w)) return true; carry = chunk.subarray(Math.max(0, chunk.length - w.length)); pos += n; }
  } finally { fs.closeSync(fd); }
}

/** Pure: the rules object → the text a session reads. */
export function rulesText(r) {
  if (!r || !Array.isArray(r.rules) || !r.rules.length) return '';
  return `[Huddle] You were compacted; Huddle's rules again (v${r.version}) - keep them for this whole session:\n${r.rules.map((x, i) => `${i + 1}. ${x.en}`).join('\n')}`;
}

export async function rulesNow({ fetchImpl = fetch } = {}) {
  try { const res = await fetchImpl(`${URL_()}/rules.json`, { signal: AbortSignal.timeout(5000) }); const j = await res.json();
    if (j && Array.isArray(j.rules) && j.rules.length) { try { fs.mkdirSync(path.dirname(CACHE()), { recursive: true }); fs.writeFileSync(CACHE(), JSON.stringify(j)); } catch { /* the next time */ } return j; } } catch { /* the kept copy */ }
  try { return JSON.parse(fs.readFileSync(CACHE(), 'utf8')); } catch { return null; }
}

export async function onSessionStart(hook = {}, opts = {}) {
  if (hook.source !== 'compact' || !hook.transcript_path || !fileHas(hook.transcript_path, 'join_room')) return null;
  const text = rulesText(await rulesNow(opts)); if (!text) return null;
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  let input = ''; for await (const ch of process.stdin) input += ch;
  let hook = {}; try { hook = JSON.parse(input || '{}'); } catch { /* none */ }
  const out = await onSessionStart(hook).catch(() => null);
  if (out) process.stdout.write(JSON.stringify(out));
  process.exit(0);
}
