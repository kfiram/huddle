#!/usr/bin/env node
// huddle/plugin/scripts/steps.mjs — ADVISOR 2026-11-03 — THIS SESSION'S STEPS, LIVE IN ITS PERSON'S HUDDLE (go-queue #71, the user 3.11 on
// huddleapp.ai showing no steps: «תטפל...»). A PreToolUse hook: each tool call - its name and its input - is appended to a file on this
// machine, and a hidden child sends what gathered to the cloud (agent_steps) a moment later, so a turn never waits for the network and a
// burst of calls is one request. The cloud draws them exactly as a local Huddle does (core activityKind / activityDetail / activityBody).
// OFF unless the person turned «show my agents' steps» on in their Huddle: the switch comes back in agent_status's answer at each turn's
// end (mirror.mjs writes it here, with the session's agent and room). Before that answer - and while it is off - nothing leaves this machine.
// Paths are made relative to the project and every string is masked (pii.mjs) before it is written, never after.
//   PreToolUse:        node steps.mjs              (stdin: the hook's JSON)
//   UserPromptSubmit:  node steps.mjs --turn       a new turn: the cloud starts its list again
//   PostToolUse:       node steps.mjs --result     the call's file (a picture it got back or read, a file it wrote) - uploaded by the sender
//   the child:         node steps.mjs --flush <session>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mask } from './pii.mjs';

const HOME = () => process.env.HUDDLE_HOME || path.join(os.homedir(), '.huddle');
const sid = (s) => String(s || 'x').replace(/[^\w-]/g, '').slice(0, 80) || 'x';
const DIR = () => path.join(HOME(), 'steps');
const infoF = (s) => path.join(DIR(), `${sid(s)}.json`), spoolF = (s) => path.join(DIR(), `${sid(s)}.spool.jsonl`), lockF = (s) => path.join(DIR(), `${sid(s)}.flush`);
const readJ = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeJ = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); };
const BATCH = 30, MAX_INPUT = 150000;

/** Pure: every string in a tool's input, the project's own path cut to a relative one and masked - nested objects and arrays too. */
export function cleanInput(input, cwd = '') {
  const bases = [...new Set([String(cwd || ''), String(cwd || '').replace(/\\/g, '/')].filter((x) => x.length > 3))].sort((a, b) => b.length - a.length);
  const fix = (v, depth) => {
    if (typeof v === 'string') { let s = v; for (const b of bases) s = s.split(`${b}${b.includes('\\') ? '\\' : '/'}`).join('').split(b).join('.'); return mask(s).text; }
    if (depth > 6 || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.slice(0, 200).map((x) => fix(x, depth + 1));
    const o = {}; for (const [k, x] of Object.entries(v).slice(0, 100)) o[k] = fix(x, depth + 1); return o;
  };
  const out = fix(input && typeof input === 'object' ? input : {}, 0);
  return JSON.stringify(out).length > MAX_INPUT ? { note: 'too large to show' } : out;
}
/** Pure: the PreToolUse hook's JSON → one step { at, id, name, input[, engine] }, or null when it is not a tool call. An engine other than
 *  Claude / Codex keeps its own tool name; the cloud maps it (core normalizeCall). */
export function stepOf(hook, now = new Date()) {
  if (!hook || !hook.tool_name) return null;
  return { at: now.toISOString(), id: String(hook.tool_use_id || now.getTime()), name: String(hook.tool_name).slice(0, 120), input: cleanInput(hook.tool_input, hook.cwd), ...(hook.engine ? { engine: String(hook.engine) } : {}) };
}
// 🔑 the cloud, directly - this script also runs for Codex, Gemini, Antigravity and Goose (from ~/.huddle, beside codex-stop.mjs), where the
//    Claude plugin is not: the person's key from the environment (the Claude plugin's option) or from that engine's own Huddle settings
async function keyOf() {
  const k = process.env.CLAUDE_PLUGIN_OPTION_HUDDLE_KEY || process.env.HUDDLE_KEY; if (k) return k;
  try { return (await import('./codex-stop.mjs')).anyKeyOf(); } catch { return null; }
}
async function cloudSend(args, { fetchImpl = fetch } = {}) {
  const key = await keyOf(); if (!key) return { ok: false, problems: ['no Huddle key on this machine'] };
  const r = await fetchImpl(`${process.env.HUDDLE_URL || 'https://huddleapp.ai'}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'agent_steps', arguments: args } }), signal: AbortSignal.timeout(15000) });
  const j = await r.json(), res = j.result || {}; return res.structuredContent || JSON.parse(((res.content || [])[0] || {}).text || '{}');
}
// 💭 THE LINES BETWEEN THE STEPS, AND THE THINKING (#70 part 2): a local Huddle shows both, read from the agent's own transcript. Here the
//    transcript is read only from where this session last stopped (a byte offset kept with its switch; the first read starts 256 KB from
//    the end), each line masked, at most 4,000 characters - the same records the local readers take: Claude Code's assistant text and
//    thinking (never a side agent's, never the app's own notice), Antigravity's PLANNER_RESPONSE thinking/content, Codex's reasoning summary
//    and assistant message. Goose (a database) and Gemini CLI (its format not measured here) send their steps only.
const TX_FIRST = 262144, TX_MAX = 2 * 1024 * 1024;
/** Pure: one engine's transcript lines → the agent's lines and thinking [{ at, text, thought? }], masked. */
export function textsOf(lines, format = 'claude') {
  const out = [], add = (at, text, thought) => { const t = String(text || '').trim(); if (t) out.push({ at: at || new Date().toISOString(), text: mask(t.slice(0, 4000)).text, ...(thought ? { thought: true } : {}) }); };
  for (const l of lines || []) {
    let j; try { j = JSON.parse(l); } catch { continue; } if (!j || typeof j !== 'object') continue;
    if (format === 'antigravity') { if (j.type === 'PLANNER_RESPONSE') { if (typeof j.thinking === 'string') add(j.created_at, j.thinking, true); if (typeof j.content === 'string') add(j.created_at, j.content); } continue; }
    if (format === 'codex') { const p = j.payload || {}; if (j.type !== 'response_item') continue; if (p.type === 'reasoning') add(j.timestamp, [].concat(p.summary || []).map((x) => (x && x.text) || '').join('\n'), true); else if (p.type === 'message' && p.role === 'assistant') add(j.timestamp, [].concat(p.content || []).map((x) => (x && x.text) || '').join('\n')); continue; }
    if (j.type !== 'assistant' || j.isSidechain || j.isApiErrorMessage || (j.message && j.message.model === '<synthetic>')) continue;
    for (const b of (j.message && Array.isArray(j.message.content) ? j.message.content : [])) { if (b && b.type === 'text') add(j.timestamp, b.text); else if (b && b.type === 'thinking') add(j.timestamp, b.thinking, true); }
  }
  return out;
}
/** What the transcript gained since this session last read it → texts (the offset moves past the last whole line). Only while on. */
export function collectTexts(session, file, format = 'claude') {
  const info = infoOf(session); if (!file || !info || !info.on) return [];
  let size; try { size = fs.statSync(file).size; } catch { return []; }
  const known = info.tFile === file && Number.isFinite(info.tOff) && info.tOff <= size;
  let from = known ? info.tOff : Math.max(0, size - TX_FIRST); if (size - from > TX_MAX) from = size - TX_MAX;
  if (size <= from) return [];
  const b = Buffer.alloc(size - from), fd = fs.openSync(file, 'r'); try { fs.readSync(fd, b, 0, b.length, from); } finally { fs.closeSync(fd); }
  const end = b.lastIndexOf(10); if (end < 0) return [];
  let body = b.subarray(0, end).toString('utf8'); if (!known && from > 0) body = body.slice(body.indexOf('\n') + 1);   // a first read starts mid-line
  writeJ(infoF(session), { ...info, tFile: file, tOff: from + end + 1 });
  return textsOf(body.split('\n'), format);
}
/** This session's switch and address, as the last turn's end learned them: { on, handle, room, turn } | null. */
export const infoOf = (session) => readJ(infoF(session));
/** mirror.mjs, at each turn's end: what agent_status answered (on), and who / where this session is. */
export function remember(session, { on, handle, room }) { const cur = readJ(infoF(session)) || {}; writeJ(infoF(session), { ...cur, on: on === true, handle: handle || cur.handle || null, room: room || cur.room || null, at: new Date().toISOString() }); }
export function newTurn(session, now = new Date()) { const cur = readJ(infoF(session)); if (cur) writeJ(infoF(session), { ...cur, turn: now.toISOString() }); }

/** The hook: append the step (only while the switch is on), then make sure one sender is on its way. */
export function record(hook, { spawnFlush = true } = {}) {
  const info = infoOf(hook && hook.session_id); if (!info || !info.on || !info.handle) return { ok: true, skipped: info ? 'off' : 'no switch yet' };
  const s = stepOf(hook); if (!s) return { ok: true, skipped: 'not a tool call' };
  // the first step after a turn closed opens the next one - an engine with no «new prompt» signal of its own still starts a fresh list
  if (info.closed || !info.turn) writeJ(infoF(hook.session_id), { ...infoOf(hook.session_id), closed: false, turn: s.at });
  // what it wrote and thought before this call, then the call - the order the chat shows them in
  let tx = []; try { tx = collectTexts(hook.session_id, hook.transcript_path, hook.textFormat || 'claude'); } catch { tx = []; }
  fs.mkdirSync(DIR(), { recursive: true }); fs.appendFileSync(spoolF(hook.session_id), [...tx.map((t) => JSON.stringify({ type: 'text', ...t })), JSON.stringify(s)].join('\n') + '\n');
  if (spawnFlush) { let busy = false; try { busy = Date.now() - fs.statSync(lockF(hook.session_id)).mtimeMs < 30000; } catch { /* none */ } if (!busy) { const c = spawn(process.execPath, [fileURLToPath(import.meta.url), '--flush', sid(hook.session_id)], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env }); c.unref(); } }
  return { ok: true, spooled: 1 };
}
// 🖼️📄 WHAT AN AGENT MADE OR LOOKED AT, IN ITS PERSON'S HUDDLE (Kfir 4.11, ON by default: «יוצר אנושי בהחלט רשאי לראות את התוצרים שהסוכנים
//    שלו יוצרים עבורו או את התמונות שבהן הם צופים… זו שקיפות»; docs/CorpOS docs/ADVISOR-HUDDLE-FILES-FOR-ALL-2026-11-04.md). A PostToolUse hook:
//    the picture a tool handed back (a screenshot, a batch's last state), a picture it read, or a file it wrote is queued here; the sender
//    uploads it to the session's room (sealed in an end-to-end room, mcp-local attachAll) and sends it with the step it belongs to.
const PIC = /\.(png|jpe?g|gif|webp)$/i, MAX_UP = 10 * 1024 * 1024;
/** Pure: the LAST picture in a tool's result - an MCP content list's {type:'image', source:{base64}}, or Read's {type:'image', file:{base64}}. */
export function pictureOf(resp) {
  const items = Array.isArray(resp) ? resp : resp && Array.isArray(resp.content) ? resp.content : resp && typeof resp === 'object' ? [resp] : [];
  let found = null;
  for (const x of items) {
    if (!x || x.type !== 'image') continue;
    if (x.source && x.source.type === 'base64' && x.source.data) found = { data: String(x.source.data), type: String(x.source.media_type || 'image/png') };
    else if (x.file && x.file.base64) found = { data: String(x.file.base64), type: String(x.file.type || 'image/png') };
  }
  return found;
}
/** Pure: the file on disk a call made or looked at - a file it wrote, a picture it read, a picture path it named - absolute, or null. */
export function fileOfCall(name, input = {}, cwd = '') {
  const i = input || {}, abs = (p) => path.resolve(cwd || '.', p);
  if (name === 'Write' && i.file_path) return abs(String(i.file_path));
  if (name === 'Read' && i.file_path && PIC.test(String(i.file_path))) return abs(String(i.file_path));
  for (const k of ['filePath', 'file_path', 'path', 'filename', 'savePath', 'outputPath', 'output', 'output_path', 'image_path', 'imagePath']) { const v = i[k]; if (typeof v === 'string' && PIC.test(v.trim())) return abs(v.trim()); }
  return null;
}
/** The PostToolUse hook: queue the call's file for the sender (only while the switch is on and the session knows its room). */
export function recordResult(hook, { spawnFlush = true } = {}) {
  const info = infoOf(hook && hook.session_id); if (!info || !info.on || !info.handle || !info.room) return { ok: true, skipped: 'off or no room' };
  const id = String((hook && hook.tool_use_id) || ''); if (!id) return { ok: true, skipped: 'no call id' };
  let local = fileOfCall(String(hook.tool_name || ''), hook.tool_input, hook.cwd), tmp = false;
  const pic = hook.tool_name === 'Read' ? null : pictureOf(hook.tool_response);
  if (pic) {   // a picture handed back in the result: written once here, uploaded by the sender, then removed
    const ext = /jpe?g/.test(pic.type) ? 'jpg' : /webp/.test(pic.type) ? 'webp' : /gif/.test(pic.type) ? 'gif' : 'png';
    local = path.join(DIR(), 'files', `${sid(hook.session_id)}-${id.replace(/[^\w-]/g, '').slice(-24)}.${ext}`); tmp = true;
    try { fs.mkdirSync(path.dirname(local), { recursive: true }); fs.writeFileSync(local, Buffer.from(pic.data, 'base64')); } catch { return { ok: true, skipped: 'could not keep the picture' }; }
  }
  if (!local) return { ok: true, skipped: 'no file' };
  let size = 0; try { size = fs.statSync(local).size; } catch { return { ok: true, skipped: 'no such file' }; }
  if (!size || size > MAX_UP) { if (tmp) try { fs.unlinkSync(local); } catch { /* gone */ } return { ok: true, skipped: 'empty or over 10 MB' }; }
  fs.mkdirSync(DIR(), { recursive: true }); fs.appendFileSync(spoolF(hook.session_id), JSON.stringify({ type: 'upload', id, local, image: PIC.test(local), ...(tmp ? { tmp: true } : {}) }) + '\n');
  if (spawnFlush) { let busy = false; try { busy = Date.now() - fs.statSync(lockF(hook.session_id)).mtimeMs < 30000; } catch { /* none */ } if (!busy) { const c = spawn(process.execPath, [fileURLToPath(import.meta.url), '--flush', sid(hook.session_id)], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env }); c.unref(); } }
  return { ok: true, queued: local };
}
/** The uploads a flush carries: each queued file to the room (sealed when the room is), as { id, files }; a temp picture is removed after. */
async function uploadAll(room, ups, { attach = null } = {}) {
  if (!ups.length) return [];
  let up = attach;
  if (!up) {
    try {
      const M = await import('./mcp-local.mjs'), key = await keyOf(); if (!key) return [];
      const call = (n, a) => M.cloud(n, a, { key }), rk = await M.roomKey(room, { call });
      up = (paths) => M.attachAll(room, paths, { sealed: rk.sealed, key: rk.key, call });
    } catch { return []; }   // another engine's ~/.huddle has no mcp-local: its steps still go, without files
  }
  const out = [];
  for (const u of ups) {
    try { const files = await up([u.local]); if (files && files.length) out.push({ id: u.id, files: files.map((f) => ({ ...f, ...(u.image ? { image: true } : {}) })) }); } catch { /* this one is not shown */ }
    if (u.tmp) try { fs.unlinkSync(u.local); } catch { /* gone */ }
  }
  return out;
}
/** Send what gathered: the spool is taken whole (renamed), sent in batches; what did not land goes back. ended: the turn is over. */
export async function flush(session, { ended = false, send = null, transcript = null, format = 'claude', attach = null } = {}) {
  const info = infoOf(session); if (!info || !info.handle) return { ok: true, sent: 0 };
  const f = spoolF(session), taking = `${f}.${process.pid}.sending`; let items = [];
  // the turn's end: its last lines (the answer, the thinking before it) - read now, beside whatever steps gathered
  if (transcript) { try { const tx = collectTexts(session, transcript, format); if (tx.length) { fs.mkdirSync(DIR(), { recursive: true }); fs.appendFileSync(f, tx.map((t) => JSON.stringify({ type: 'text', ...t })).join('\n') + '\n'); } } catch { /* the steps still go */ } }
  try { fs.renameSync(f, taking); items = fs.readFileSync(taking, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { /* nothing gathered */ }
  const texts = items.filter((x) => x.type === 'text').map(({ type, ...t }) => t).slice(-60), steps = items.filter((x) => x.type !== 'text' && x.type !== 'upload'), ups = items.filter((x) => x.type === 'upload');
  if (!info.on) { for (const u of ups) if (u.tmp) try { fs.unlinkSync(u.local); } catch { /* gone */ } try { fs.unlinkSync(taking); } catch { /* none */ } return { ok: true, sent: 0, off: true }; }
  const results = info.room ? await uploadAll(info.room, ups, { attach }) : [];
  const doSend = send || cloudSend;
  let sent = 0, r = null;
  const batches = []; for (let i = 0; i < steps.length; i += BATCH) batches.push(steps.slice(i, i + BATCH)); if (!batches.length && (ended || texts.length || results.length)) batches.push([]);
  for (let i = 0; i < batches.length; i++) {
    const tx = i === 0 ? texts : [], rs = i === batches.length - 1 ? results : [];   // the lines ride with the first batch; the files with the last, after their steps
    try { r = await doSend({ as: info.handle, room: info.room || undefined, turn: info.turn || '', steps: batches[i], ...(tx.length ? { texts: tx } : {}), ...(rs.length ? { results: rs } : {}), ended: ended && i === batches.length - 1 }); } catch (e) { r = { ok: false, problems: [String((e && e.message) || e)] }; }
    if (r && r.off) { remember(session, { on: false }); break; }   // switched off in Huddle since: keep nothing, send nothing
    if (!r || r.ok === false) { const back = [...tx.map((t) => ({ type: 'text', ...t })), ...batches.slice(i).flat()]; if (back.length) fs.appendFileSync(f, back.map((x) => JSON.stringify(x)).join('\n') + '\n'); break; }
    sent += batches[i].length;
  }
  try { fs.unlinkSync(taking); } catch { /* none */ }
  if (ended && (!r || r.ok !== false)) { const cur = infoOf(session); if (cur) writeJ(infoF(session), { ...cur, closed: true }); }   // the next step opens a new turn
  return { ok: !r || r.ok !== false, sent };
}

async function main() {
  const a = process.argv.slice(2);
  if (a[0] === '--flush') {   // the hidden child: a moment for a burst to gather, then send until quiet
    const s = a[1]; fs.mkdirSync(DIR(), { recursive: true }); fs.writeFileSync(lockF(s), String(process.pid));
    try { for (let quiet = 0; quiet < 3;) { await new Promise((r) => setTimeout(r, 1500)); fs.writeFileSync(lockF(s), String(process.pid)); const r = await flush(s); quiet = r.sent ? 0 : quiet + 1; if (r.ok === false) break; } }
    finally { try { fs.unlinkSync(lockF(s)); } catch { /* gone */ } }
    return 0;
  }
  if (!(process.env.CLAUDE_PLUGIN_OPTION_HUDDLE_KEY || process.env.HUDDLE_KEY)) return 0;
  let input = ''; for await (const ch of process.stdin) input += ch;
  let hook = null; try { hook = JSON.parse(input || '{}'); } catch { return 0; }
  if (a[0] === '--turn') { newTurn(hook.session_id); return 0; }
  if (a[0] === '--result') { recordResult(hook); return 0; }
  record(hook);
  return 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main().then((c) => process.exit(c), () => process.exit(0));
