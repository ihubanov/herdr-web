#!/usr/bin/env bun
/**
 * Cross-implementation conformance check for herdr-agent-stream/1.
 *
 * Points this repo's client (src/server/agent-stream.ts) at another party's
 * implementation and reports per spec item. Written to be run against
 * one implementation, but it is implementation-agnostic — anything claiming proto 1
 * should pass.
 *
 *   bun tools/handshake.ts <pane_id>            # discovery via pane.get
 *   bun tools/handshake.ts --sock <path>        # direct, skips discovery
 */
import { lstatSync } from "node:fs";
import { detect, open, type StreamCapability } from "../src/server/agent-stream.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: Array<[string, boolean | "skip", string]> = [];
const check = (id: string, ok: boolean | "skip", detail = "") => {
  results.push([id, ok, detail]);
  const mark = ok === "skip" ? "skip" : ok ? " ok " : "FAIL";
  console.log(`  [${mark}] ${id}${detail ? ` — ${detail}` : ""}`);
};

const argv = process.argv.slice(2);
const sockFlag = argv.indexOf("--sock");
const paneId = sockFlag === -1 ? argv[0] : null;
const directSock = sockFlag === -1 ? null : argv[sockFlag + 1];

if (!paneId && !directSock) {
  console.error("usage: bun tools/handshake.ts <pane_id> | --sock <path>");
  process.exit(1);
}

// ---- a. discovery ----------------------------------------------------------
let cap: StreamCapability | null = null;
if (paneId) {
  cap = await detect(paneId);
  check("a. discovery via pane.get", !!cap,
    cap ? `proto=${cap.proto} fmt=${cap.fmt} session=${cap.session ?? "-"}` : "no tokens on pane");
  if (!cap) process.exit(1);
} else {
  cap = { proto: 1, sock: directSock!, fmt: "stream-json" };
  check("a. discovery via pane.get", "skip", "direct --sock");
}

// ---- b. socket hygiene -----------------------------------------------------
try {
  const st = lstatSync(cap.sock);
  const mode = (st.mode & 0o777).toString(8);
  const okUid = typeof process.getuid === "function" ? st.uid === process.getuid() : true;
  check("b. socket hygiene", st.isSocket() && !st.isSymbolicLink() && okUid && mode === "600",
    `socket=${st.isSocket()} symlink=${st.isSymbolicLink()} uid=${okUid} mode=${mode}`);
} catch (e: any) {
  check("b. socket hygiene", false, e.message);
}

// ---- c. hello -> ready, high-water seq -------------------------------------
const A: any[] = [];
const a = open(cap, { fromSeq: 0, client: "handshake/A" });
a.onFrame((f) => A.push(f));
a.onClose((r) => console.log(`     (A closed: ${r})`));
await sleep(1200);

const ready = A.find((f) => f.type === "ready");
check("c. hello -> ready", !!ready,
  ready ? `proto=${ready.proto} agent=${ready.agent} seq=${ready.seq} replay=${ready.replay}` : "no ready");

const framesAfterReady = A.filter((f) => f.type !== "ready");
check("c2. ready.seq is HIGH-WATER, not a frame position",
  !ready || framesAfterReady.length > 0 || ready.seq === 0,
  framesAfterReady.length
    ? `${framesAfterReady.length} frames arrived after ready(seq=${ready?.seq})`
    : "no frames replayed — if the agent has history, the client cursor ate it");

// ---- d. replay ordering ----------------------------------------------------
const seqs = A.filter((f) => f.type !== "ready" && typeof f.seq === "number").map((f) => f.seq);
const monotonic = seqs.every((v, i) => i === 0 || v > seqs[i - 1]);
const dupes = new Set(seqs).size !== seqs.length;
check("d. replay monotonic, no duplicates", monotonic && !dupes,
  seqs.length ? `${seqs.length} frames, seq ${seqs[0]}..${seqs[seqs.length - 1]}` : "empty history");

// ---- e. say ----------------------------------------------------------------
// A refusal is a CORRECT response, not a failure: an agent mid-turn must refuse
// rather than silently drop (PROTOCOL.md §4). Treat error{code:busy} as a pass
// for the frame contract and report it as such, rather than calling the
// implementation broken because the session happened to be working.
const before = A.length;
const sayId = a.say("handshake", "conformance probe: reply with anything");
await sleep(5000);
const after = A.slice(before);
const mine = after.find(
  (f) => f.type === "frame" && (f.author === "handshake" ||
    JSON.stringify(f.msg ?? {}).includes("conformance probe")));
const busy = after.find((f) => f.type === "error" && f.code === "busy");

if (busy) {
  check("e. say -> attributed user frame", "skip", "agent busy — see e2");
  check("e2. busy refused, not silently dropped", true,
    `code=${busy.code} ref=${busy.ref ?? "(none)"}${
      busy.ref && busy.ref === sayId ? " (matches say.id)" : ""}`);
  check("e3. error frame is NOT seq'd", busy.seq === undefined,
    busy.seq === undefined ? "no seq, correct" : `seq=${busy.seq} — should be absent`);
} else {
  check("e. say -> attributed user frame", !!mine,
    mine ? `author=${mine.author ?? "(none)"} seq=${mine.seq}` : "no echo and no error frame");
}

// ---- h. second subscriber + incremental replay -----------------------------
const B: any[] = [];
const b = open(cap, { fromSeq: 0, client: "handshake/B" });
b.onFrame((f) => B.push(f));
await sleep(1500);
const bFrames = B.filter((f) => f.type !== "ready").length;
check("h1. second concurrent subscriber", bFrames > 0, `${bFrames} frames replayed`);

const from = Math.max(0, a.lastSeq() - 2);
const C: any[] = [];
const c = open(cap, { fromSeq: from, client: "handshake/C" });
c.onFrame((f) => C.push(f));
await sleep(1500);
const cSeqs = C.filter((f) => f.type !== "ready" && typeof f.seq === "number").map((f) => f.seq);
check("h2. incremental replay honours from_seq+1",
  cSeqs.every((s) => s > from),
  `from_seq=${from} -> ${cSeqs.length} frames, min=${cSeqs[0] ?? "-"}`);

// ---- f/g. HITL + interrupt: only if the agent raises one -------------------
const perm = A.find((f) => f.type === "permission_request");
const ques = A.find((f) => f.type === "question_request");
check("f. HITL observed", !!(perm || ques) ? true : "skip",
  perm || ques ? `${perm ? "permission " : ""}${ques ? "question" : ""}`
               : "agent raised none during the probe — drive one manually");

a.interrupt("handshake");
await sleep(1200);
check("g. interrupt accepted (no disconnect)", A.every((f) => f.type !== "_closed"), "");

a.close(); b.close(); c.close();

const failed = results.filter(([, ok]) => ok === false);
console.log(`\n${failed.length ? `${failed.length} FAILED` : "all checks passed"} ` +
            `(${results.filter(([, o]) => o === true).length} ok, ` +
            `${results.filter(([, o]) => o === "skip").length} skipped)`);
process.exit(failed.length ? 1 : 0);
