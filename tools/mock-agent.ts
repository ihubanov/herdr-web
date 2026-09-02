#!/usr/bin/env bun
/**
 * Reference implementation of herdr-agent-stream/1 (see docs/PROTOCOL.md).
 *
 * Pretends to be an agent running inside a herdr pane: creates a Unix socket,
 * advertises it through pane metadata with a refreshing TTL, and serves
 * stream-json frames with a monotonic gapless `seq` so replay works.
 *
 * Two jobs:
 *   1. Lets herdr-web's client be built and tested with no real agent present.
 *   2. Gives an agent implementing the protocol something to conform to.
 *
 *   bun tools/mock-agent.ts <pane_id>
 */
import { createServer, type Socket } from "node:net";
import { mkdirSync, chmodSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { call } from "../src/server/herdr-socket.ts";

const paneId = process.argv[2];
if (!paneId) {
  console.error("usage: bun tools/mock-agent.ts <pane_id>");
  process.exit(1);
}

const SESSION = `mock-${process.pid}`;
const dir = join(process.env.XDG_RUNTIME_DIR || "/tmp", "herdr-agent-stream");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const sockPath = join(dir, `${SESSION}.sock`);
if (existsSync(sockPath)) unlinkSync(sockPath);

/**
 * Ring of SEQ'D frames. Per PROTOCOL.md §3b this holds not just `frame` but
 * also permission_request / question_request and their *_resolved partners:
 * a viewer joining mid-prompt must be able to replay a pending request, and
 * must then see its resolution rather than a stuck prompt.
 */
const buffer: any[] = [];
let seq = 0;
const subscribers = new Set<Socket>();
const participants = new Set<string>();

/** Emit a seq'd, buffered, replayable frame of any type. */
function emit(obj: Record<string, unknown>) {
  seq += 1;
  const f = { ...obj, seq, ts: Date.now() };
  buffer.push(f);
  if (buffer.length > 500) buffer.shift();
  const line = JSON.stringify(f) + "\n";
  for (const s of subscribers) { try { s.write(line); } catch {} }
  return f;
}

function publish(msg: any, author?: string) {
  emit({ type: "frame", author, msg });
}

// ---- HITL pending registry (PROTOCOL.md §3b) -------------------------------
interface Pending { kind: "permission" | "question"; timer: ReturnType<typeof setTimeout> }
const pending = new Map<string, Pending>();
let reqN = 0;

/** Resolve exactly once. Late replies are ignored, not errors. */
function resolveRequest(id: string, extra: Record<string, unknown>) {
  const p = pending.get(id);
  if (!p) return false;              // first-reply-wins: already resolved
  clearTimeout(p.timer);
  pending.delete(id);
  emit({ type: `${p.kind}_resolved`, request_id: id, ...extra });
  return true;
}

function askPermission(tool: string, input: any, reason: string, timeout_ms = 120000) {
  const id = `p_${++reqN}`;
  const timer = setTimeout(() => {
    // Timeout is AGENT-side and surfaces as a resolution; clients never
    // synthesize a decision.
    resolveRequest(id, { decision: "deny", by: "timeout" });
  }, timeout_ms);
  pending.set(id, { kind: "permission", timer });
  emit({ type: "permission_request", request_id: id, tool, input, reason, timeout_ms });
  return id;
}

function askQuestion(questions: any[], timeout_ms = 300000) {
  const id = `q_${++reqN}`;
  const timer = setTimeout(() => {
    resolveRequest(id, { by: "timeout", declined: true });
  }, timeout_ms);
  pending.set(id, { kind: "question", timer });
  emit({ type: "question_request", request_id: id, questions, timeout_ms });
  return id;
}

function broadcast(obj: any) {
  const line = JSON.stringify(obj) + "\n";
  for (const s of subscribers) { try { s.write(line); } catch {} }
}

// ---- seed some history so replay is observable -----------------------------
publish({ type: "system", subtype: "init", session_id: SESSION, model: "mock-1" });
publish({ type: "assistant", message: { role: "assistant",
  content: [{ type: "text", text: "Mock agent ready. This is seeded history." }] } });

// ---- socket ----------------------------------------------------------------
const server = createServer((sock) => {
  let buf = "";
  let greeted = false;

  sock.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m: any;
      try { m = JSON.parse(line); } catch { continue; }

      if (m.type === "hello") {
        greeted = true;
        subscribers.add(sock);
        sock.write(JSON.stringify({
          type: "ready", proto: 1, agent: "mock", session: SESSION,
          seq, replay: buffer.length > 0, participants: [...participants],
          // Optional convenience (§3b): outstanding prompts, so a joining
          // client can render them without a full replay.
          pending: [...pending.keys()],
        }) + "\n");
        const from = Number(m.from_seq) || 0;
        for (const f of buffer) {
          if (f.seq > from) { try { sock.write(JSON.stringify(f) + "\n"); } catch {} }
        }
        console.log(`[mock] subscriber joined (from_seq=${from}), ${subscribers.size} total`);
        continue;
      }
      if (!greeted) continue;

      if (m.type === "ping") { sock.write(JSON.stringify({ type: "pong" }) + "\n"); continue; }

      if (m.type === "permission_reply") {
        const ok = resolveRequest(String(m.request_id), {
          decision: m.decision === "allow" ? "allow" : "deny",
          by: String(m.author || "anon"),
        });
        console.log(`[mock] permission_reply ${m.request_id} ${m.decision} by ${m.author}` +
                    (ok ? "" : "  (already resolved - ignored)"));
        continue;
      }

      if (m.type === "question_reply") {
        const ok = resolveRequest(String(m.request_id), {
          by: String(m.author || "anon"), declined: !!m.declined,
        });
        console.log(`[mock] question_reply ${m.request_id} ${JSON.stringify(m.answers)} ` +
                    `by ${m.author}` + (ok ? "" : "  (already resolved - ignored)"));
        continue;
      }

      if (m.type === "interrupt") {
        console.log(`[mock] interrupt by ${m.author || "anon"}`);
        publish({ type: "system", subtype: "interrupted",
                  by: String(m.author || "anon") });
        continue;
      }

      if (m.type === "say") {
        const author = String(m.author || "anon");
        const text = String(m.text ?? "");
        if (!participants.has(author)) {
          participants.add(author);
          broadcast({ type: "participants", list: [...participants] });
        }
        console.log(`[mock] say from ${author}: ${text.slice(0, 60)}`);

        // Test hooks so a client can exercise §3b deterministically:
        //   /permission [ms]   /question [ms]   /both
        const cmd = text.trim().split(/\s+/);
        if (cmd[0] === "/permission" || cmd[0] === "/both") {
          askPermission("Bash", { command: "rm -rf build/" },
            "writes outside the sandbox", Number(cmd[1]) || 120000);
          if (cmd[0] !== "/both") continue;
        }
        if (cmd[0] === "/render") {
          // Exercises the render paths a real transcript hits.
          publish({ type: "assistant", message: { role: "assistant",
            content: [{ type: "thinking", thinking: "checking the session directory and git state" }] } });
          setTimeout(() => publish({ type: "assistant", message: { role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "Bash", input: {
              command: "ls -la /home/user/.sessions/8013bd38-ac15-40b6-a277-fb5e9c262b9f/ 2>&1; git -C /home/user/.sessions/8013bd38 status 2>&1 | head -5",
              description: "List session dir and git status" } }] } }), 200);
          setTimeout(() => publish({ type: "user", message: { role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1",
              content: "total 8\ndrwxr-xr-x 2 user user 4096 Sep  2 06:17 .\ndrwxr-xr-x 3 user user 4096 Sep  2 06:17 ..\nfatal: not a git repository (or any of the parent directories): .git" }] } }), 400);
          setTimeout(() => publish({ type: "assistant", message: { role: "assistant",
            content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "/etc/hosts" } }] } }), 600);
          setTimeout(() => publish({ type: "user", message: { role: "user",
            content: [{ type: "tool_result", tool_use_id: "t2",
              content: JSON.stringify({ observations: Array.from({length:14},(_,i)=>({
                memory_id:`db74213c-a57b-4775-9f40-e6d3b5ff90${i}`, domain:"session-lifecycle",
                status:"committed", confidence:0.847, content:"Session ended (other). Direct-write SessionEnd hook recording the lifecycle event; per-turn content is captured by the agent's own calls." })) }) }] } }), 800);
          setTimeout(() => publish({ type: "assistant", message: { role: "assistant",
            content: [{ type: "text", text: "The working dir resolved to /home/user/project — a git repo on main, clean, with recent commits. What would you like to do?" }] } }), 1100);
          continue;
        }
        if (cmd[0] === "/question" || cmd[0] === "/both") {
          askQuestion([{
            id: "q1", header: "Storage", question: "Which database should we use?",
            multiSelect: false,
            options: [
              { label: "Postgres", description: "Relational, what we know" },
              { label: "SQLite", description: "Zero-ops, single file" },
              { label: "Yes, with caveats", description: "Label containing a comma - array encoding must survive this" },
            ],
          }, {
            id: "q2", header: "Extras", question: "Which extras?", multiSelect: true,
            options: [{ label: "metrics" }, { label: "tracing" }, { label: "audit log" }],
          }], Number(cmd[1]) || 300000);
          continue;
        }
        // Echo the user turn, then a fake assistant turn with a tool call,
        // so the client has all three block kinds to render.
        publish({ type: "user", message: { role: "user",
          content: [{ type: "text", text }] } }, author);
        setTimeout(() => publish({ type: "assistant", message: { role: "assistant",
          content: [{ type: "thinking", thinking: `considering ${author}'s request…` }] } }), 250);
        setTimeout(() => publish({ type: "assistant", message: { role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Bash",
                     input: { command: "echo mock" } }] } }), 600);
        setTimeout(() => publish({ type: "user", message: { role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "mock\n" }] } }), 950);
        setTimeout(() => publish({ type: "assistant", message: { role: "assistant",
          content: [{ type: "text", text: `Done, ${author}. (mock reply to "${text.slice(0,40)}")` }] } }), 1300);
      }
    }
  });

  const drop = () => { subscribers.delete(sock); console.log(`[mock] subscriber left, ${subscribers.size} left`); };
  sock.on("close", drop);
  sock.on("error", drop);
});

server.listen(sockPath, () => {
  chmodSync(sockPath, 0o600);
  console.log(`[mock] listening ${sockPath}`);
});

// ---- advertise through herdr pane metadata ---------------------------------
async function advertise() {
  try {
    await call("pane.report_metadata", {
      pane_id: paneId,
      source: "mock-agent",
      ttl_ms: 120000,
      tokens: {
        stream_proto: "1",
        stream_sock: sockPath,
        stream_fmt: "stream-json",
        stream_session: SESSION,
      },
    });
  } catch (err: any) {
    console.error("[mock] advertise failed:", err.message);
  }
}
await advertise();
console.log(`[mock] advertised on pane ${paneId}`);
const timer = setInterval(advertise, 45_000);

// ---- teardown --------------------------------------------------------------
async function shutdown() {
  clearInterval(timer);
  broadcast({ type: "bye", reason: "agent exiting" });
  try {
    await call("pane.report_metadata", {
      pane_id: paneId, source: "mock-agent",
      tokens: { stream_proto: null, stream_sock: null, stream_fmt: null, stream_session: null },
    });
  } catch {}
  try { server.close(); unlinkSync(sockPath); } catch {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
