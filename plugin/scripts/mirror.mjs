#!/usr/bin/env node
// huddle/plugin/scripts/mirror.mjs — ADVISOR 2026-10-31 — Huddle P.7 ב: THIS SESSION'S WORK, SHOWN IN ITS HUDDLE ROOM (the user 31.10: «עבור
// משתמשים אחרים - אותו דבר, ובטעינה של האדל - 100 הודעות אחרונות … ישלפו אוטומטית מה-JSON של הסוכנים שלו»). A Stop hook: when a turn ends,
// the lines this session wrote since the last time are read from its own transcript and posted to the room it last used, as WORK LINES
// (send progress:true) - kept for its person to see, waking, ringing and asking no one. OFF unless the person turns it on (userConfig
// share_work = on): a transcript holds everything. Secrets and personal details are masked here first (pii.mjs, S.12); in a sealed room the
// lines are sealed on this machine (mcp-local.mjs). The first time, the last HUDDLE_SHARE_BACKFILL lines (default 100) go up; after that only
// what is new, from a cursor kept in ~/.huddle/mirror/. What the session already said with send is not posted twice.
// The hook itself returns at once: the upload runs in a hidden detached child, so a turn never waits for the network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stateOf } from './listen.mjs';
import { mask } from './pii.mjs';

const ON = /^(1|true|on|yes)$/i.test(String(process.env.CLAUDE_PLUGIN_OPTION_SHARE_WORK || process.env.HUDDLE_SHARE_WORK || '').trim());
const BACKFILL = Number.isFinite(Number(process.env.HUDDLE_SHARE_BACKFILL)) && process.env.HUDDLE_SHARE_BACKFILL !== '' ? Math.max(0, Number(process.env.HUDDLE_SHARE_BACKFILL)) : 100;
const PER_RUN = 10, CHUNK = 6000;   // at most 10 posts a turn (the door allows 60 writes a minute); the rest go next turn
const HOME = () => process.env.HUDDLE_HOME || path.join(os.homedir(), '.huddle');
const SEND = /huddle.*__send$/;

/** Pure: what this session wrote after the line `after` (a transcript uuid) - its own text, not a side agent's, not what it already sent
 *  to the room. No `after`: the last `backfill`. A cursor the transcript no longer holds: nothing, and the cursor moves to its end. */
export function newTexts(lines, after = null, backfill = 100) {
  const parsed = []; for (const l of lines) { try { const j = JSON.parse(l); if (j) parsed.push(j); } catch { /* a torn line */ } }
  const sent = new Set();
  for (const j of parsed) { const c = j.message && j.message.content; if (j.type === 'assistant' && Array.isArray(c)) for (const b of c) if (b && b.type === 'tool_use' && SEND.test(String(b.name || '')) && b.input && b.input.text) sent.add(String(b.input.text).trim()); }
  const endUuid = (() => { for (let i = parsed.length - 1; i >= 0; i--) if (parsed[i].uuid) return parsed[i].uuid; return after; })();
  let from = 0;
  if (after) { const i = parsed.findIndex((j) => j.uuid === after); if (i < 0) return { texts: [], last: endUuid }; from = i + 1; }
  const out = [];
  for (const j of parsed.slice(from)) {
    const c = j.message && j.message.content;
    if (j.type !== 'assistant' || j.isSidechain || !Array.isArray(c)) continue;
    for (const b of c) { const t = b && b.type === 'text' ? String(b.text || '').trim() : ''; if (t && !sent.has(t)) out.push({ text: t, uuid: j.uuid || null }); }
  }
  return { texts: after ? out : backfill > 0 ? out.slice(-backfill) : [], last: endUuid };
}
/** Pure: lines packed into posts of up to `max` characters, each post carrying the uuid of its last line. */
export function pack(texts, max = CHUNK) {
  const out = []; let cur = null;
  for (const x of texts) {
    const t = x.text.length > max ? `${x.text.slice(0, max - 1)}…` : x.text;
    if (cur && cur.text.length + 2 + t.length > max) { out.push(cur); cur = null; }
    cur = cur ? { text: `${cur.text}\n\n${t}`, uuid: x.uuid || cur.uuid } : { text: t, uuid: x.uuid };
  }
  if (cur) out.push(cur);
  return out;
}

const cursorFile = (sid) => path.join(HOME(), 'mirror', `${String(sid || 'x').replace(/[^\w-]/g, '')}.json`);
const readJ = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const saveCursor = (sid, after) => { fs.mkdirSync(path.dirname(cursorFile(sid)), { recursive: true }); fs.writeFileSync(cursorFile(sid), JSON.stringify({ after, at: new Date().toISOString() })); };

/** One upload: read, mask, post as work lines, move the cursor only past what landed. */
export async function run(hook, { send = null } = {}) {
  if (!hook || !hook.transcript_path || !fs.existsSync(hook.transcript_path)) return { ok: true, skipped: 'no transcript' };
  const lines = fs.readFileSync(hook.transcript_path, 'utf8').split('\n');
  const st = stateOf(lines); if (!st) return { ok: true, skipped: 'no room' };   // this session never used a Huddle room
  const sid = hook.session_id, prev = (readJ(cursorFile(sid)) || {}).after || null;
  const { texts, last } = newTexts(lines, prev, BACKFILL);
  const posts = pack(texts.map((x) => ({ ...x, text: mask(x.text).text })));
  const doSend = send || (await import('./mcp-local.mjs')).handle.bind(null, 'send');
  let sentN = 0, cursor = prev;
  for (const p of posts.slice(0, PER_RUN)) {
    let r; try { r = await doSend({ room: st.room, text: p.text, progress: true, ...(st.handle ? { as: st.handle } : {}) }); } catch (e) { r = { ok: false, problems: [String(e && e.message || e)] }; }
    if (!r || r.ok === false) break;
    sentN++; if (p.uuid) cursor = p.uuid;
  }
  if (sentN === posts.length) cursor = last;   // all of it landed: the cursor goes to the end of what was read
  if (cursor && cursor !== prev) saveCursor(sid, cursor);
  return { ok: true, room: st.room, posts: posts.length, sent: sentN };
}

async function main() {
  if (process.argv[2] === '--run') {   // the detached child
    const f = process.argv[3]; let hook = null; try { hook = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* none */ } try { fs.unlinkSync(f); } catch { /* gone */ }
    const lock = path.join(HOME(), 'mirror', `${String((hook || {}).session_id || 'x').replace(/[^\w-]/g, '')}.lock`);
    try { const st = fs.statSync(lock); if (Date.now() - st.mtimeMs < 120000) return 0; } catch { /* free */ }   // an upload for this session is running
    fs.mkdirSync(path.dirname(lock), { recursive: true }); fs.writeFileSync(lock, String(process.pid));
    try { await run(hook); } finally { try { fs.unlinkSync(lock); } catch { /* gone */ } }
    return 0;
  }
  let input = ''; for await (const ch of process.stdin) input += ch;
  if (!ON || !(process.env.CLAUDE_PLUGIN_OPTION_HUDDLE_KEY || process.env.HUDDLE_KEY)) return 0;
  const f = path.join(os.tmpdir(), `huddle-mirror-${process.pid}-${Date.now()}.json`); fs.writeFileSync(f, input || '{}');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--run', f], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
  child.unref();
  return 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main().then((c) => process.exit(c), () => process.exit(0));
