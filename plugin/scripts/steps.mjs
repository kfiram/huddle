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
import zlib from 'node:zlib';
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
// 🧠 WHAT REACHED IT BESIDES ITS OWN WORK (transparency (1), in the cloud 6.11 - the site's section waits on it): read from the same lines
//    as its texts, by the rules a local Huddle uses (whatsup.mjs contextOf · codexContextOf · antigravityContextOf): what hooks added, what
//    arrived while it worked, a file changed outside its own edits, the app's reminders and compactions. Masked, 2,000 characters each.
const CTX_CAP = 2000;
/** Pure: one engine's transcript lines → [{ at, kind: 'hook'|'message'|'file'|'app', name, text }], masked. */
export function ctxOf(lines, format = 'claude') {
  const out = [], cut = (v) => { const t = mask(String(v || '')).text; return t.length > CTX_CAP ? `${t.slice(0, CTX_CAP)}\n… (${t.length - CTX_CAP} more characters)` : t; };
  const tag = (v) => { const t = String(v || '').trimStart(); return ((/^\[([A-Z][A-Z0-9_]{2,40})\]/.exec(t) || [])[1]) || ((/^<([a-z_][\w-]{2,40})/.exec(t) || [])[1]) || null; };
  const wake = (v) => (/from-name="([^"]+)"/.exec(String(v || '')) || /\[GW-WAKE\] from ([\w-]+)/.exec(String(v || '')) || [])[1];
  const add = (at, kind, name, text) => out.push({ at: new Date(Date.parse(at || '') || Date.now()).toISOString(), kind, name: String(name || '').slice(0, 80), text: cut(text) });
  for (const l of lines || []) {
    let j; try { j = JSON.parse(l); } catch { continue; } if (!j || typeof j !== 'object') continue;
    if (format === 'antigravity') {
      const K = { SYSTEM_MESSAGE: ['app', 'system message'], EPHEMERAL_MESSAGE: ['hook', null], CHECKPOINT: ['app', 'compaction'], USER_INPUT: ['message', null] }[j.type];
      if (K) { const text = String(j.content || ''); add(j.created_at, K[0], K[1] || tag(text) || wake(text) || (K[0] === 'hook' ? 'a hook' : 'a message'), text); }
      continue;
    }
    if (format === 'codex') {
      const q = j.payload || {};
      if (j.type === 'compacted') { add(j.timestamp, 'app', 'compaction', q.message || ''); continue; }
      if (q.type !== 'message' || (q.role !== 'developer' && q.role !== 'user')) continue;
      const text = [].concat(q.content || []).map((c) => (c && (c.text || c.input_text)) || '').filter(Boolean).join('\n'); if (!text.trim()) continue;
      const src = (/^<codex_internal_context source="([^"]+)"/.exec(text.trimStart()) || [])[1];
      if (q.role === 'developer') add(j.timestamp, 'app', tag(text) || 'developer', text);
      else if (src) add(j.timestamp, 'app', src, text);
      else if (/^\s*\[[A-Z][A-Z0-9_]{2,40}\]/.test(text)) add(j.timestamp, 'hook', tag(text), text);
      else add(j.timestamp, 'message', wake(text) || 'a message', text);
      continue;
    }
    const x = j.attachment; if (!x || typeof x !== 'object' || j.isSidechain) continue;
    if (x.type === 'hook_additional_context') for (const c of [].concat(x.content || [])) add(j.timestamp, 'hook', tag(c) || x.hookName || 'a hook', c);
    else if (x.type === 'hook_success' && /additionalContext/.test(String(x.stdout || ''))) { let a = ''; try { a = JSON.parse(x.stdout).hookSpecificOutput.additionalContext; } catch { a = ''; } if (a) add(j.timestamp, 'hook', tag(a) || x.hookName || 'a hook', a); }
    else if (x.type === 'queued_command') add(j.timestamp, 'message', wake(x.prompt) || 'a message', x.prompt);
    else if (x.type === 'edited_text_file') add(j.timestamp, 'file', String(x.filename || '').split(/[\\/]/).slice(-2).join('/'), x.snippet);
    else if (x.type === 'silent_turn_reminder' || x.type === 'compact_boundary') add(j.timestamp, 'app', x.type.replace(/_/g, ' '), x.text || '');
  }
  return out;
}
/** What the transcript gained since this session last read it → { texts, ctx } (the offset moves past the last whole line). Only while on. */
export function collectRead(session, file, format = 'claude') {
  const info = infoOf(session); if (!file || !info || !info.on) return { texts: [], ctx: [] };
  let size; try { size = fs.statSync(file).size; } catch { return { texts: [], ctx: [] }; }
  const known = info.tFile === file && Number.isFinite(info.tOff) && info.tOff <= size;
  let from = known ? info.tOff : Math.max(0, size - TX_FIRST); if (size - from > TX_MAX) from = size - TX_MAX;
  if (size <= from) return { texts: [], ctx: [] };
  const b = Buffer.alloc(size - from), fd = fs.openSync(file, 'r'); try { fs.readSync(fd, b, 0, b.length, from); } finally { fs.closeSync(fd); }
  const end = b.lastIndexOf(10); if (end < 0) return { texts: [], ctx: [] };
  let body = b.subarray(0, end).toString('utf8'); if (!known && from > 0) body = body.slice(body.indexOf('\n') + 1);   // a first read starts mid-line
  writeJ(infoF(session), { ...info, tFile: file, tOff: from + end + 1 });
  const L = body.split('\n'); return { texts: textsOf(L, format), ctx: ctxOf(L, format) };
}
/** The texts alone (as before collectRead). */
export const collectTexts = (session, file, format = 'claude') => collectRead(session, file, format).texts;
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
  let rd = { texts: [], ctx: [] }; try { rd = collectRead(hook.session_id, hook.transcript_path, hook.textFormat || 'claude'); } catch { /* the step still goes */ }
  fs.mkdirSync(DIR(), { recursive: true }); fs.appendFileSync(spoolF(hook.session_id), [...rd.ctx.map((c) => JSON.stringify({ type: 'ctx', ...c })), ...rd.texts.map((t) => JSON.stringify({ type: 'text', ...t })), JSON.stringify(s)].join('\n') + '\n');
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
// 🧾 WHAT A CALL GAVE, AND WHY ONE WAS STOPPED - in the cloud too (transparency, 6.11: a local Huddle showed both, huddleapp.ai neither). The
//    PostToolUse hook's tool_response, or PostToolUseFailure's error (a call that failed or was refused), as text - masked here, at most
//    20,000 characters; the cloud bounds it again and names a refusal with the same rule as this machine (core withResult).
const OUT_MAX = 20000;
/** Pure: a tool's response → its text (a string, Bash's stdout/stderr, an MCP content list's texts, else its JSON). */
export function responseText(resp) {
  if (resp == null) return '';
  if (typeof resp === 'string') return resp;
  if (Array.isArray(resp)) return resp.map((x) => (typeof x === 'string' ? x : x && x.type === 'text' ? String(x.text || '') : '')).filter(Boolean).join('\n');
  if (typeof resp === 'object') {
    if ('stdout' in resp || 'stderr' in resp) return [resp.stdout, resp.stderr].filter((x) => typeof x === 'string' && x).join('\n');
    if (Array.isArray(resp.content)) return responseText(resp.content);
    if (typeof resp.content === 'string') return resp.content;
    if (resp.file && typeof resp.file.content === 'string') return resp.file.content;
    try { return JSON.stringify(resp); } catch { return ''; }
  }
  return String(resp);
}
/** Pure: the hook's JSON → { id, text, failed } of the call's result, or null. */
export function outOf(hook) {
  const id = String((hook && hook.tool_use_id) || ''); if (!id) return null;
  const failed = hook.hook_event_name === 'PostToolUseFailure' || typeof hook.error === 'string';
  let text = failed ? String(hook.error || '') : responseText(hook.tool_response);
  if (!text.trim()) return null;
  if (text.length > OUT_MAX) text = `${text.slice(0, OUT_MAX)}\n… (${text.length - OUT_MAX} more characters)`;
  return { id, text: mask(text).text, ...(failed ? { failed: true } : {}) };
}
// 🤖 A HELPER'S OWN STEPS, UNDER THE STEP THAT STARTED IT (transparency (6), in the cloud 6.11): Claude Code keeps each sub-agent in
//    <session>/subagents/agent-<id>.jsonl, its .meta.json naming the Agent call that started it (toolUseId) - the file a local Huddle reads
//    (whatsup.mjs subagentOf). Sent when that call ends: its calls (name, a small masked input, its own id - the cloud drops their flat copies
//    by it), whether each failed, and its answer. → { type, description, calls, answer } or null
const SUB_INPUT = 2000;
const small = (v, depth = 0) => { if (typeof v === 'string') return v.length > 300 ? `${v.slice(0, 300)}…` : v; if (depth > 3 || v === null || typeof v !== 'object') return v; if (Array.isArray(v)) return v.slice(0, 20).map((x) => small(x, depth + 1)); const o = {}; for (const [k, x] of Object.entries(v).slice(0, 30)) o[k] = small(x, depth + 1); return o; };
export function subagentOf(transcriptPath, toolUseId, cwd = '') {
  if (!transcriptPath || !toolUseId) return null;
  const dir = path.join(String(transcriptPath).replace(/\.jsonl$/i, ''), 'subagents');
  let metas = []; try { metas = fs.readdirSync(dir).filter((f) => f.endsWith('.meta.json')); } catch { return null; }
  for (const mf of metas) {
    const meta = readJ(path.join(dir, mf)); if (!meta || meta.toolUseId !== toolUseId) continue;
    let lines = []; try { lines = fs.readFileSync(path.join(dir, mf.replace(/\.meta\.json$/, '.jsonl')), 'utf8').split('\n'); } catch { return null; }
    const calls = [], bad = new Set(); let answer = '';
    for (const l of lines) {
      let j; try { j = JSON.parse(l); } catch { continue; } const c = j && j.message && Array.isArray(j.message.content) ? j.message.content : [];
      if (j.type === 'assistant') for (const b of c) { if (b && b.type === 'tool_use') { let input = cleanInput(b.input, cwd); input = small(input); if (JSON.stringify(input).length > SUB_INPUT) input = { note: 'too large to show' }; calls.push({ at: j.timestamp || null, id: String(b.id || ''), name: String(b.name || '').slice(0, 120), input }); } else if (b && b.type === 'text' && String(b.text || '').trim()) answer = String(b.text); }
      if (j.type === 'user') for (const b of c) if (b && b.type === 'tool_result' && b.is_error) bad.add(String(b.tool_use_id || ''));
    }
    return { type: String(meta.agentType || 'helper').slice(0, 60), description: mask(String(meta.description || '').slice(0, 200)).text, calls: calls.slice(-200).map((x) => (bad.has(x.id) ? { ...x, failed: true } : x)), total: calls.length, answer: mask(answer.slice(0, 4000)).text };
  }
  return null;
}
// 🤖 HELPERS OF CODEX AND ANTIGRAVITY, IN THE CLOUD (transparency (6) for every engine, 6.11 - the local readers: whatsup.mjs codexHelperOf /
//    antigravityHelperOf). Their call returns at once and the helper works on, so they are read at the TURN'S END, from the turn's own tail of
//    the transcript (a live Codex rollout passes 1.9 GB - only its last bytes are read). Codex: spawn_agent → the helper's own rollout, whose
//    first line names its parent thread and agent_path (= the call's task_name), in the folder of the day it began. Antigravity:
//    invoke_subagent's result names the helper's conversation → brain/<id> transcript, and the parent's subagents/<id>.json its type and role.
const TAIL = 8 * 1024 * 1024;
const tailLines = (f, bytes = TAIL) => { const fd = fs.openSync(f, 'r'); try { const size = fs.fstatSync(fd).size, n = Math.min(size, bytes), b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, size - n); const ls = b.toString('utf8').split('\n'); if (size > n) ls.shift(); return ls; } finally { fs.closeSync(fd); } };
const allLines = (f) => { let b = fs.readFileSync(f); if (f.endsWith('.zst')) b = zlib.zstdDecompressSync(b); return b.toString('utf8').split('\n'); };
const parseArgs = (a) => { if (a && typeof a === 'object') return a; try { return JSON.parse(String(a || '{}')); } catch { return { input: String(a || '').slice(0, 300) }; } };
const smallInput = (v, cwd) => { let input = small(cleanInput(v, cwd)); if (JSON.stringify(input).length > SUB_INPUT) input = { note: 'too large to show' }; return input; };
/** Pure-ish: one helper's lines → { calls, total, answer } in the cloud's sub shape. */
function helperCalls(lines, format, cwd) {
  const calls = [];
  for (const l of lines) { let j; try { j = JSON.parse(l); } catch { continue; } if (!j) continue;
    if (format === 'codex') { const p = j.payload || {}; if (j.type === 'response_item' && /^(function_call|custom_tool_call)$/.test(p.type || '')) calls.push({ at: j.timestamp || null, id: String(p.call_id || p.id || ''), name: String(p.name || '').slice(0, 120), input: smallInput(parseArgs(p.arguments ?? p.input), cwd) }); }
    else if (j.type === 'PLANNER_RESPONSE' && Array.isArray(j.tool_calls)) j.tool_calls.forEach((x, k) => calls.push({ at: j.created_at || null, id: `${j.step_index}:${k}`, name: String((x && x.name) || '').slice(0, 120), input: smallInput(parseArgs(x && (x.args ?? x.arguments)), cwd) }));
  }
  const last = textsOf(lines, format).filter((t) => !t.thought).pop();
  return { calls: calls.slice(-200), total: calls.length, answer: last ? last.text.slice(0, 4000) : '' };
}
export function helpersOfTurn(transcriptPath, format, sinceIso = '', cwd = '') {
  if (!transcriptPath || !/^(codex|antigravity)$/.test(format)) return [];
  const since = Date.parse(sinceIso) || 0, out = [], lines = tailLines(transcriptPath);
  const atOf = (j) => Date.parse(format === 'codex' ? j.timestamp : j.created_at) || 0;
  if (format === 'codex') {
    const parent = (/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(\.zst)?$/i.exec(transcriptPath) || [])[1]; if (!parent) return [];
    const home = path.resolve(path.dirname(transcriptPath), '..', '..', '..');   // sessions/YYYY/MM/DD/rollout-… → sessions
    for (const l of lines) { if (!l.includes('spawn_agent')) continue; let j; try { j = JSON.parse(l); } catch { continue; } const p = (j && j.payload) || {};
      if (!(j.type === 'response_item' && /call$/.test(p.type || '') && p.name === 'spawn_agent') || atOf(j) < since) continue;
      const args = parseArgs(p.arguments), want = String(args.task_name || '').replace(/^\/root\//, ''), t0 = atOf(j), cands = [];
      for (const off of [0, 864e5]) { const d = new Date(t0 + off), dir = path.join(home, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
        let ns = []; try { ns = fs.readdirSync(dir); } catch { continue; }
        for (const n of ns) { const mm = /([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(\.zst)?$/.exec(n); if (!mm) continue; const ms = parseInt(mm[1].replace(/-/g, '').slice(0, 12), 16); if (ms < t0 - 2000 || ms > t0 + 600e3) continue;
          let meta = null; try { meta = JSON.parse(allLines(path.join(dir, n))[0]).payload; } catch { continue; } const sp = meta && meta.source && meta.source.subagent && meta.source.subagent.thread_spawn;
          if (sp && sp.parent_thread_id === parent) cands.push({ f: path.join(dir, n), ms, sp }); } }
      cands.sort((a, b) => a.ms - b.ms); const hit = (want && cands.find((c) => String(c.sp.agent_path || '').replace(/^\/root\//, '') === want)) || cands[0]; if (!hit) continue;
      let hl = []; try { hl = allLines(hit.f); } catch { continue; }
      out.push({ call: { at: j.timestamp, id: String(p.call_id || ''), name: 'spawn_agent', input: smallInput(args, cwd) },
        sub: { engine: 'codex', type: String(hit.sp.agent_role || 'helper').slice(0, 60), description: mask(String(hit.sp.agent_nickname ? `${hit.sp.agent_nickname}${hit.sp.agent_path ? ` · ${hit.sp.agent_path}` : ''}` : (hit.sp.agent_path || '')).slice(0, 200)).text, ...helperCalls(hl, 'codex', cwd) } });
    }
  } else {
    const brain = path.resolve(path.dirname(transcriptPath), '..', '..', '..'), parent = path.basename(path.resolve(path.dirname(transcriptPath), '..', '..'));   // brain/<conv>/.system_generated/logs/…
    let pending = [];
    for (const l of lines) { let j; try { j = JSON.parse(l); } catch { continue; } if (!j || atOf(j) < since) continue;
      if (j.type === 'PLANNER_RESPONSE' && Array.isArray(j.tool_calls)) j.tool_calls.forEach((x, k) => { if (x && x.name === 'invoke_subagent') pending.push({ at: j.created_at, id: `${j.step_index}:${k}`, input: x.args }); });
      if (j.type === 'GENERIC' && typeof j.content === 'string' && j.content.includes('Created the following subagents') && pending.length) {
        const c = pending.shift(), id = (/"conversationId"\s*:\s*"([0-9a-f-]{36})"/.exec(j.content) || [])[1]; if (!id) continue;
        let d = {}; try { d = JSON.parse(fs.readFileSync(path.join(brain, parent, '.system_generated', 'subagents', `${id}.json`), 'utf8')) || {}; } catch { /* optional */ }
        let hl = []; for (const n of ['transcript_full.jsonl', 'transcript.jsonl']) { try { hl = fs.readFileSync(path.join(brain, id, '.system_generated', 'logs', n), 'utf8').split('\n'); break; } catch { /* next */ } } if (!hl.length) continue;
        const sd = d.subagentDescriptor || {};
        out.push({ call: { at: c.at, id: c.id, name: 'invoke_subagent', input: smallInput(c.input, cwd) }, sub: { engine: 'antigravity', type: String(sd.typeName || 'helper').slice(0, 60), description: mask(String(sd.role || '').slice(0, 200)).text, ...helperCalls(hl, 'antigravity', cwd) } });
      }
    }
  }
  return out;
}
/** The PostToolUse / PostToolUseFailure hook: queue the call's result and its file for the sender (only while the switch is on and the session knows its room). */
export function recordResult(hook, { spawnFlush = true } = {}) {
  const info = infoOf(hook && hook.session_id); if (!info || !info.on || !info.handle || !info.room) return { ok: true, skipped: 'off or no room' };
  const id = String((hook && hook.tool_use_id) || ''); if (!id) return { ok: true, skipped: 'no call id' };
  const out = outOf(hook); if (out) { fs.mkdirSync(DIR(), { recursive: true }); fs.appendFileSync(spoolF(hook.session_id), JSON.stringify({ type: 'out', ...out }) + '\n'); }
  if (/^(Agent|Task)$/.test(String(hook.tool_name || ''))) { let sub = null; try { sub = subagentOf(hook.transcript_path, id, hook.cwd); } catch { /* its steps still show flat */ } if (sub) { fs.mkdirSync(DIR(), { recursive: true }); fs.appendFileSync(spoolF(hook.session_id), JSON.stringify({ type: 'sub', id, sub }) + '\n'); } }
  const kick = () => { if (!spawnFlush) return; let busy = false; try { busy = Date.now() - fs.statSync(lockF(hook.session_id)).mtimeMs < 30000; } catch { /* none */ } if (!busy) { const c = spawn(process.execPath, [fileURLToPath(import.meta.url), '--flush', sid(hook.session_id)], { detached: true, stdio: 'ignore', windowsHide: true }); c.unref(); } };
  if (hook.hook_event_name === 'PostToolUseFailure') { kick(); return { ok: true, queued: 'result' }; }
  let local = fileOfCall(String(hook.tool_name || ''), hook.tool_input, hook.cwd), tmp = false;
  const pic = hook.tool_name === 'Read' ? null : pictureOf(hook.tool_response);
  if (pic) {   // a picture handed back in the result: written once here, uploaded by the sender, then removed
    const ext = /jpe?g/.test(pic.type) ? 'jpg' : /webp/.test(pic.type) ? 'webp' : /gif/.test(pic.type) ? 'gif' : 'png';
    local = path.join(DIR(), 'files', `${sid(hook.session_id)}-${id.replace(/[^\w-]/g, '').slice(-24)}.${ext}`); tmp = true;
    try { fs.mkdirSync(path.dirname(local), { recursive: true }); fs.writeFileSync(local, Buffer.from(pic.data, 'base64')); } catch { return { ok: true, skipped: 'could not keep the picture' }; }
  }
  if (!local) { if (out) kick(); return { ok: true, skipped: 'no file', ...(out ? { result: true } : {}) }; }
  let size = 0; try { size = fs.statSync(local).size; } catch { return { ok: true, skipped: 'no such file' }; }
  if (!size || size > MAX_UP) { if (tmp) try { fs.unlinkSync(local); } catch { /* gone */ } return { ok: true, skipped: 'empty or over 10 MB' }; }
  fs.mkdirSync(DIR(), { recursive: true }); fs.appendFileSync(spoolF(hook.session_id), JSON.stringify({ type: 'upload', id, local, image: PIC.test(local), ...(tmp ? { tmp: true } : {}) }) + '\n');
  kick();
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
  if (transcript) { try { const rd = collectRead(session, transcript, format), add = [...rd.ctx.map((c) => ({ type: 'ctx', ...c })), ...rd.texts.map((t) => ({ type: 'text', ...t }))]; if (add.length) { fs.mkdirSync(DIR(), { recursive: true }); fs.appendFileSync(f, add.map((x) => JSON.stringify(x)).join('\n') + '\n'); } } catch { /* the steps still go */ } }
  try { fs.renameSync(f, taking); items = fs.readFileSync(taking, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { /* nothing gathered */ }
  if (ended && transcript && /^(codex|antigravity)$/.test(format)) { try { for (const h of helpersOfTurn(transcript, format, info.turn || '')) {
    const near = items.find((x) => !x.type && x.name === h.call.name && Math.abs(Date.parse(x.at) - Date.parse(h.call.at)) < 5000);
    if (!near) items.push(h.call); items.push({ type: 'sub', id: near ? near.id : h.call.id, sub: h.sub }); } } catch { /* the turn's other lines still go */ } }
  const texts = items.filter((x) => x.type === 'text').map(({ type, ...t }) => t).slice(-60), steps = items.filter((x) => x.type !== 'text' && x.type !== 'upload' && x.type !== 'out' && x.type !== 'ctx' && x.type !== 'sub'), ctx = items.filter((x) => x.type === 'ctx').map(({ type, ...c }) => c).slice(-60), subs = items.filter((x) => x.type === 'sub').map(({ type, ...x }) => x).slice(-10), ups = items.filter((x) => x.type === 'upload'), outs = items.filter((x) => x.type === 'out').map(({ type, ...o }) => o).slice(-40);
  if (!info.on) { for (const u of ups) if (u.tmp) try { fs.unlinkSync(u.local); } catch { /* gone */ } try { fs.unlinkSync(taking); } catch { /* none */ } return { ok: true, sent: 0, off: true }; }
  const results = info.room ? await uploadAll(info.room, ups, { attach }) : [];
  const doSend = send || cloudSend;
  let sent = 0, r = null;
  const batches = []; for (let i = 0; i < steps.length; i += BATCH) batches.push(steps.slice(i, i + BATCH)); if (!batches.length && (ended || texts.length || results.length || outs.length || ctx.length || subs.length)) batches.push([]);
  for (let i = 0; i < batches.length; i++) {
    const tx = i === 0 ? texts : [], cx = i === 0 ? ctx : [], rs = i === batches.length - 1 ? results : [], os = i === batches.length - 1 ? outs : [], sb = i === batches.length - 1 ? subs : [];   // the lines ride with the first batch; the files with the last, after their steps
    try { r = await doSend({ as: info.handle, room: info.room || undefined, turn: info.turn || '', steps: batches[i], ...(tx.length ? { texts: tx } : {}), ...(cx.length ? { ctx: cx } : {}), ...(rs.length ? { results: rs } : {}), ...(os.length ? { outs: os } : {}), ...(sb.length ? { subs: sb } : {}), ended: ended && i === batches.length - 1 }); } catch (e) { r = { ok: false, problems: [String((e && e.message) || e)] }; }
    if (r && r.off) { remember(session, { on: false }); break; }   // switched off in Huddle since: keep nothing, send nothing
    if (!r || r.ok === false) { const back = [...cx.map((c) => ({ type: 'ctx', ...c })), ...tx.map((t) => ({ type: 'text', ...t })), ...batches.slice(i).flat(), ...outs.map((o) => ({ type: 'out', ...o })), ...subs.map((x) => ({ type: 'sub', ...x }))]; if (back.length) fs.appendFileSync(f, back.map((x) => JSON.stringify(x)).join('\n') + '\n'); break; }
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
