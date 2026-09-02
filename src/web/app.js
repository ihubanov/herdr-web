// herdr web client. Layout mirrors the TUI: collapsible spaces/agents on the
// left, terminal as the main surface. The fleet grid is an overlay view you
// toggle to, and what you see before picking an agent.
const { Terminal } = window;
const FitAddon = window.FitAddon?.FitAddon || window.FitAddon;

const token = new URLSearchParams(location.search).get("token") || "";
const auth = (p) => `${p}${p.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
const $ = (id) => document.getElementById(id);

const el = {
  tree: $("tree"), search: $("search"), conn: $("conn"), crumb: $("crumb"),
  term: $("term"), fleet: $("fleet"), ctl: $("ctl"), ctlmeta: $("ctlmeta"),
  tstatus: $("tstatus"), takeover: $("takeover"), detach: $("detach"),
  askctx: $("askctx"), askq: $("askq"), presetrow: $("presetrow"),
  statusbar: $("statusbar"), whoami: $("whoami"),
  chatview: $("chatview"), msgs: $("msgs"), cin: $("cin"), cgo: $("cgo"),
  chatbtn: $("chatbtn"),
  frameview: $("frameview"), frame: $("frame"), framebtn: $("framebtn"),
  frameurl: $("frameurl"), framewho: $("framewho"), frameopen: $("frameopen"),
  divider: $("divider"), toggleside: $("toggleside"), fleetbtn: $("fleetbtn"), triage: $("triage"),
  newspace: $("newspace"), modal: $("modal"), mtitle: $("mtitle"), msub: $("msub"),
  mfields: $("mfields"), merr: $("merr"), mok: $("mok"), mcancel: $("mcancel"),
  me: $("me"), roster: $("roster"), chatq: $("chatq"),
  sound: $("sound"), help: $("help"), helpbox: $("helpbox"), badge: $("blockedbadge"),
};

const RANK = { blocked: 0, working: 1, idle: 2, unknown: 3 };
const LABEL = { blocked: "Blocked", working: "Working", idle: "Idle", unknown: "Other" };
const PRESETS = [
  { key: "1", label: "yes", text: "yes" },
  { key: "2", label: "continue", text: "continue" },
  { key: "3", label: "no", text: "no" },
  { key: "4", label: "explain", text: "explain what you are about to do and why" },
];

// Sidebar sizing. herdr's TUI stores columns (default 26, clamped 18-36) and
// lets you drag the divider; we keep the same feel but express it as a
// percentage of the viewport, with pixel guardrails so it stays usable at
// both phone and ultrawide widths.
const SIDEBAR_DEFAULT_PCT = 18;
const SIDEBAR_MIN_PCT = 10;
const SIDEBAR_MAX_PCT = 40;
const SIDEBAR_MIN_PX = 170;
const SIDEBAR_MAX_PX = 560;

const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

let fleet = [];
let selected = null;
let activeMode = "observe";
let termSock = null;
let query = "";
let cursor = 0;
let view = "fleet";                                   // "fleet" | "terminal"
let triageMode = LS.get("triage", false);
let soundOn = LS.get("sound", true);
let sidebarHidden = LS.get("sidebarHidden", false);
let sidebarPct = LS.get("sidebarPct", SIDEBAR_DEFAULT_PCT);
let closedSpaces = new Set(LS.get("closedSpaces", []));
let me = null;                    // {name,label,isAdmin,multiuser,users}
let presence = {};                // paneId -> [labels]
let queueState = [];              // recent queued/sent messages
let capability = null;            // structured-stream capability of the open pane

const esc = (s) => String(s ?? "").replace(/[&<>"]/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function ago(ms) {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d`;
}

// ------------------------------------------------------------------ terminal
const term = new Terminal({
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 13, theme: { background: "#0d1117", foreground: "#e6edf3" },
  cursorBlink: true, scrollback: 10000, allowProposedApi: true,
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(el.term);

function refit() {
  if (view !== "terminal") return;
  try { fit.fit(); } catch {}
  if (termSock?.readyState === 1)
    termSock.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
}
let rt = null;
addEventListener("resize", () => {
  clearTimeout(rt);
  rt = setTimeout(() => { applySidebarWidth(sidebarPct, false); refit(); }, 110);
});

/**
 * Scrolling.
 *
 * There is no client-side scrollback to scroll: the stream sends the pane's
 * CURRENT rendered viewport, not its history. Scrolling therefore has to happen
 * server-side, and that splits by pane type:
 *
 *   - shell-like panes have herdr scrollback  -> terminal.scroll moves it
 *   - alt-screen agents (Claude Code &c) have none; the app owns its own
 *     scrolling and reads the wheel as mouse input, which xterm forwards
 *
 * Both need input to flow, so both require control mode. In observe mode we say
 * so rather than swallowing the gesture silently.
 */
let scrollHintAt = 0;
el.term.addEventListener("wheel", (ev) => {
  if (!termSock || termSock.readyState !== 1) return;
  if (activeMode !== "control") {
    // Don't nag on every notch.
    if (Date.now() - scrollHintAt > 2500) {
      scrollHintAt = Date.now();
      el.tstatus.textContent = "read-only — take control to scroll";
    }
    return;
  }
  // When the app has mouse tracking on, xterm already forwards the wheel as
  // mouse input; sending terminal.scroll too would double-scroll.
  if (term.modes?.mouseTrackingMode && term.modes.mouseTrackingMode !== "none") return;
  const lines = Math.max(1, Math.min(20, Math.round(Math.abs(ev.deltaY) / 40) || 3));
  termSock.send(JSON.stringify({
    type: "scroll", direction: ev.deltaY < 0 ? "up" : "down", lines,
  }));
  ev.preventDefault();
}, { passive: false });

/**
 * Attribution is applied by the BRIDGE, not here (see forwardInput in
 * src/server/bridge.ts). The browser forwards raw keystrokes; the server
 * injects "<user>: " from the authenticated identity and refuses backspaces
 * that would eat it. Doing it client-side would let a client type as someone
 * else and let the user delete the prefix.
 *
 * What this file owns is the DISPLAY: a "typing as <you>" badge in the control
 * bar. It deliberately does NOT sit in or beside the terminal — anything there
 * costs columns, and the terminal is the product.
 */
term.onData((d) => {
  if (termSock?.readyState !== 1) return;

  if (activeMode !== "control") {
    const f = entry(selected);
    if (!f) return;
    el.tstatus.textContent = "taking control…";
    attach(f, "control");
    const pending = d;
    setTimeout(() => {
      if (activeMode === "control" && termSock?.readyState === 1) termSock.send(pending);
    }, 900);
    return;
  }
  termSock.send(d);
});

/** Badge follows the cursor row so it reads as a prompt label. */
/** "typing as <you>" in the control bar — costs the terminal no columns. */
function positionWhoami() {
  const show = !!(me?.multiuser && me.label && selected);
  el.whoami.classList.toggle("on", show);
  if (show) {
    el.whoami.textContent = `typing as ${me.label}`;
    el.whoami.title = "Your name is added to each line you send";
  }
}


function entry(id) { return fleet.find((f) => f.pane_id === id) || null; }

function attach(f, mode = "observe") {
  if (!f) return;
  closeChat();
  closeFrame();
  if (termSock) { try { termSock.close(); } catch {} termSock = null; }
  selected = f.pane_id;
  activeMode = mode;
  setView("terminal");
  el.crumb.innerHTML = `<b>${esc(f.title)}</b>${f.task ? ` — ${esc(f.task)}` : ""}`;
  el.ctlmeta.textContent = [f.repo, f.branch, f.cwd].filter(Boolean).join("  ·  ");
  el.ctl.classList.add("on");
  positionWhoami();

  // Ask once per open whether this agent exposes herdr-agent-stream/1.
  capability = null;
  el.chatbtn.style.display = "none";
  fetch(auth(`/api/capability?pane_id=${encodeURIComponent(f.pane_id)}`))
    .then((r) => r.json())
    .then((c) => {
      if (selected !== f.pane_id) return;         // user moved on
      capability = c;
      el.chatbtn.style.display = c?.stream ? "inline-block" : "none";
      el.chatbtn.title = c?.stream
        ? "Message-level chat with per-message attribution"
        : "";

      el.framebtn.style.display = c?.iframe ? "inline-block" : "none";
      el.framebtn.title = c?.iframe ? `Embedded view: ${c.iframe.url}` : "";
      // A rejected advertisement is worth saying out loud: an agent asked to
      // show something and policy refused, which is otherwise invisible.
      if (c?.iframeRejected) {
        console.warn(`herdr-web: iframe refused — ${c.iframeRejected}`);
        el.tstatus.textContent = `view blocked (${c.iframePolicy})`;
      }
    })
    .catch(() => {});
  el.tstatus.textContent = "attaching…";
  term.reset();
  renderTree();
  renderChat();
  updateTitle();

  const ws = new WebSocket(
    `ws://${location.host}${auth(`/ws/terminal/${encodeURIComponent(f.pane_id)}`)}`);
  ws.binaryType = "arraybuffer";
  termSock = ws;
  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) { term.write(new Uint8Array(e.data)); return; }
    let m = null;
    try { m = JSON.parse(e.data); } catch { term.write(e.data); return; }
    if (m.type === "_ready") {
      try { fit.fit(); } catch {}
      ws.send(JSON.stringify({ type: "init", cols: term.cols, rows: term.rows, mode }));
    } else if (m.type === "_attached") {
      activeMode = m.mode;
      el.tstatus.textContent = m.mode === "control" ? "control — type in the terminal" : "read-only";
      renderCtl();
      renderChat();
      positionWhoami();
      setTimeout(refit, 60);
    } else if (m.type === "_prefix_locked") {
      el.tstatus.textContent = `${me?.label ?? "you"}: — attribution is locked`;
      setTimeout(() => { if (activeMode === "control") el.tstatus.textContent = "control — type in the terminal"; }, 1600);
    } else if (m.type === "_readonly") {
      el.tstatus.textContent = "read-only — click take control";
    } else if (m.type === "_closed") {
      el.tstatus.textContent = `closed: ${m.reason}`;
    }
  };
  ws.onclose = () => renderCtl();
  ws.onerror = () => { el.tstatus.textContent = "socket error"; };
}

function detach() {
  closeChat();
  closeFrame();
  capability = null;
  el.chatbtn.style.display = "none";
  el.framebtn.style.display = "none";
  if (termSock) { try { termSock.close(); } catch {} termSock = null; }
  selected = null; activeMode = "observe";
  el.ctl.classList.remove("on");
  el.crumb.textContent = "no pane selected";
  term.reset();
  setView("fleet");
  renderTree(); renderChat(); updateTitle();
}

function renderCtl() {
  el.takeover.disabled = !selected || activeMode === "control";
  el.takeover.textContent = activeMode === "control" ? "controlling" : "take control";
}
el.takeover.onclick = () => { const f = entry(selected); if (f) attach(f, "control"); };
el.detach.onclick = detach;

// ------------------------------------------------------------------ views
function setView(v) {
  view = v;
  el.fleet.classList.toggle("on", v === "fleet");
  el.term.classList.toggle("hidden", v !== "terminal");
  el.chatview.classList.toggle("on", v === "chat");
  el.frameview.classList.toggle("on", v === "frame");
  el.framebtn.classList.toggle("on", v === "frame");
  el.fleetbtn.classList.toggle("on", v === "fleet");
  el.chatbtn.classList.toggle("on", v === "chat");
  if (v === "terminal") setTimeout(refit, 40);
  else renderFleet();
  renderChat();
}
function toggleView() { setView(view === "fleet" ? "terminal" : "fleet"); }

function clampSidebarPct(pct) {
  const w = window.innerWidth || 1280;
  let p = Math.min(SIDEBAR_MAX_PCT, Math.max(SIDEBAR_MIN_PCT, pct));
  // Re-clamp against pixel bounds so the percentage stays sane at extremes.
  const px = (p / 100) * w;
  if (px < SIDEBAR_MIN_PX) p = Math.min(SIDEBAR_MAX_PCT, (SIDEBAR_MIN_PX / w) * 100);
  if (px > SIDEBAR_MAX_PX) p = Math.max(SIDEBAR_MIN_PCT, (SIDEBAR_MAX_PX / w) * 100);
  return Math.round(p * 100) / 100;
}

function applySidebarWidth(pct, persist = true) {
  sidebarPct = clampSidebarPct(pct);
  document.documentElement.style.setProperty("--sidebar", `${sidebarPct}%`);
  if (persist) LS.set("sidebarPct", sidebarPct);
}

// Drag the divider, like the TUI's sidebar divider.
(function initDivider() {
  let dragging = false;
  const onMove = (ev) => {
    if (!dragging) return;
    const x = (ev.touches ? ev.touches[0].clientX : ev.clientX);
    applySidebarWidth((x / (window.innerWidth || 1280)) * 100, false);
    ev.preventDefault();
  };
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("dragging");
    LS.set("sidebarPct", sidebarPct);
    refit();
  };
  const start = (ev) => {
    if (sidebarHidden) return;
    dragging = true;
    document.body.classList.add("dragging");
    ev.preventDefault();
  };
  el.divider.addEventListener("mousedown", start);
  el.divider.addEventListener("touchstart", start, { passive: false });
  addEventListener("mousemove", onMove);
  addEventListener("touchmove", onMove, { passive: false });
  addEventListener("mouseup", stop);
  addEventListener("touchend", stop);
  el.divider.addEventListener("dblclick", () => { applySidebarWidth(SIDEBAR_DEFAULT_PCT); refit(); });
})();

function setSidebar(hidden) {
  sidebarHidden = hidden;
  LS.set("sidebarHidden", hidden);
  document.body.classList.toggle("collapsed", hidden);
  setTimeout(refit, 180);
}
el.toggleside.onclick = () => setSidebar(!sidebarHidden);
el.fleetbtn.onclick = toggleView;
el.framebtn.onclick = () => {
  if (view === "frame") { closeFrame(); setView("terminal"); }
  else if (selected && capability?.iframe) openFrame(capability.iframe.url);
};

/**
 * Show an agent-advertised URL. The frame is sandboxed and must be a different
 * origin than this page — the bridge enforces that, since `allow-same-origin`
 * on a same-origin frame would let it drop its own sandbox and read our token.
 */
function openFrame(url) {
  el.frame.src = url;
  el.frameurl.textContent = url;
  const f = entry(selected);
  el.framewho.textContent = f ? `from ${f.title}` : "";
  setView("frame");
}
function closeFrame() {
  el.frame.src = "about:blank";
  el.frameurl.textContent = "";
}
el.frameopen.onclick = () => {
  if (capability?.iframe) window.open(capability.iframe.url, "_blank", "noopener,noreferrer");
};

el.chatbtn.onclick = () => {
  if (view === "chat") { closeChat(); setView("terminal"); }
  else if (selected && chatAvailable()) openChat(selected);
};
el.triage.onclick = () => { triageMode = !triageMode; LS.set("triage", triageMode); setView("fleet"); renderAll(); };
el.sound.onclick = () => { soundOn = !soundOn; LS.set("sound", soundOn); el.sound.classList.toggle("on", soundOn); };
el.help.onclick = () => el.helpbox.classList.toggle("on");
el.helpbox.onclick = () => el.helpbox.classList.remove("on");
el.badge.onclick = () => { triageMode = true; LS.set("triage", true); setView("fleet"); renderAll(); };

// ------------------------------------------------------------------ sidebar
function matches(f) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [f.title, f.task, f.repo, f.branch, f.cwd, f.agent, f.workspace_label]
    .filter(Boolean).some((v) => String(v).toLowerCase().includes(q));
}
function visible() { return fleet.filter(matches); }

function renderTree() {
  const items = visible();
  if (!items.length) {
    el.tree.innerHTML = `<div class="sb-empty">${fleet.length ? "no match" : "no panes"}</div>`;
    return;
  }
  const spaces = new Map();
  for (const f of items) {
    if (!spaces.has(f.workspace_id)) spaces.set(f.workspace_id, { label: f.workspace_label, list: [] });
    spaces.get(f.workspace_id).list.push(f);
  }
  el.tree.innerHTML = [...spaces.entries()].map(([wsId, s]) => {
    s.list.sort((a, b) => RANK[a.agent_status] - RANK[b.agent_status] || a.since - b.since);
    const nBlocked = s.list.filter((f) => f.agent_status === "blocked").length;
    const closed = closedSpaces.has(wsId);
    return `<div class="space${closed ? " closed" : ""}" data-ws="${esc(wsId)}">
      <div class="space-head"><span class="caret">▼</span>${esc(s.label)}
        <span class="n">${nBlocked ? `<span style="color:var(--blocked)">${nBlocked}!</span> ` : ""}${s.list.length}</span>
        <button class="act" data-newtab="${esc(wsId)}" title="New session here">+</button>
        <button class="act" data-renws="${esc(wsId)}" data-name="${esc(s.label)}" title="Rename space">✎</button>
        ${me?.canDestroy ? `<button class="act danger" data-closews="${esc(wsId)}" data-name="${esc(s.label)}" title="Close space">✕</button>` : ""}
      </div>
      <div class="space-body">${s.list.map((f) => `
        <div class="item ${f.agent_status}${selected === f.pane_id ? " sel" : ""}"
             data-id="${esc(f.pane_id)}" title="${esc(f.cwd)}">
          <span class="dot ${f.agent_status}"></span>
          <span class="nm">${esc(f.title)}</span>
          <span class="t" data-since="${f.since}">${ago(f.since)}</span>
          <button class="act" data-rentab="${esc(f.tab_id || "")}" data-name="${esc(f.title)}" title="Rename">✎</button>
          ${me?.canDestroy ? `<button class="act danger" data-closetab="${esc(f.tab_id || "")}" data-name="${esc(f.title)}" title="Close session">✕</button>` : ""}
        </div>`).join("")}</div>
    </div>`;
  }).join("");

  el.tree.querySelectorAll(".space-head").forEach((h) => {
    h.onclick = () => {
      const id = h.parentElement.dataset.ws;
      closedSpaces.has(id) ? closedSpaces.delete(id) : closedSpaces.add(id);
      LS.set("closedSpaces", [...closedSpaces]);
      renderTree();
    };
  });
  el.tree.querySelectorAll(".item").forEach((it) => {
    it.onclick = (ev) => {
      if (ev.target.closest(".act")) return;   // action buttons are not "open"
      attach(entry(it.dataset.id), "observe");
    };
  });
  const stop = (fn) => (ev) => { ev.stopPropagation(); fn(ev.currentTarget.dataset); };
  el.tree.querySelectorAll("[data-newtab]").forEach((b) =>
    b.onclick = stop((d) => newSession(d.newtab)));
  el.tree.querySelectorAll("[data-renws]").forEach((b) =>
    b.onclick = stop((d) => renameThing("space", d.renws, d.name)));
  el.tree.querySelectorAll("[data-closews]").forEach((b) =>
    b.onclick = stop((d) => closeThing("space", d.closews, d.name)));
  el.tree.querySelectorAll("[data-rentab]").forEach((b) =>
    b.onclick = stop((d) => renameThing("session", d.rentab, d.name)));
  el.tree.querySelectorAll("[data-closetab]").forEach((b) =>
    b.onclick = stop((d) => closeThing("session", d.closetab, d.name)));
  applyCursor();
}

// ------------------------------------------------------------------ fleet
function cardHTML(f) {
  const b = f.agent_status === "blocked";
  return `<div class="card ${f.agent_status}${selected === f.pane_id ? " sel" : ""}"
               data-id="${esc(f.pane_id)}">
    <div class="row1"><span class="title">${esc(f.title)}</span>
      ${f.agent ? `<span class="badge">${esc(f.agent)}</span>` : ""}
      <span class="time" data-since="${f.since}">${ago(f.since)}</span></div>
    ${f.task ? `<div class="task">${esc(f.task)}</div>` : ""}
    <div class="row2">
      ${f.repo ? `<span class="repo">${esc(f.repo)}</span>` : ""}
      ${f.branch ? `<span class="branch">${esc(f.branch)}</span>` : ""}
      <span class="path">${esc(f.cwd)}</span></div>
    ${b && f.preview?.length ? `<div class="preview">${f.preview.map(esc).join("\n")}</div>` : ""}
    ${b ? `<div class="presets">${PRESETS.map((p) =>
      `<button class="preset" data-preset="${esc(f.pane_id)}" data-text="${esc(p.text)}">${esc(p.label)}</button>`
    ).join("")}</div>` : ""}
  </div>`;
}

function renderFleet() {
  if (view !== "fleet") return;
  document.body.classList.toggle("triage", triageMode);
  el.triage.classList.toggle("on", triageMode);
  const items = visible();
  if (triageMode && !items.some((f) => f.agent_status === "blocked")) {
    el.fleet.innerHTML = `<div class="triage-empty"><b>All clear</b>No agent is waiting on you.</div>`;
    return;
  }
  if (!items.length) {
    el.fleet.innerHTML = `<div class="empty">${fleet.length ? "no match" : "no panes"}</div>`;
    return;
  }
  const g = new Map();
  for (const f of items) { if (!g.has(f.agent_status)) g.set(f.agent_status, []); g.get(f.agent_status).push(f); }
  el.fleet.innerHTML = [...g.keys()].sort((a, b) => RANK[a] - RANK[b]).map((st) =>
    `<div class="section-label${st === "blocked" ? " b" : ""}">${LABEL[st]} · ${g.get(st).length}</div>
     <div class="grid">${g.get(st).map(cardHTML).join("")}</div>`).join("");

  el.fleet.querySelectorAll(".card").forEach((c) => {
    c.onclick = (ev) => { if (ev.target.closest(".presets")) return; attach(entry(c.dataset.id), "observe"); };
  });
  el.fleet.querySelectorAll("[data-preset]").forEach((b) => {
    b.onclick = (ev) => { ev.stopPropagation(); send(b.dataset.preset, b.dataset.text, b); };
  });
  applyCursor();
}

function renderAll() {
  renderTree(); renderFleet(); renderBadge(); renderCtl(); renderChat(); updateTitle();
}

/**
 * Browser tab title. Ordered by what you need to notice without looking:
 *
 *   (2) alice · api-refactor
 *    ^      ^            ^
 *    |      |            what this tab is showing
 *    |      who this tab is signed in as (several people, several tabs)
 *    blocked agents needing a human — the whole point of the fleet view
 *
 * Blocked count leads because tabs truncate from the RIGHT, so anything at the
 * end is the first thing lost when tabs get narrow.
 */
function updateTitle() {
  const blocked = fleet.filter((f) => f.agent_status === "blocked").length;
  const working = fleet.filter((f) => f.agent_status === "working").length;
  const who = me?.multiuser ? me.label : null;

  const here = selected ? entry(selected) : null;
  let what;
  if (here) what = here.title;
  else if (blocked) what = `${blocked} blocked`;
  else if (working) what = `${working} working`;
  else what = me?.agentName || "herdr";

  document.title = `${blocked ? `(${blocked}) ` : ""}${who ? `${who} · ` : ""}${what}`;
}

function renderBadge() {
  const n = fleet.filter((f) => f.agent_status === "blocked").length;
  el.badge.classList.toggle("on", n > 0);
  el.badge.textContent = `${n} blocked`;
}

async function send(paneId, text, btn, clearInput) {
  if (!text?.trim()) return;
  const old = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "…"; }
  try {
    const r = await fetch(auth("/api/reply"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pane_id: paneId, text }),
    });
    if (!r.ok) throw new Error((await r.json()).error || r.statusText);
    if (clearInput) { /* the terminal is the input now */ }
    if (btn) btn.textContent = "sent";
  } catch (err) {
    if (btn) btn.textContent = "failed";
    console.error("reply failed:", err);
  } finally {
    setTimeout(() => { if (btn) { btn.disabled = false; btn.textContent = old; } }, 1100);
  }
}

// ------------------------------------------------------------------ rpc + modal
async function rpc(method, params) {
  const r = await fetch(auth("/api/rpc"), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(body?.error?.message || body?.error || r.statusText);
    e.adminOnly = !!body?.adminOnly;
    throw e;
  }
  return body.result;
}

let modalOK = null;
function openModal({ title, sub, fields, okLabel = "create", danger = false, onOK }) {
  el.mtitle.textContent = title;
  el.msub.textContent = sub || "";
  el.merr.textContent = "";
  el.mok.textContent = okLabel;
  el.mok.classList.toggle("danger", danger);
  el.mfields.innerHTML = (fields || []).map((f) =>
    `<label for="f_${f.k}">${esc(f.label)}</label>
     <input id="f_${f.k}" value="${esc(f.value ?? "")}" placeholder="${esc(f.placeholder ?? "")}" />`
  ).join("");
  modalOK = async () => {
    const vals = {};
    for (const f of fields || []) vals[f.k] = document.getElementById(`f_${f.k}`).value.trim();
    el.mok.disabled = true;
    try {
      await onOK(vals);
      closeModal();
      await loadFleet(true);
    } catch (err) {
      el.merr.textContent = err.adminOnly
        ? "admin only — ask whoever holds the admin token"
        : (err.message || "failed");
    } finally {
      el.mok.disabled = false;
    }
  };
  el.modal.classList.add("on");
  const first = el.mfields.querySelector("input");
  if (first) setTimeout(() => { first.focus(); first.select(); }, 30);
}
function closeModal() { el.modal.classList.remove("on"); modalOK = null; }
el.mok.onclick = () => modalOK?.();
el.mcancel.onclick = closeModal;
el.modal.onclick = (e) => { if (e.target === el.modal) closeModal(); };

// ---- structure actions ------------------------------------------------------
function spaceOf(wsId) { return fleet.find((f) => f.workspace_id === wsId); }

function newSession(wsId) {
  const ref = spaceOf(wsId);
  openModal({
    title: "New session",
    sub: `A new tab in ${ref?.workspace_label ?? wsId}. It starts a shell in this directory; run your agent there.`,
    fields: [
      { k: "cwd", label: "working directory", value: ref?.cwd || "", placeholder: "/path/to/repo" },
      { k: "label", label: "name (optional)", value: "", placeholder: "leave blank to auto-name" },
      { k: "cmd", label: "launch command (optional)", value: me?.defaultLaunchCmd || "",
        placeholder: "leave blank for a shell" },
    ],
    onOK: async (v) => {
      if (!v.cwd) throw new Error("working directory is required");
      const res = await rpc("tab.create", {
        workspace_id: wsId, cwd: v.cwd, label: v.label || null, focus: false,
      });
      if (!v.cmd) return;
      // herdr cannot spawn a command as the pane's foreground directly, so run
      // it in the fresh shell. An `exec` in the command replaces that shell,
      // which is what keeps the agent (not bash) as the foreground process.
      const paneId = res?.root_pane?.pane_id ?? res?.pane?.pane_id;
      if (!paneId) return;
      await new Promise((r) => setTimeout(r, 1500));   // let the shell come up
      await rpc("pane.send_input", { pane_id: paneId, text: v.cmd, keys: ["enter"] });
    },
  });
}

function newSpace() {
  const ref = fleet[0];
  openModal({
    title: "New space",
    sub: "A workspace groups related sessions.",
    fields: [
      { k: "label", label: "name", value: "", placeholder: "e.g. Payments" },
      { k: "cwd", label: "working directory", value: ref?.cwd || "", placeholder: "/path/to/repo" },
    ],
    onOK: async (v) => {
      if (!v.label) throw new Error("name is required");
      await rpc("workspace.create", { label: v.label, cwd: v.cwd || null, focus: false });
    },
  });
}

function renameThing(kind, id, current) {
  openModal({
    title: `Rename ${kind}`,
    sub: current ? `Currently "${current}".` : "",
    okLabel: "rename",
    fields: [{ k: "label", label: "new name", value: current || "" }],
    onOK: async (v) => {
      if (!v.label) throw new Error("name is required");
      if (kind === "space") await rpc("workspace.rename", { workspace_id: id, label: v.label });
      else await rpc("tab.rename", { tab_id: id, label: v.label });
    },
  });
}

function closeThing(kind, id, name) {
  openModal({
    title: `Close ${kind}`,
    sub: `"${name}" and anything running in it will be terminated. This cannot be undone.`,
    okLabel: `close ${kind}`, danger: true, fields: [],
    onOK: async () => {
      if (kind === "space") await rpc("workspace.close", { workspace_id: id });
      else await rpc("tab.close", { tab_id: id });
      if (selected && !fleet.some((f) => f.pane_id === selected)) detach();
    },
  });
}
el.newspace.onclick = newSpace;

// ------------------------------------------------------------------ group chat
/**
 * Exactly ONE input is live at a time.
 *
 * Two ways to type into the same pane is confusing, and worse, they behave
 * differently: the composer is attributed ("alice: …") and queued; raw
 * terminal keystrokes are neither. So the composer is the input in read-only
 * mode, and taking control replaces it with the terminal itself.
 *
 * Intercepting terminal keystrokes to attribute them was the alternative. It
 * does not work: the agent's TUI owns line editing (history, arrows, tab
 * completion, multiline), so a JS interceptor would have to suppress the
 * agent's echo and reimplement its input line — and the result of doing that
 * properly IS the composer.
 */
function renderChat() {
  const on = view === "terminal" && !!selected;
  if (view === "chat") { el.askctx.classList.remove("on"); el.statusbar.classList.add("on"); }
  const f = on ? entry(selected) : null;
  const blocked = f?.agent_status === "blocked";

  // Question context + presets sit ABOVE the terminal, next to the question.
  el.askctx.classList.toggle("on", !!(blocked && f?.preview?.length));
  if (blocked && f?.preview?.length) el.askq.textContent = f.preview.join("\n");
  el.presetrow.innerHTML = blocked
    ? PRESETS.map((p) => `<button class="preset" data-text="${esc(p.text)}">${esc(p.label)}</button>`).join("")
    : "";
  el.presetrow.querySelectorAll(".preset").forEach((b) => {
    b.onclick = () => send(selected, b.dataset.text, b);
  });

  // Thin strip under the terminal: who else is here, and queue state.
  el.statusbar.classList.toggle("on", on);
  if (!on) return;
  const here = presence[selected] || [];
  const mine = me?.label;
  const chips = here.map((w) =>
    `<span class="who${w === mine ? " me" : ""}">${esc(w)}</span>`);
  // Mark the agent explicitly: in a roster of names, "bob Alice" gives no clue
  // which participant is the human and which is the model.
  if (me?.agentName) {
    chips.push(`<span class="who agent" title="AI agent in this pane">` +
               `${esc(me.agentName)}<span class="ai">(AI)</span></span>`);
  }
  el.roster.innerHTML = chips.length
    ? "here: " + chips.join(" ")
    : "you are the only one here";

  const q = queueState.filter((m) => m.paneId === selected);
  const waiting = q.filter((m) => m.state === "queued" || m.state === "sending");
  const failed = q.filter((m) => m.state === "failed");
  el.chatq.innerHTML = [
    waiting.length ? `<span class="q">${waiting.length} queued</span>` : "",
    failed.length ? `<span class="f">${failed.length} failed</span>` : "",
  ].filter(Boolean).join(" · ");
  setTimeout(refit, 30);
}


// ------------------------------------------------------------------ keyboard
function navItems() {
  return view === "fleet"
    ? [...el.fleet.querySelectorAll(".card")]
    : [...el.tree.querySelectorAll(".item")];
}
function applyCursor() {
  const n = navItems();
  if (!n.length) return;
  cursor = Math.max(0, Math.min(cursor, n.length - 1));
  n.forEach((x, i) => x.classList.toggle("cursor", i === cursor));
}
function move(d) {
  const n = navItems();
  if (!n.length) return;
  cursor = (cursor + d + n.length) % n.length;
  applyCursor();
  n[cursor].scrollIntoView({ block: "nearest" });
}
function cursorEntry() { const n = navItems()[cursor]; return n ? entry(n.dataset.id) : null; }

addEventListener("keydown", (e) => {
  const inField = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || "");
  const inTerm = !!document.activeElement?.closest("#term");

  if (e.key === "Escape") {
    if (el.modal.classList.contains("on")) return closeModal();
    if (el.helpbox.classList.contains("on")) return el.helpbox.classList.remove("on");
    if (inField || inTerm) { document.activeElement.blur(); el.tstatus.textContent === "" || 0; }
    return;
  }
  if (inField || inTerm) return;          // never steal keys from the terminal
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  switch (e.key) {
    case "j": move(1); e.preventDefault(); return;
    case "k": move(-1); e.preventDefault(); return;
    case "b": setSidebar(!sidebarHidden); e.preventDefault(); return;
    case "g": toggleView(); e.preventDefault(); return;
    case "t": el.triage.click(); e.preventDefault(); return;
    case "s": el.sound.click(); e.preventDefault(); return;
    case "?": el.helpbox.classList.toggle("on"); e.preventDefault(); return;
    case "/": el.search.focus(); e.preventDefault(); return;
    case "m": if (selected) { term.focus(); e.preventDefault(); } return;
    case "n": {
      const ws = entry(selected)?.workspace_id || fleet[0]?.workspace_id;
      if (ws) { newSession(ws); e.preventDefault(); }
      return;
    }
    case "N": newSpace(); e.preventDefault(); return;
    case "Enter": { const f = cursorEntry(); if (f) attach(f, "observe"); e.preventDefault(); return; }
    case "r": {
      const f = entry(selected) || cursorEntry();
      if (f?.agent_status === "blocked") { attach(f, "observe"); setTimeout(() => term.focus(), 200); e.preventDefault(); }
      return;
    }
    default: {
      const p = PRESETS.find((x) => x.key === e.key);
      if (!p) return;
      const f = entry(selected) || cursorEntry();
      if (f?.agent_status === "blocked") { send(f.pane_id, p.text, null); e.preventDefault(); }
    }
  }
});

setInterval(() => {
  document.querySelectorAll("[data-since]").forEach((n) => {
    n.textContent = ago(Number(n.dataset.since));
  });
}, 1000);

// ------------------------------------------------------------------ alerting
let audioCtx = null;
function beep() {
  if (!soundOn) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const t = audioCtx.currentTime, o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(660, t); o.frequency.setValueAtTime(880, t + 0.11);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    o.connect(g).connect(audioCtx.destination); o.start(t); o.stop(t + 0.34);
  } catch {}
}

let notifyReady = "Notification" in window && Notification.permission === "granted";
if ("Notification" in window && Notification.permission === "default") {
  addEventListener("click", function once() {
    Notification.requestPermission().then(() => { notifyReady = Notification.permission === "granted"; });
    removeEventListener("click", once);
  }, { once: true });
}

let prev = new Map();
function alertBlocked(next) {
  for (const f of next) {
    const was = prev.get(f.pane_id);
    if (was && was !== "blocked" && f.agent_status === "blocked") {
      beep();
      if (notifyReady) {
        const n = new Notification("Agent blocked", {
          body: `${f.title}${f.repo ? ` · ${f.repo}` : ""}`, tag: f.pane_id,
        });
        n.onclick = () => { window.focus(); attach(entry(f.pane_id), "observe"); n.close(); };
      }
    }
  }
  prev = new Map(next.map((f) => [f.pane_id, f.agent_status]));
}

// ------------------------------------------------------------------ data
el.search.oninput = () => { query = el.search.value; cursor = 0; renderAll(); };
el.search.onkeydown = (e) => { if (e.key === "Escape") { el.search.value = ""; query = ""; el.search.blur(); renderAll(); } e.stopPropagation(); };

async function loadMe() {
  try {
    const r = await fetch(auth("/api/whoami"));
    if (!r.ok) return;
    me = await r.json();
    if (me.agentName) {
      const brand = document.querySelector(".brand");
      if (brand) brand.textContent = me.agentName;
    }
    el.me.textContent = me.multiuser ? me.label : "";
    updateTitle();
    el.me.title = me.multiuser
      ? `signed in as ${me.label}${me.isAdmin ? " (admin)" : ""}`
      : "single-operator mode";
    renderChat();
  } catch {}
}

async function loadFleet(force = false) {
  try {
    // After a structure change the resident snapshot can still be pre-change,
    // so force a re-read rather than showing the thing you just deleted.
    const r = await fetch(auth(force ? "/api/fleet?refresh=1" : "/api/fleet"));
    if (!r.ok) return;
    fleet = (await r.json()).fleet || [];
    renderAll();
  } catch {}
}

function connectEvents() {
  const ws = new WebSocket(`ws://${location.host}${auth("/ws/events")}`);
  ws.onopen = () => { el.conn.className = "live"; el.conn.textContent = "live"; };
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.event === "fleet") { fleet = m.data.fleet || []; alertBlocked(fleet); renderAll(); }
    else if (m.event === "presence") { presence = m.data.presence || {}; renderChat(); }
    else if (m.event === "queue") {
      const msg = m.data.message;
      queueState = [msg, ...queueState.filter((x) => x.id !== msg.id)].slice(0, 40);
      renderChat();
    }
  };
  ws.onclose = () => {
    el.conn.className = "down"; el.conn.textContent = "reconnecting…";
    setTimeout(connectEvents, 2000);
  };
}

window.__herdrDebug = {
  setFleet(f) { fleet = f; renderAll(); },
  getFleet: () => fleet,
  // Exposed so the input path can be exercised without synthesising browser
  // key events, which do not reliably reach xterm's own handlers.
  term, mode: () => activeMode,
};

applySidebarWidth(sidebarPct, false);
document.body.classList.toggle("collapsed", sidebarHidden);
el.sound.classList.toggle("on", soundOn);
setView("fleet");
loadMe();
loadFleet();
connectEvents();

// ================================================================== chat view
//
// Renders herdr-agent-stream/1 frames as a conversation. This is the only view
// that can badge individual messages: the terminal is a character grid the
// agent paints, so the bridge cannot tell one message from another there, but
// a frame arrives with an author attached.
//
let streamSock = null;
let streamPane = null;
const seenReq = new Map();          // request_id -> resolved?

function chatAvailable() { return !!capability?.stream; }

function openChat(paneId) {
  closeChat();
  streamPane = paneId;
  lastSpeaker = null;
  el.msgs.innerHTML = `<div class="sys">connecting to the agent stream…</div>`;
  setView("chat");

  const ws = new WebSocket(
    `ws://${location.host}${auth(`/ws/stream/${encodeURIComponent(paneId)}`)}`);
  streamSock = ws;
  ws.onmessage = (e) => {
    let f; try { f = JSON.parse(e.data); } catch { return; }
    handleFrame(f);
  };
  ws.onclose = () => { if (view === "chat") appendSys("stream closed"); };
  ws.onerror = () => appendSys("stream error");
}

function closeChat() {
  if (streamSock) { try { streamSock.close(); } catch {} streamSock = null; }
  streamPane = null;
  seenReq.clear();
}

function appendSys(text) {
  const d = document.createElement("div");
  d.className = "sys";
  d.textContent = text;
  el.msgs.appendChild(d);
  scrollMsgs();
}

function scrollMsgs() { el.msgs.scrollTop = el.msgs.scrollHeight; }

let lastSpeaker = null;          // suppress a repeated badge on the same speaker

function speakerOf(author, isAgent) {
  return isAgent ? `agent:${me?.agentName || "agent"}` : `user:${author || "user"}`;
}

function avatarHTML(author, isAgent, repeat) {
  const label = isAgent ? `${esc(me?.agentName || "agent")}(AI)` : esc(author || "user");
  return `<span class="av${repeat ? " blank" : ""}">${label}</span>`;
}

/**
 * One rendered line. The badge is drawn only when the speaker changes — an
 * agent turn is often a dozen frames (thinking, tool call, result, text) and
 * stamping every one of them was the main source of noise.
 */
function msgBlock(author, isAgent, innerHTML) {
  const who = speakerOf(author, isAgent);
  const repeat = who === lastSpeaker;
  lastSpeaker = who;
  const mine = !isAgent && author === me?.label;
  const d = document.createElement("div");
  d.className = `msg ${isAgent ? "agent" : "user"}${mine ? " me" : ""}${repeat ? "" : " turn"}`;
  d.innerHTML = `${avatarHTML(author, isAgent, repeat)}<div class="body">${innerHTML}</div>`;
  el.msgs.appendChild(d);
  scrollMsgs();
  return d;
}

/** Long output is clamped; clicking expands it. */
function clamped(html, cls) {
  const id = `c${Math.random().toString(36).slice(2, 8)}`;
  return `<div class="${cls} clamp" data-clamp="${id}">${html}</div>`;
}
el.msgs.addEventListener("click", (e) => {
  const c = e.target.closest(".clamp");
  if (c && !c.classList.contains("open")) c.classList.add("open");
});

/**
 * The interesting part of a tool call is the command, not the envelope.
 * `Bash({"command":"ls -la","description":"..."})` is how the frame arrives;
 * `Bash ls -la` is what a person reading a terminal wants to see.
 */
const TOOL_ARG = {
  Bash: (i) => i.command,
  Read: (i) => i.file_path,
  Write: (i) => i.file_path,
  Edit: (i) => i.file_path,
  Glob: (i) => i.pattern,
  Grep: (i) => [i.pattern, i.path].filter(Boolean).join("  "),
  WebFetch: (i) => i.url,
  Task: (i) => i.description,
};
function toolLine(name, input) {
  const inp = (input && typeof input === "object") ? input : {};
  const pick = TOOL_ARG[name];
  let arg = pick ? pick(inp) : undefined;
  if (arg === undefined) {
    // Unknown tool: show its fields compactly rather than a JSON blob.
    const parts = Object.entries(inp)
      .filter(([k]) => k !== "description")
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
    arg = parts.join("  ");
  }
  return `<span class="name">${esc(name)}</span>${arg ? " " + esc(String(arg)) : ""}`;
}

/** One stream-json SDKMessage -> rendered lines. */
function handleFrame(f) {
  if (f.type === "ready") {
    lastSpeaker = null;
    el.msgs.innerHTML = "";
    appendSys(`connected to ${f.agent ?? "agent"}${f.session ? ` · ${f.session}` : ""}`);
    return;
  }
  if (f.type === "_nostream") { appendSys("this agent does not expose a structured stream"); return; }
  if (f.type === "_closed")   { appendSys(`stream closed: ${f.reason ?? ""}`); return; }
  if (f.type === "participants") return;
  if (f.type === "error") { appendSys(`agent refused: ${f.code ?? "error"} ${f.message ?? ""}`); return; }

  if (f.type === "permission_request") { renderPermission(f); return; }
  if (f.type === "question_request")   { renderQuestion(f); return; }
  if (f.type === "permission_resolved" || f.type === "question_resolved") { resolveHitl(f); return; }

  if (f.type !== "frame") return;
  const msg = f.msg ?? {};
  const role = msg.message?.role ?? (msg.type === "assistant" ? "assistant" : "user");
  const isAgent = role === "assistant";
  const content = msg.message?.content;

  if (msg.type === "system") {
    appendSys(`${msg.subtype ?? "system"}${msg.model ? ` · ${msg.model}` : ""}`);
    return;
  }
  if (!Array.isArray(content)) return;

  for (const c of content) {
    // Glyphs and nesting follow the agent's own terminal rendering: a bullet
    // opens a turn, and ⎿ attaches a result to the call that produced it. The
    // hierarchy is the point — a flat list loses which output came from where.
    if (c.type === "text" && c.text?.trim()) {
      const t = esc(c.text);
      msgBlock(f.author, isAgent,
        `<div class="line"><span class="glyph dot">●</span>` +
        (c.text.length > 1400 ? clamped(t, "txt") : `<div class="txt">${t}</div>`) + `</div>`);
    } else if (c.type === "thinking" && c.thinking?.trim()) {
      const t = esc(c.thinking);
      msgBlock(f.author, true,
        `<div class="line"><span class="glyph spark">✳</span>` +
        (c.thinking.length > 700 ? clamped(t, "think") : `<div class="think">${t}</div>`) + `</div>`);
    } else if (c.type === "tool_use") {
      msgBlock(f.author, true,
        `<div class="line"><span class="glyph dot">●</span>` +
        `<div class="tool">${toolLine(c.name, c.input)}</div></div>`);
    } else if (c.type === "tool_result") {
      const body = typeof c.content === "string" ? c.content : JSON.stringify(c.content ?? "");
      const err = /^(exit code [1-9]|fatal:|error|traceback)/i.test(body.trim());
      const t = esc(body.trim());
      msgBlock(f.author, true,
        `<div class="line nested"><span class="glyph hook">⎿</span>` +
        (body.length > 600 ? clamped(t, `out${err ? " err" : ""}`)
                           : `<div class="out${err ? " err" : ""}">${t}</div>`) + `</div>`);
    }
  }
}

// ---- HITL (docs/PROTOCOL.md §3b) -------------------------------------------
function renderPermission(f) {
  if (seenReq.has(f.request_id)) return;
  const d = msgBlock(null, true, `
    <div class="hitl" data-req="${esc(f.request_id)}">
      <h4>Permission needed</h4>
      <div class="tool"><span class="name">${esc(f.tool ?? "?")}</span>(${esc(
        JSON.stringify(f.input ?? {}))})</div>
      ${f.reason ? `<div class="verdict">${esc(f.reason)}</div>` : ""}
      <div class="opts">
        <button class="preset" data-allow="${esc(f.request_id)}">allow</button>
        <button class="preset" data-deny="${esc(f.request_id)}">deny</button>
      </div>
    </div>`);
  seenReq.set(f.request_id, false);
  d.querySelector("[data-allow]").onclick = () => replyPermission(f.request_id, "allow");
  d.querySelector("[data-deny]").onclick  = () => replyPermission(f.request_id, "deny");
}

function renderQuestion(f) {
  if (seenReq.has(f.request_id)) return;
  const qs = f.questions ?? [];
  const html = qs.map((q) => `
    <div data-q="${esc(q.id)}">
      <h4>${esc(q.question)}</h4>
      <div class="opts">${(q.options ?? []).map((o) =>
        `<button class="preset" data-qid="${esc(q.id)}" data-label="${esc(o.label)}"
                 title="${esc(o.description ?? "")}">${esc(o.label)}</button>`).join("")}</div>
    </div>`).join("");
  const d = msgBlock(null, true,
    `<div class="hitl" data-req="${esc(f.request_id)}">${html}
       <div class="verdict">choose one per question${qs.some(q=>q.multiSelect) ? " (multi-select allowed)" : ""}</div>
     </div>`);
  seenReq.set(f.request_id, false);

  const picked = {};
  d.querySelectorAll("[data-qid]").forEach((b) => {
    b.onclick = () => {
      const q = qs.find((x) => x.id === b.dataset.qid);
      // Answers are ALWAYS arrays (PROTOCOL.md §3b) — single-select is a
      // one-element array so the wire shape never depends on the widget.
      if (q?.multiSelect) {
        picked[b.dataset.qid] = picked[b.dataset.qid] ?? [];
        const i = picked[b.dataset.qid].indexOf(b.dataset.label);
        if (i >= 0) { picked[b.dataset.qid].splice(i, 1); b.style.opacity = ""; }
        else { picked[b.dataset.qid].push(b.dataset.label); b.style.opacity = ".6"; }
      } else {
        picked[b.dataset.qid] = [b.dataset.label];
        if (Object.keys(picked).length === qs.length) replyQuestion(f.request_id, picked);
      }
    };
  });
}

function replyPermission(id, decision) {
  streamSock?.send(JSON.stringify({ type: "permission_reply", request_id: id, decision }));
}
function replyQuestion(id, answers) {
  streamSock?.send(JSON.stringify({ type: "question_reply", request_id: id, answers }));
}

function resolveHitl(f) {
  seenReq.set(f.request_id, true);
  const box = el.msgs.querySelector(`[data-req="${CSS.escape(f.request_id)}"]`);
  if (!box) return;
  box.classList.add("done");
  box.querySelectorAll("button").forEach((b) => (b.disabled = true));
  const v = document.createElement("div");
  v.className = "verdict";
  v.textContent = f.by === "timeout"
    ? `timed out — ${f.decision ?? "declined"}`
    : `${f.decision ?? "answered"} by ${f.by}`;
  box.appendChild(v);
  scrollMsgs();
}

el.cgo.onclick = sendChatMsg;
el.cin.onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChatMsg(); }
  e.stopPropagation();
};
function sendChatMsg() {
  const text = el.cin.value;
  if (!text.trim() || streamSock?.readyState !== 1) return;
  streamSock.send(JSON.stringify({ type: "say", text }));
  el.cin.value = "";
}
