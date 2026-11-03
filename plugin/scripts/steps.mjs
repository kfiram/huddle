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
/** Pure: the PreToolUse hook's JSON → one step { at, id, name, input }, or null when it is not a tool call. */
export function stepOf(hook, now = new Date()) {
  if (!hook || !hook.tool_name) return null;
  return { at: now.toISOString(), id: String(hook.tool_use_id || now.getTime()), name: String(hook.tool_name).slice(0, 120), input: cleanInput(hook.tool_input, hook.cwd) };
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
  fs.mkdirSync(DIR(), { recursive: true }); fs.appendFileSync(spoolF(hook.session_id), `${JSON.stringify(s)}\n`);
  if (spawnFlush) { let busy = false; try { busy = Date.now() - fs.statSync(lockF(hook.session_id)).mtimeMs < 30000; } catch { /* none */ } if (!busy) { const c = spawn(process.execPath, [fileURLToPath(import.meta.url), '--flush', sid(hook.session_id)], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env }); c.unref(); } }
  return { ok: true, spooled: 1 };
}
/** Send what gathered: the spool is taken whole (renamed), sent in batches; what did not land goes back. ended: the turn is over. */
export async function flush(session, { ended = false, send = null } = {}) {
  const info = infoOf(session); if (!info || !info.handle) return { ok: true, sent: 0 };
  const f = spoolF(session), taking = `${f}.${process.pid}.sending`; let steps = [];
  try { fs.renameSync(f, taking); steps = fs.readFileSync(taking, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { /* nothing gathered */ }
  if (!info.on) { try { fs.unlinkSync(taking); } catch { /* none */ } return { ok: true, sent: 0, off: true }; }
  const doSend = send || (await import('./mcp-local.mjs')).handle.bind(null, 'agent_steps');
  let sent = 0, r = null;
  const batches = []; for (let i = 0; i < steps.length; i += BATCH) batches.push(steps.slice(i, i + BATCH)); if (!batches.length && ended) batches.push([]);
  for (let i = 0; i < batches.length; i++) {
    try { r = await doSend({ as: info.handle, room: info.room || undefined, turn: info.turn || '', steps: batches[i], ended: ended && i === batches.length - 1 }); } catch (e) { r = { ok: false, problems: [String((e && e.message) || e)] }; }
    if (r && r.off) { remember(session, { on: false }); break; }   // switched off in Huddle since: keep nothing, send nothing
    if (!r || r.ok === false) { const back = batches.slice(i).flat(); if (back.length) fs.appendFileSync(f, back.map((x) => JSON.stringify(x)).join('\n') + '\n'); break; }
    sent += batches[i].length;
  }
  try { fs.unlinkSync(taking); } catch { /* none */ }
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
  record(hook);
  return 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main().then((c) => process.exit(c), () => process.exit(0));
