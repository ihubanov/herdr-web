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
  tstatus: $("tstatus"), ctlmode: $("ctlmode"), detach: $("detach"),
  askctx: $("askctx"), askq: $("askq"), presetrow: $("presetrow"),
  statusbar: $("statusbar"), whoami: $("whoami"),
  chatview: $("chatview"), msgs: $("msgs"), cin: $("cin"), cgo: $("cgo"),
  chatbtn: $("chatbtn"),
  cclip: $("cclip"), cfile: $("cfile"), attachbar: $("attachbar"), dropveil: $("dropveil"),
  lockstate: $("lockstate"), locktake: $("locktake"), lockrelease: $("lockrelease"),
  frameclose: $("frameclose"),
  frameview: $("frameview"), frame: $("frame"), framebtn: $("framebtn"),
  framebar: $("framebar"), framemax: $("framemax"), framestop: $("framestop"),
  frameurl: $("frameurl"), framewho: $("framewho"), frameopen: $("frameopen"),
  divider: $("divider"), toggleside: $("toggleside"), drawerscrim: $("drawerscrim"), fleetbtn: $("fleetbtn"), triage: $("triage"),
  newspace: $("newspace"), modal: $("modal"), mtitle: $("mtitle"), msub: $("msub"),
  mfields: $("mfields"), merr: $("merr"), mok: $("mok"), mcancel: $("mcancel"),
  me: $("me"), roster: $("roster"), chatq: $("chatq"),
  sound: $("sound"), help: $("help"), helpbox: $("helpbox"), badge: $("blockedbadge"),
};

const RANK = { blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 };
const LABEL = { blocked: "Blocked", working: "Working", done: "Done", idle: "Idle", unknown: "Other" };
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

/**
 * WebSocket URL for a path on this origin.
 *
 * The scheme MUST follow the page's: a browser blocks ws:// from an https:
 * page as mixed content, silently, so behind TLS every socket here — terminal,
 * events and stream — simply never connects and the UI looks dead rather than
 * broken. Hardcoding ws:// worked only because this started life on loopback.
 */
function wsUrl(path) {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}${path}`;
}

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
// Chat is the default view for agents that expose a stream. Flipping to the
// terminal sticks, so someone who prefers the raw pane isn't fighting the app
// on every open. Panes with no stream ignore this entirely.
let preferChat = LS.get("preferChat", null) ?? true;
// Capability is a per-pane round trip. Caching it means only the FIRST open of
// a pane can flash the terminal before landing on chat; every later open goes
// straight there.
const capCache = new Map();

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

/**
 * Re-read what a pane can do, and paint the buttons from it.
 *
 * Called on select AND periodically, because an agent advertises by setting a
 * pane token whenever it likes — including while the user already has that pane
 * open. Fetching only on select meant an agent could ask for a view and nothing
 * appeared until the user happened to click away and back, which reads as the
 * request having been ignored.
 */
let saidRejected = null;
async function refreshCapability(paneId, { firstLook = false } = {}) {
  let c;
  try {
    c = await (await fetch(auth(`/api/capability?pane_id=${encodeURIComponent(paneId)}`))).json();
  } catch { return; }
  if (selected !== paneId) return;                // the user moved on mid-flight
  const before = capability?.iframe?.url ?? null;
  capability = c;
  capCache.set(paneId, c);
  applyChatBtn(c);
  if (firstLook && c?.stream && preferChat && view === "terminal") openChat(paneId);

  // The button is always available on a selected pane, not only when an agent
  // happened to advertise something: with nothing advertised it STARTS a shared
  // browser, which is how a user gets one without asking an agent to.
  el.framebtn.style.display = "inline-block";
  el.framebtn.title = c?.iframe
    ? `Embedded view: ${c.iframe.url}`
    : "Open a shared browser window on this pane";

  const now = c?.iframe?.url ?? null;
  if (!firstLook && now !== before) {
    if (now && frameOpen) openFrame(now);         // the agent replaced what it shows
    else if (!now && frameOpen) dismissFrame();   // …or withdrew it
    else if (now) el.tstatus.textContent = "a view is being offered — open it with the view button";
  }

  // A rejected advertisement is worth saying out loud: an agent asked to show
  // something and policy refused, which is otherwise invisible. Said once per
  // distinct refusal, or a 5s poll would repeat it forever.
  if (c?.iframeRejected && c.iframeRejected !== saidRejected) {
    console.warn(`herdr-web: iframe refused — ${c.iframeRejected}`);
    el.tstatus.textContent = `view blocked (${c.iframePolicy})`;
  }
  saidRejected = c?.iframeRejected ?? null;
}

function attach(f, mode = "observe") {
  if (!f) return;
  closeChat();
  closeFrame();
  if (termSock) { try { termSock.close(); } catch {} termSock = null; }
  selected = f.pane_id;
  activeMode = mode;
  // Adopt the cached capability BEFORE switching views — setView paints the
  // button from `capability`, and a stale value flashes the previous pane's
  // state for a frame.
  const known = capCache.get(f.pane_id) ?? null;
  capability = known;
  // If we already know this pane streams, go straight to chat rather than
  // showing the terminal and yanking it away a moment later.
  const toChat = !!known?.stream && preferChat;
  setView(toChat ? "chat" : "terminal");
  el.crumb.innerHTML = `<b>${esc(f.title)}</b>${f.task ? ` — ${esc(f.task)}` : ""}`;
  el.ctlmeta.textContent = [f.repo, f.branch, f.cwd].filter(Boolean).join("  ·  ");
  el.ctl.classList.add("on");
  positionWhoami();

  if (toChat) openChat(f.pane_id);
  // Re-ask anyway: an agent can start or stop advertising between opens.
  void refreshCapability(f.pane_id, { firstLook: true });
  el.tstatus.textContent = "attaching…";
  term.reset();
  renderTree();
  renderChat();
  updateTitle();

  const ws = new WebSocket(
    wsUrl(auth(`/ws/terminal/${encodeURIComponent(f.pane_id)}`)));
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
      el.tstatus.textContent = "read-only — just start typing to take control";
    } else if (m.type === "_closed") {
      el.tstatus.textContent = `closed: ${m.reason}`;
    }
  };
  ws.onclose = (e) => { if (e?.code === 4001) return sessionEnded(e.reason); renderCtl(); };
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
  // Control is taken automatically by typing (see term.onData), so there is no
  // button — only an indicator of which mode you are in. A button that merely
  // does what typing already does is a step the user has to learn for nothing.
  el.ctlmode.textContent = activeMode === "control" ? "controlling" : "read-only";
  el.ctlmode.classList.toggle("on", activeMode === "control");
  el.ctlmode.style.display = selected && view === "terminal" ? "" : "none";
}
el.detach.onclick = detach;

// ------------------------------------------------------------------ views
function setView(v) {
  view = v;
  // The embedded view is deliberately NOT one of these. It is a floating window
  // that lives above whichever view is current, so switching views leaves it
  // alone and closing it does not have to restore anything.
  el.fleet.classList.toggle("on", v === "fleet");
  el.term.classList.toggle("hidden", v !== "terminal");
  el.chatview.classList.toggle("on", v === "chat");
  el.fleetbtn.classList.toggle("on", v === "fleet");
  el.chatbtn.classList.toggle("on", v === "chat");
  applyChatBtn(capability);
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

/**
 * Narrow screens use a DRAWER, wide screens a collapsing column.
 *
 * Same button, same `b` shortcut, different meaning by width — because on a
 * phone the sidebar cannot be a grid column at all: 18% of 390px is a third of
 * the screen spent on the pane list before anything useful. The breakpoint
 * matches the stylesheet's; keeping the number in both places is the price of
 * not shipping a CSS-in-JS layer for one rule.
 */
const NARROW = "(max-width: 760px)";
const isNarrow = () => window.matchMedia(NARROW).matches;

function setSidebar(hidden) {
  if (isNarrow()) { setDrawer(!hidden); return; }
  sidebarHidden = hidden;
  LS.set("sidebarHidden", hidden);
  document.body.classList.toggle("collapsed", hidden);
  setTimeout(refit, 180);
}

/** Drawer state is deliberately NOT persisted: it is a transient overlay. */
function setDrawer(open) {
  document.body.classList.toggle("drawer", open);
  setTimeout(refit, 200);
}

el.toggleside.onclick = () => {
  if (isNarrow()) setDrawer(!document.body.classList.contains("drawer"));
  else setSidebar(!sidebarHidden);
};
el.drawerscrim.onclick = () => setDrawer(false);

// Picking a pane is the end of what the drawer is for, so it gets out of the
// way — otherwise every selection needs a second tap to see the result.
el.fleet.addEventListener("click", () => { if (isNarrow()) setDrawer(false); }, true);
document.querySelector("aside")?.addEventListener("click", (e) => {
  if (isNarrow() && e.target.closest(".item")) setDrawer(false);
}, true);

// Crossing the breakpoint must not leave a drawer open over a desktop layout,
// or a collapsed column that the drawer toggle can no longer reveal.
window.matchMedia(NARROW).addEventListener("change", (m) => {
  if (m.matches) document.body.classList.remove("collapsed");
  else {
    setDrawer(false);
    document.body.classList.toggle("collapsed", sidebarHidden);
  }
  setTimeout(refit, 200);
});
el.fleetbtn.onclick = toggleView;
el.framebtn.onclick = () => {
  if (frameOpen) { dismissFrame(); return; }
  // An agent-advertised URL is the fast path. With nothing advertised the button
  // still works: it asks for a shared browser, which is the whole reason a user
  // wants this without an agent having thought of it first.
  if (capability?.iframe) openFrame(capability.iframe.url);
  else void startSharedBrowser();
};

/**
 * Ask the bridge for a shared browser on this pane, then show it.
 *
 * Same endpoint the agent-facing API uses, so a button press and a tool call
 * cannot drift apart — and the reply carries the proxied path, never the
 * loopback URL the script printed, which would be the viewer's own machine.
 */
async function startSharedBrowser() {
  if (!selected) { el.tstatus.textContent = "select a pane first"; return; }
  el.framebtn.disabled = true;
  const prev = el.framebtn.textContent;
  el.framebtn.textContent = "…";
  el.tstatus.textContent = "starting a shared browser…";
  try {
    const r = await fetch(auth("/api/share"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pane_id: selected, action: "browser" }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.iframe_url) {
      el.tstatus.textContent = `share failed: ${d.error || r.statusText}`;
      return;
    }
    el.tstatus.textContent = "shared browser ready";
    openFrame(d.iframe_url);
  } catch (e) {
    el.tstatus.textContent = `share failed: ${e?.message ?? e}`;
  } finally {
    el.framebtn.disabled = false;
    el.framebtn.textContent = prev;
  }
}

/** Whether the floating window is up. Declared here, above every function that
 *  reads it: detach() runs during startup and would otherwise hit its TDZ. */
let frameOpen = false;

/**
 * Show an agent-advertised URL. The frame is sandboxed and must be a different
 * origin than this page — the bridge enforces that, since `allow-same-origin`
 * on a same-origin frame would let it drop its own sandbox and read our token.
 */
function openFrame(url) {
  const ours = url.startsWith("/shared/");
  // The sandbox depends on WHOSE page this is, which is the distinction the old
  // blanket attribute could not make.
  //
  // Our own proxied shim gets allow-same-origin, and needs it: without it the
  // frame has an opaque origin, its ES module import becomes a cross-origin
  // fetch, and the auth cookie is not sent — the frame loads nothing, silently.
  // It is safe here because we author that document; the only remote content in
  // it is pixels on a canvas.
  //
  // An agent-advertised URL is somebody else's page and gets NO same-origin
  // privilege, on top of the policy that already refuses to frame our origin.
  el.frame.setAttribute("sandbox",
    ours ? "allow-scripts allow-forms allow-same-origin" : "allow-scripts allow-forms");
  // A proxied display is a path on our origin, and an iframe cannot set an auth
  // header, so the token rides in the query as it does everywhere else here.
  el.frame.src = ours ? auth(url) : url;
  el.frameurl.textContent = url;
  const f = entry(selected);
  el.framewho.textContent = f ? `from ${f.title}` : "";
  // Only a display proxied through us can be shut down from here; an
  // agent-advertised third-party page is not ours to stop.
  el.framestop.style.display = ours ? "" : "none";
  frameOpen = true;
  restoreGeom();
  el.frameview.classList.add("on");
  el.framebtn.classList.add("on");
  startLockWatch(selected);
}
function closeFrame() {
  el.frame.src = "about:blank";
  el.frameurl.textContent = "";
  frameOpen = false;
  el.frameview.classList.remove("on");
  el.framebtn.classList.remove("on");
  stopLockWatch();
}

function dismissFrame() {
  if (!frameOpen) return;
  closeFrame();
  // Nothing to restore: the view underneath was never hidden.
  if (view === "terminal") setTimeout(refit, 40);
}

el.frameclose.onclick = dismissFrame;

// Closing the window hides a display that is still running — Xvfb, a browser and
// a VNC server, indefinitely. This is the other half: stop the thing, not the
// view of it. Kept as a separate button because an agent may still be working on
// that display, and closing a window must never kill work.
el.framestop.onclick = async () => {
  if (!selected) return;
  const b = el.framestop, prev = b.textContent;
  b.disabled = true; b.textContent = "stopping…";
  try {
    const r = await fetch(auth("/api/share"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pane_id: selected, action: "stop" }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { el.tstatus.textContent = `stop failed: ${d.error || r.statusText}`; return; }
    el.tstatus.textContent = "shared display stopped";
    dismissFrame();
  } catch (e) {
    el.tstatus.textContent = `stop failed: ${e?.message ?? e}`;
  } finally {
    b.disabled = false; b.textContent = prev;
  }
};
document.addEventListener("keydown", (e) => {
  // Escape closes the window only while it has focus. A floating window must not
  // swallow Escape from the terminal behind it — that key is the agent's.
  if (e.key !== "Escape" || !frameOpen) return;
  if (!el.frameview.contains(document.activeElement)) return;
  dismissFrame(); e.preventDefault();
});

/* --------------------------------------------------------------- window chrome
 * Move, resize, maximise. Two things make this less trivial than it sounds:
 *
 *  1. An IFRAME EATS POINTER EVENTS. The moment the cursor crosses into it
 *     mid-drag, the events go to the framed document and the gesture dies. So a
 *     transparent shield is laid over the frame for the duration of every drag
 *     (body.winop), and removed after.
 *  2. Pointer capture, not mousemove-on-document: with setPointerCapture the
 *     gesture survives leaving the window and the browser's own drag heuristics,
 *     and it gives touch and pen the same behaviour for free.
 *
 * Geometry is persisted, because a window that forgets where you put it is a
 * modal with extra steps.
 */
const GEOM_KEY = "herdr.frame.geom";
const WIN_MIN_W = 320, WIN_MIN_H = 200;

function readGeom() {
  try { return JSON.parse(localStorage.getItem(GEOM_KEY) || "null"); } catch { return null; }
}

/**
 * Persist the geometry.
 *
 * The stored left/top/width/height are ALWAYS the restored size, never the
 * maximised one — a maximised window has no size of its own worth keeping, and
 * writing it over the record is what makes "restore" restore nothing. So while
 * maximised only the flag is updated.
 */
function saveGeom() {
  if (isNarrow()) return;                       // phone size is not a choice
  const v = el.frameview;
  const maxed = v.classList.contains("max");
  const g = maxed
    ? { ...(readGeom() ?? {}) }
    : { left: v.offsetLeft, top: v.offsetTop, width: v.offsetWidth, height: v.offsetHeight };
  g.max = maxed;
  try { localStorage.setItem(GEOM_KEY, JSON.stringify(g)); } catch { /* private mode */ }
}

/** Put the window back where it was, size AND maximised state. Used on open. */
function restoreGeom() {
  const g = readGeom();
  el.frameview.classList.toggle("max", !!(g && g.max));
  applyGeom(g);
}

/** Size and position only, leaving the maximised state alone. */
function applyGeom(g) {
  const host = el.frameview.offsetParent || document.body;
  const W = host.clientWidth || window.innerWidth;
  const H = host.clientHeight || window.innerHeight;
  if (!g || typeof g.width !== "number") {
    // A first open is centred at a size that leaves the pane behind it visible.
    const w = Math.min(900, Math.round(W * 0.8)), h = Math.min(620, Math.round(H * 0.8));
    place(Math.round((W - w) / 2), Math.round((H - h) / 2), w, h);
    return;
  }
  place(g.left, g.top, g.width, g.height);
}

/** Apply a geometry, clamped so the window can never land off-screen. */
function place(left, top, width, height) {
  const host = el.frameview.offsetParent || document.body;
  const W = host.clientWidth || window.innerWidth;
  const H = host.clientHeight || window.innerHeight;
  const w = Math.max(WIN_MIN_W, Math.min(width, W));
  const h = Math.max(WIN_MIN_H, Math.min(height, H));
  // Keep at least the title bar reachable: a window dragged past the bottom edge
  // with no bar left to grab is unrecoverable without clearing storage.
  const v = el.frameview;
  v.style.width = `${w}px`;
  v.style.height = `${h}px`;
  v.style.left = `${Math.max(0, Math.min(left, W - Math.min(w, 80)))}px`;
  v.style.top = `${Math.max(0, Math.min(top, H - 30))}px`;
}

function beginGesture(ev, onMove) {
  const v = el.frameview;
  if (v.classList.contains("max")) return;      // a maximised window does not move
  const target = ev.currentTarget;
  // Capture keeps the gesture alive when the cursor leaves the handle, but it
  // THROWS for a pointer the browser no longer considers active — and an
  // exception here would abort before the move listeners were attached, killing
  // the drag entirely. The gesture works without capture; it just needs the
  // shield, which is already up.
  try { target.setPointerCapture(ev.pointerId); } catch { /* pointer already gone */ }
  document.body.classList.add("winop");
  const start = {
    x: ev.clientX, y: ev.clientY,
    left: v.offsetLeft, top: v.offsetTop, w: v.offsetWidth, h: v.offsetHeight,
  };
  const move = (e) => onMove(e.clientX - start.x, e.clientY - start.y, start);
  const end = () => {
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", end);
    target.removeEventListener("pointercancel", end);
    document.body.classList.remove("winop");
    saveGeom();
    // The framed client sizes itself to its container, so tell it the container
    // settled — otherwise a noVNC session only reflows on its next own event.
    try { el.frame.contentWindow?.dispatchEvent(new Event("resize")); } catch { /* cross-origin */ }
  };
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", end);
  target.addEventListener("pointercancel", end);
  ev.preventDefault();
}

el.framebar.addEventListener("pointerdown", (ev) => {
  // Buttons in the bar are buttons, not drag handles.
  if (ev.target.closest("button")) return;
  if (ev.button !== 0 && ev.pointerType === "mouse") return;
  beginGesture(ev, (dx, dy, s) => place(s.left + dx, s.top + dy, s.w, s.h));
});

// Double-click the bar to maximise, as every other window manager does.
el.framebar.addEventListener("dblclick", (ev) => {
  if (ev.target.closest("button")) return;
  toggleMax();
});

for (const h of document.querySelectorAll("#frameview .rz")) {
  const dir = h.dataset.rz;
  h.addEventListener("pointerdown", (ev) => beginGesture(ev, (dx, dy, s) => {
    let { left, top, w, h: hh } = { left: s.left, top: s.top, w: s.w, h: s.h };
    if (dir.includes("e")) w = s.w + dx;
    if (dir.includes("s")) hh = s.h + dy;
    // Dragging a top or left edge moves the origin as well as the size, and the
    // movement has to stop when the size hits its minimum or the far edge walks.
    if (dir.includes("w")) { w = Math.max(WIN_MIN_W, s.w - dx); left = s.left + (s.w - w); }
    if (dir.includes("n")) { hh = Math.max(WIN_MIN_H, s.h - dy); top = s.top + (s.h - hh); }
    place(left, top, w, hh);
  }));
}

function toggleMax() {
  const v = el.frameview;
  const going = !v.classList.contains("max");
  if (going) saveGeom();                        // record where to come back to
  v.classList.toggle("max", going);
  // applyGeom, not restoreGeom: the stored record still says max:true at this
  // point, and restoreGeom would obediently maximise us straight back again.
  if (!going) applyGeom(readGeom());
  saveGeom();
  try { el.frame.contentWindow?.dispatchEvent(new Event("resize")); } catch { /* cross-origin */ }
}
el.framemax.onclick = toggleMax;

// A window sized for a wide browser is off-screen in a narrow one; re-clamp.
window.addEventListener("resize", () => {
  if (!frameOpen || el.frameview.classList.contains("max")) return;
  const v = el.frameview;
  place(v.offsetLeft, v.offsetTop, v.offsetWidth, v.offsetHeight);
});

/* ------------------------------------------------- input arbitration (human)
 * A shared display has two drivers. This is the human's end: it reads the lock,
 * shows who holds it, and tells the embedded client whether to send input at
 * all. The enforcement is in the client — viewOnly there means the events never
 * leave the browser — so this is not merely an indicator.
 * -------------------------------------------------------------------------- */
let lockPane = null;
let lockTimer = null;
let lockState = null;
let lockHeld = false;         // do WE hold it (so we know to heartbeat)

function pushLockToFrame() {
  try {
    el.frame.contentWindow?.postMessage(
      { kind: "herdr-input-lock", state: lockState }, "*");
  } catch { /* frame not ready */ }
}

function renderLock() {
  const s = lockState;
  const mine = s?.owner === "user";
  const theirs = s?.owner === "agent";
  el.lockstate.className = mine ? "mine" : theirs ? "theirs" : "";
  el.lockstate.textContent = mine ? "input: yours"
    : theirs ? `input: agent${s.label ? ` (${s.label})` : ""}`
    : "input: free";
  el.locktake.style.display = mine ? "none" : "";
  // Taking it from a working agent is a real interruption, so say so on the
  // button rather than springing it after the click.
  el.locktake.textContent = theirs ? "take input from agent" : "take input";
  el.lockrelease.style.display = mine ? "" : "none";
  pushLockToFrame();
}

async function lockCall(body) {
  if (!lockPane) return null;
  try {
    const r = await fetch(auth(`/api/input-lock?pane_id=${encodeURIComponent(lockPane)}`), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    lockState = d.state ?? d;
    renderLock();
    return d;
  } catch { return null; }
}

async function pollLock() {
  if (!lockPane) return;
  // Renewing is part of the poll: a lock we hold but stop renewing lapses, which
  // is what should happen if this tab is closed or the machine sleeps.
  if (lockHeld && lockState?.owner === "user") {
    await lockCall({ owner: "user", action: "heartbeat", ttl_ms: 30000 });
    return;
  }
  try {
    const r = await fetch(auth(`/api/input-lock?pane_id=${encodeURIComponent(lockPane)}`));
    lockState = await r.json();
    if (lockState?.owner !== "user") lockHeld = false;
    renderLock();
  } catch { /* transient */ }
}

function startLockWatch(paneId) {
  stopLockWatch();
  lockPane = paneId;
  lockState = null; lockHeld = false;
  renderLock();
  void pollLock();
  lockTimer = setInterval(pollLock, 5000);
}

function stopLockWatch() {
  if (lockTimer) clearInterval(lockTimer);
  lockTimer = null;
  if (lockHeld && lockPane) void lockCall({ owner: "user", action: "release" });
  lockPane = null; lockHeld = false; lockState = null;
}

el.locktake.onclick = async () => {
  // force: a person watching a stuck agent needs a way in that does not depend
  // on that agent still being alive to hand over.
  const d = await lockCall({ owner: "user", action: "claim", ttl_ms: 30000, force: true });
  lockHeld = !!d?.ok || lockState?.owner === "user";
  renderLock();
};
el.lockrelease.onclick = async () => {
  await lockCall({ owner: "user", action: "release" });
  lockHeld = false;
  renderLock();
};

// The shim announces itself on load; answer immediately so a reloaded iframe
// is not inert until the next poll.
window.addEventListener("message", (ev) => {
  if (ev.data?.kind === "herdr-shim-ready") pushLockToFrame();
});

// Releasing on unload keeps a closed tab from parking the display.
window.addEventListener("pagehide", () => {
  if (lockHeld && lockPane) {
    navigator.sendBeacon?.(
      auth(`/api/input-lock?pane_id=${encodeURIComponent(lockPane)}`),
      new Blob([JSON.stringify({ owner: "user", action: "release" })],
               { type: "application/json" }));
  }
});
el.frameopen.onclick = () => {
  if (capability?.iframe) window.open(capability.iframe.url, "_blank", "noopener,noreferrer");
};

/** Button visibility and label track the pane's capability and current view. */
function applyChatBtn(c) {
  const has = !!c?.stream;
  el.chatbtn.style.display = has ? "inline-block" : "none";
  if (!has) { el.chatbtn.title = ""; return; }
  const toTerm = view === "chat";
  el.chatbtn.textContent = toTerm ? "terminal" : "chat view";
  const fromFile = c?.source === "transcript";
  el.chatbtn.title = toTerm
    ? "Raw terminal output for this pane"
    : (fromFile
        ? "Chat rendered from the session transcript on disk"
        : "Message-level chat with per-message attribution");
}

el.chatbtn.onclick = () => {
  // An explicit switch is a preference, not a one-off.
  preferChat = view !== "chat";
  LS.set("preferChat", preferChat);
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
  el.mfields.innerHTML = (fields || []).map((f) => {
    if (f.type === "checkbox") {
      // Boolean toggle (e.g. --dangerously-skip-permissions). Default from f.value.
      return `<label class="mcheck"><input type="checkbox" id="f_${f.k}"${f.value ? " checked" : ""} /> ${esc(f.label)}</label>`;
    }
    if (f.type === "select") {
      const opts = (f.options || []).map((o) => `<option value="${esc(o.v)}"${o.v === (f.value ?? "") ? " selected" : ""}>${esc(o.t)}</option>`).join("");
      return `<label for="f_${f.k}">${esc(f.label)}</label><select id="f_${f.k}">${opts}</select>`;
    }
    if (f.type === "static") {
      // Read-only display — a locked value the user cannot edit. The value is
      // carried in data-val so the submit handler still reads it back.
      return `<label>${esc(f.label)}</label>
       <div class="mstatic" id="f_${f.k}" data-val="${esc(f.value ?? "")}">${esc(f.value ?? "")}</div>`;
    }
    return `<label for="f_${f.k}">${esc(f.label)}</label>
     <input id="f_${f.k}" value="${esc(f.value ?? "")}" placeholder="${esc(f.placeholder ?? "")}" />`;
  }).join("");
  modalOK = async () => {
    const vals = {};
    for (const f of fields || []) {
      const node = document.getElementById(`f_${f.k}`);
      if (!node) continue;
      if (f.type === "checkbox") vals[f.k] = node.checked;
      else if (f.type === "static") vals[f.k] = node.dataset.val ?? f.value ?? "";
      else vals[f.k] = node.value.trim();
    }
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
  const first = el.mfields.querySelector("input:not([type=checkbox])");
  if (first) setTimeout(() => { first.focus(); first.select(); }, 30);
}
function closeModal() { el.modal.classList.remove("on"); modalOK = null; }
el.mok.onclick = () => modalOK?.();
el.mcancel.onclick = closeModal;
el.modal.onclick = (e) => { if (e.target === el.modal) closeModal(); };

// ---- structure actions ------------------------------------------------------
function spaceOf(wsId) { return fleet.find((f) => f.workspace_id === wsId); }

async function newSession(wsId) {
  const ref = spaceOf(wsId);
  const base = (me?.defaultLaunchCmd || "").trim();
  // Existing conversations (HERDR_WEB_RESUME): offered as a select on top of the dialog.
  let resumeField = [];
  if (me?.resume) {
    try {
      const r = await fetch(auth("/api/sessions"));
      const list = r.ok ? (await r.json()).sessions || [] : [];
      if (list.length) {
        const when = (ms) => ms ? new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
        resumeField = [{ k: "resume", label: "conversation", type: "select", value: "", options: [
          { v: "", t: "start a new conversation" },
          ...list.map((s) => ({ v: s.id, t: `${s.title || s.id.slice(0, 8)}  ·  ${s.messages} msgs  ·  ${when(s.last_activity_at)}${s.busy ? "  ·  BUSY" : ""}` })),
        ] }];
      }
    } catch { /* the picker is optional; the dialog still works without it */ }
  }
  // Locked mode (HERDR_WEB_LOCK_LAUNCH): the launch command is fixed to `base`,
  // and the only choice is whether to add --dangerously-skip-permissions. Needs
  // a base to lock TO — with none, fall back to the editable field so the dialog
  // is never a dead end.
  const locked = !!me?.lockLaunch && !!base;
  const cmdFields = locked
    ? [
        { k: "cmd", label: "launch command", type: "static", value: base },
        { k: "skip", label: "--dangerously-skip-permissions", type: "checkbox", value: false },
      ]
    : [
        { k: "cmd", label: "launch command (optional)", value: base,
          placeholder: "leave blank for a shell" },
      ];
  openModal({
    title: "New session",
    sub: locked
      ? `A new card in ${ref?.workspace_label ?? wsId}. It starts ${me?.agentName || "the agent"}${resumeField.length ? " — new, or continuing a conversation you pick" : ""}.`
      : `A new tab in ${ref?.workspace_label ?? wsId}. It starts a shell in this directory; run your agent there.`,
    fields: [
      ...resumeField,
      { k: "cwd", label: "working directory", value: ref?.cwd || "", placeholder: "/path/to/repo" },
      { k: "label", label: "name (optional)", value: "", placeholder: "leave blank to auto-name" },
      ...cmdFields,
    ],
    onOK: async (v) => {
      if (!v.cwd) throw new Error("working directory is required");
      // Resuming: never open the same conversation twice — two writers corrupt one transcript.
      if (v.resume) {
        try {
          const pl = await rpc("pane.list", {});
          const open = (pl?.panes || []).find((p) => p?.agent_session?.value === v.resume);
          if (open) throw new Error(`that conversation is already open in pane ${open.pane_id}`);
        } catch (e) { if (/already open/.test(e.message)) throw e; }
      }
      const label = v.label || (v.resume ? (resumeField[0]?.options?.find((o) => o.v === v.resume)?.t.split("  ·  ")[0] || "") : "");
      const res = await rpc("tab.create", {
        workspace_id: wsId, cwd: v.cwd, label: label || null, focus: false,
      });
      // Build the launch command. Locked → the fixed base plus the optional
      // skip-permissions flag, never free text. Unlocked → the editable field.
      let cmd = locked ? base : (v.cmd || "").trim();
      if (locked && v.skip) cmd += " --dangerously-skip-permissions";
      if (!cmd) return;
      // The resume contract with the agent launcher: ONE env var prepended, nothing else changes.
      if (v.resume && /^[A-Za-z0-9-]+$/.test(v.resume)) cmd = `HERDR_UI_RESUME=${v.resume} ${cmd}`;
      // herdr cannot spawn a command as the pane's foreground directly, so run
      // it in the fresh shell. An `exec` in the command replaces that shell,
      // which is what keeps the agent (not bash) as the foreground process.
      const paneId = res?.root_pane?.pane_id ?? res?.pane?.pane_id;
      if (!paneId) return;
      await new Promise((r) => setTimeout(r, 1500));   // let the shell come up
      await rpc("pane.send_input", { pane_id: paneId, text: cmd, keys: ["enter"] });
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
  if (!pendingSay) {
    el.chatq.innerHTML = [
      waiting.length ? `<span class="q">${waiting.length} queued</span>` : "",
      failed.length ? `<span class="f">${failed.length} failed</span>` : "",
    ].filter(Boolean).join(" · ");
  }
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

  if (e.key === "Escape" && document.body.classList.contains("drawer")) {
    setDrawer(false); e.preventDefault(); return;
  }
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

// Watch the selected pane's advertisement. Polled rather than pushed: herdr has
// no event for a metadata token changing, and the tokens carry a TTL and are
// refreshed, so an event per change would be noise anyway. 5s is well inside the
// 5-minute TTL and costs one small local request.
setInterval(() => { if (selected) void refreshCapability(selected); }, 5000);

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
  // Not every agent emits a `result` frame to close a turn, so pane status is
  // the backstop. It must be a TRANSITION out of working, not merely "not
  // working": a pane that never reports a real agent status sits at "unknown"
  // forever, and treating that as an ending chops every turn at the first
  // fleet poll.
  if (turn && streamPane) {
    const st = next.find((f) => f.pane_id === streamPane)?.agent_status;
    // End on an explicit terminal state. Requiring "working" to have been seen
    // first meant a turn whose working window fell between polls ticked forever;
    // testing "not working" instead ended every turn on panes stuck at
    // "unknown". Naming the terminal states avoids both. "blocked" is NOT one —
    // an agent waiting on a human is still mid-turn.
    if (st === "working") turn.sawWorking = true;
    else if (st === "idle" || st === "done") turnEnd(null, null);
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
    // One-click switch to another front end for the same agent, when the server offers one.
    const alt = document.getElementById("altui");
    if (alt) {
      if (me.altUiUrl) {
        alt.href = me.altUiUrl; alt.textContent = me.altUiLabel || "Classic UI";
        alt.title = `Switch to ${me.altUiLabel || "the classic UI"} (a separate interface with its own conversations)`;
        alt.hidden = false;
      } else alt.hidden = true;
    }
    // Default pane view comes from the server (HERDR_WEB_DEFAULT_VIEW) until this person has
    // clicked the toggle themselves; an explicit choice is stored and wins thereafter.
    if (LS.get("preferChat", null) === null) preferChat = me.defaultView !== "terminal";
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
  const ws = new WebSocket(wsUrl(auth("/ws/events")));
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
    wsUrl(auth(`/ws/stream/${encodeURIComponent(paneId)}`)));
  streamSock = ws;
  ws.onmessage = (e) => {
    let f; try { f = JSON.parse(e.data); } catch { return; }
    handleFrame(f);
  };
  ws.onclose = (e) => {
    if (e?.code === 4001) return sessionEnded(e.reason);
    if (view === "chat") appendSys("stream closed");
  };
  ws.onerror = () => appendSys("stream error");
}

function closeChat() {
  if (turn) { clearInterval(turn.timer); turn = null; }
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

/**
 * The server cut us off — the link was revoked or expired. Say so plainly and
 * stop: silently reconnecting against a dead token just spins, and leaving the
 * last frame on screen makes a revoked session look live.
 */
let ended = false;
function sessionEnded(reason) {
  if (ended) return;
  ended = true;
  try { streamSock?.close(); } catch {}
  try { termSock?.close(); } catch {}
  streamSock = null; termSock = null;
  const veil = document.createElement("div");
  veil.style.cssText = "position:fixed;inset:0;z-index:999;display:grid;place-items:center;" +
    "background:rgba(6,8,12,.92);color:#e8e8ea;font:15px/1.6 system-ui,sans-serif;text-align:center;padding:24px";
  veil.innerHTML = `<div><div style="font-size:19px;margin-bottom:8px">Session ended</div>` +
    `<div style="color:#8b93a7">${esc(reason || "this link is no longer valid")}.</div>` +
    `<div style="color:#8b93a7;margin-top:10px;font-size:13px">Ask for a new link to reconnect.</div></div>`;
  document.body.appendChild(veil);
}

function scrollMsgs() { el.msgs.scrollTop = el.msgs.scrollHeight; }

/* ------------------------------------------------------------- attachments
 * A chat that drives a terminal cannot hand an agent bytes. But every coding
 * agent reads file paths, so an attached file is uploaded, and its PATH is what
 * goes into the message. Paste an image, drop a file, or use the clip button.
 * -------------------------------------------------------------------------- */
let attached = [];               // [{path, name, size, type, preview}]

function renderAttachments() {
  el.attachbar.classList.toggle("on", attached.length > 0);
  el.attachbar.innerHTML = attached.map((a, i) =>
    `<span class="att">${a.preview ? `<img src="${a.preview}" alt="">` : "📄"}` +
    `<b title="${esc(a.path)}">${esc(a.name)}</b>` +
    `<button type="button" data-rm="${i}" title="remove">×</button></span>`).join("");
}

el.attachbar.addEventListener("click", (e) => {
  const i = e.target?.dataset?.rm;
  if (i === undefined) return;
  const a = attached[Number(i)];
  if (a?.preview) URL.revokeObjectURL(a.preview);
  attached.splice(Number(i), 1);
  renderAttachments();
});

async function uploadFiles(files) {
  for (const file of files) {
    if (!file) continue;
    const fd = new FormData();
    fd.append("file", file, file.name || "pasted");
    try {
      const r = await fetch(auth("/api/upload"), { method: "POST", body: fd });
      const d = await r.json();
      if (!r.ok || d.error) { appendSys(`attach failed: ${d.error ?? r.status}`); continue; }
      attached.push({
        ...d,
        preview: file.type?.startsWith("image/") ? URL.createObjectURL(file) : null,
      });
      renderAttachments();
    } catch (e) {
      appendSys(`attach failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}

/** Attached paths ride along with the text — that is what the agent can act on. */
function withAttachments(text) {
  if (!attached.length) return text;
  const paths = attached.map((a) => a.path).join("\n");
  return text.trim() ? `${text.trim()}\n${paths}` : paths;
}

function clearAttachments() {
  for (const a of attached) if (a.preview) URL.revokeObjectURL(a.preview);
  attached = [];
  renderAttachments();
}

el.cclip.onclick = () => el.cfile.click();
el.cfile.onchange = () => { void uploadFiles([...el.cfile.files]); el.cfile.value = ""; };

// Paste: an image on the clipboard has no filename, so give it one.
el.cin.addEventListener("paste", (e) => {
  const items = [...(e.clipboardData?.items ?? [])].filter((i) => i.kind === "file");
  if (!items.length) return;
  e.preventDefault();
  const files = items.map((i) => {
    const f = i.getAsFile();
    if (!f) return null;
    if (f.name && f.name !== "image.png") return f;
    const ext = (f.type.split("/")[1] || "png").replace(/[^a-z0-9]/gi, "");
    return new File([f], `pasted-${Date.now()}.${ext}`, { type: f.type });
  });
  void uploadFiles(files.filter(Boolean));
});

// Drag and drop anywhere over the chat.
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
el.chatview.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth++; el.dropveil.classList.add("on");
});
el.chatview.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
el.chatview.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) { dragDepth = 0; el.dropveil.classList.remove("on"); }
});
el.chatview.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; el.dropveil.classList.remove("on");
  void uploadFiles([...(e.dataTransfer?.files ?? [])]);
});

/* --------------------------------------------------------------- tool groups
 * A turn's consecutive tool calls collapse into one bubble rather than a dozen
 * separate lines. The interesting part of a turn is usually what the agent SAID;
 * the tools it ran to get there are detail you want available, not resident.
 *
 * Prose or reasoning ends the run — the agent moved on to something else, so a
 * later tool call starts a fresh bubble instead of joining an unrelated one.
 * -------------------------------------------------------------------------- */
let toolGroup = null;

function groupLabel(root) {
  const n = Number(root.dataset.count || 0);
  const names = (root.dataset.names || "").split(",").filter(Boolean);
  const shown = names.slice(0, 3).join(", ");
  const rest = names.length > 3 ? ` +${names.length - 3}` : "";
  const open = root.classList.contains("open");
  return `${open ? "▾" : "▸"} ${n} tool${n === 1 ? "" : "s"}${shown ? ` · ${shown}${rest}` : ""}`;
}

function setGroupOpen(root, open) {
  root.classList.toggle("open", open);
  const h = root.querySelector(".tghdr");
  if (h) h.textContent = groupLabel(root);
}

/** End the current run. `collapse` folds it away; leaving it open is for replay. */
function endToolGroup(collapse) {
  if (!toolGroup) return;
  if (collapse) setGroupOpen(toolGroup.root, false);
  toolGroup = null;
}

function appendTool(author, innerHTML, name, live) {
  if (!toolGroup) {
    const shell = msgBlock(author, true, "");
    const root = document.createElement("div");
    // Live runs open so you can watch them; replayed and paged-in history
    // arrives folded — a transcript is for reading, and a wall of expanded
    // tool output is the thing this bubble exists to prevent.
    root.className = `toolgroup${live ? " open" : ""}`;
    root.dataset.count = "0";
    root.dataset.names = "";
    root.innerHTML = `<button class="tghdr" type="button"></button><div class="tgbody"></div>`;
    shell.querySelector(".body").appendChild(root);
    toolGroup = { root, body: root.querySelector(".tgbody") };
  }
  const { root, body } = toolGroup;
  const holder = document.createElement("div");
  holder.innerHTML = innerHTML;
  while (holder.firstChild) body.appendChild(holder.firstChild);
  if (name) {
    const names = (root.dataset.names || "").split(",").filter(Boolean);
    if (!names.includes(name)) { names.push(name); root.dataset.names = names.join(","); }
    root.dataset.count = String(Number(root.dataset.count || 0) + 1);
  }
  setGroupOpen(root, root.classList.contains("open"));
  markOverflow(root);
  scrollMsgs();
}

/* ------------------------------------------------------------------ history
 * The stream opens on the tail of the transcript; older turns are paged in on
 * demand. Frames are rendered into a detached node first, then inserted above
 * the existing ones and the scroll position corrected by exactly the height
 * that was added — otherwise loading history yanks the reader somewhere else.
 * -------------------------------------------------------------------------- */
function makeLoadMore() {
  const d = document.createElement("div");
  d.className = "loadmore";
  d.innerHTML = `<button type="button">load earlier messages</button>`;
  d.querySelector("button").onclick = () => loadHistory();
  return d;
}

async function loadHistory() {
  if (historyBusy || historyFrom <= 0 || !streamPane) return;
  historyBusy = true;
  const bar = el.msgs.querySelector(".loadmore");
  const btn = bar?.querySelector("button");
  if (btn) { btn.disabled = true; btn.textContent = "loading…"; }
  try {
    const r = await fetch(auth(
      `/api/history?pane_id=${encodeURIComponent(streamPane)}&before=${historyFrom}`));
    const d = await r.json();
    const frames = Array.isArray(d.frames) ? d.frames : [];

    // Render detached so a half-built history never flickers into the log.
    const holder = document.createElement("div");
    const realMsgs = el.msgs, realSpeaker = lastSpeaker;
    el.msgs = holder; lastSpeaker = null; renderingHistory = true;
    try { for (const f of frames) handleFrame(f); }
    finally { el.msgs = realMsgs; lastSpeaker = realSpeaker; renderingHistory = false; }

    const before = el.msgs.scrollHeight;
    const anchor = bar ? bar.nextSibling : el.msgs.firstChild;
    while (holder.firstChild) el.msgs.insertBefore(holder.firstChild, anchor);
    el.msgs.scrollTop += el.msgs.scrollHeight - before;
    markOverflow(el.msgs);

    historyFrom = Number(d.startOffset ?? 0) || 0;
    if (d.done || historyFrom <= 0) {
      bar?.remove();
      const top = document.createElement("div");
      top.className = "sys";
      top.textContent = "beginning of the conversation";
      el.msgs.insertBefore(top, el.msgs.firstChild);
    } else if (btn) {
      btn.disabled = false; btn.textContent = "load earlier messages";
    }
  } catch {
    if (btn) { btn.disabled = false; btn.textContent = "load earlier messages (retry)"; }
  } finally { historyBusy = false; }
}

// Reaching the top pulls the next page in, so scrolling back just works.
el.msgs.addEventListener("scroll", () => {
  if (el.msgs.scrollTop < 40 && historyFrom > 0 && !historyBusy) void loadHistory();
});

/* ---------------------------------------------------------------------------
 * Live turn status: "✻ Undulating… (5m 11s · ↓ 5.7k tokens)"
 *
 * Elapsed is measured here rather than taken from the stream — a turn's wall
 * clock is a property of watching it, and not every agent reports duration.
 * Tokens come from `message.usage` on assistant frames when the agent sends
 * it; agents that don't simply get a line without the token half.
 * ------------------------------------------------------------------------- */

// Gerunds, cycled so a long turn still looks alive when nothing else moves.
const GERUNDS = ["Undulating", "Percolating", "Ruminating", "Confabulating",
  "Effervescing", "Cogitating", "Marinating", "Noodling", "Simmering",
  "Puzzling", "Wrangling", "Tinkering", "Churning", "Brewing", "Whirring"];

let turn = null;         // { t0, out, word, wordAt, el, timer }
// Frames at or below this seq are replayed history, not live activity. Without
// this a reconnect replays old assistant frames and starts a phantom turn whose
// clock began whenever you happened to open the chat.
let replayThrough = -1;
// Byte offset in the transcript that the loaded history starts at; 0 means we
// are already showing the beginning of the conversation.
let historyFrom = 0;
let historyBusy = false;
// History frames carry no seq, so the replay test cannot recognise them. Without
// this they would look live and start a turn clock for a conversation that ended
// long ago — the same trap ready.seq posed, arriving by a different door.
let renderingHistory = false;
let pendingSay = false;
let pendingSayTimer = null;

function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return `${m}m ${r}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function fmtTok(n) {
  if (!n) return null;
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

function turnStart() {
  if (turn) return;
  const d = document.createElement("div");
  // Same grid as a message row (blank badge column + body) so the glyph lands
  // in the same column as every ● above it. A bespoke grid drifts out of
  // alignment the moment the message layout changes.
  d.className = "msg agent turnstat";
  turn = { t0: Date.now(), out: 0, sawWorking: false, lastFrame: Date.now(),
           word: GERUNDS[(Math.random() * GERUNDS.length) | 0],
           wordAt: Date.now(), el: d, timer: null };
  el.msgs.appendChild(d);
  turnTick();
  turn.timer = setInterval(turnTick, 1000);
}

const TURN_QUIET_MS = 25000;

function turnTick() {
  if (!turn) return;
  const now = Date.now();
  // Transcripts carry no `result` record, and the fleet's cached agent_status
  // can lag or sit at "unknown", so neither is a reliable end-of-turn signal on
  // its own. Silence is: once nothing has arrived for a while, the turn is over.
  if (now - turn.lastFrame > TURN_QUIET_MS) { turnEnd(null, null); return; }
  // Re-roll the word occasionally so a five-minute turn doesn't look stuck.
  if (now - turn.wordAt > 12000) {
    turn.word = GERUNDS[(Math.random() * GERUNDS.length) | 0];
    turn.wordAt = now;
  }
  const tok = fmtTok(turn.out);
  const bits = [fmtDur(now - turn.t0)];
  if (tok) bits.push(`↓ ${tok} tokens`);
  turn.el.innerHTML =
    `<div class="av blank"></div><div class="body"><div class="line">` +
    `<span class="glyph spark">✻</span><div class="tt">` +
    `<span class="tw">${esc(turn.word)}…</span> ` +
    `<span class="tm">(${esc(bits.join(" · "))})</span>` +
    `</div></div></div>`;
  // Keep the status pinned below whatever has been appended since.
  el.msgs.appendChild(turn.el);
  if (nearBottom()) scrollMsgs();
}

/** Fold the ticking line into a static record of what the turn cost. */
function turnEnd(usage, durationMs) {
  endToolGroup(true);
  if (!turn) return;
  clearInterval(turn.timer);
  const out = Math.max(turn.out, usage?.output_tokens ?? 0);
  const tok = fmtTok(out);
  const bits = [fmtDur(durationMs ?? (Date.now() - turn.t0))];
  if (tok) bits.push(`↓ ${tok} tokens`);
  turn.el.className = "msg agent turnstat done";
  turn.el.innerHTML =
    `<div class="av blank"></div><div class="body"><div class="line">` +
    `<span class="glyph spark">✻</span>` +
    `<div class="tt"><span class="tm">${esc(bits.join(" · "))}</span></div>` +
    `</div></div>`;
  el.msgs.appendChild(turn.el);
  turn = null;
}

function turnUsage(u) {
  if (!turn || !u) return;
  // Sum across the turn's API calls; each assistant frame reports its own.
  if (typeof u.output_tokens === "number") turn.out += u.output_tokens;
}

function nearBottom() {
  return el.msgs.scrollHeight - el.msgs.scrollTop - el.msgs.clientHeight < 120;
}

let lastSpeaker = null;          // suppress a repeated badge on the same speaker

function speakerOf(author, isAgent) {
  return isAgent ? `agent:${me?.agentName || "agent"}` : `user:${author || "user"}`;
}

/**
 * The badge column is sized to the widest name actually present, not to a fixed
 * guess. A fixed width either clips a long name or leaves a gutter of dead space
 * in front of every line when all the names are short.
 *
 * Measured rather than computed from character count: the badge is bold and
 * proportional, so "Jack(AI)" and "mexico" are not the same width at equal
 * length. One measure per NEW name, not per message.
 */
const seenNames = new Set();
let nameMeasure = null;

function fitBadgeColumn(label) {
  if (!label || seenNames.has(label)) return;
  seenNames.add(label);
  if (!nameMeasure) {
    nameMeasure = document.createElement("span");
    nameMeasure.className = "av avmeasure";
    el.msgs.appendChild(nameMeasure);
  }
  let widest = 0;
  for (const n of seenNames) {
    nameMeasure.textContent = n;
    widest = Math.max(widest, nameMeasure.offsetWidth);
  }
  // Floor keeps short-name conversations from looking cramped against the glyph;
  // ceiling stops one pathological name from eating the message column.
  const px = Math.min(220, Math.max(48, Math.ceil(widest) + 2));
  el.msgs.style.setProperty("--avw", `${px}px`);
}

function avatarHTML(author, isAgent, repeat) {
  const raw = isAgent ? `${me?.agentName || "agent"}(AI)` : (author || "user");
  fitBadgeColumn(raw);
  return `<span class="av${repeat ? " blank" : ""}">${esc(raw)}</span>`;
}

/**
 * One rendered line. The badge is drawn only when the speaker changes — an
 * agent turn is often a dozen frames (thinking, tool call, result, text) and
 * stamping every one of them was the main source of noise.
 */
function msgBlock(author, isAgent, innerHTML) {
  collapseLive();
  const who = speakerOf(author, isAgent);
  const repeat = who === lastSpeaker;
  lastSpeaker = who;
  const mine = !isAgent && author === me?.label;
  const d = document.createElement("div");
  d.className = `msg ${isAgent ? "agent" : "user"}${mine ? " me" : ""}${repeat ? "" : " turn"}`;
  d.innerHTML = `${avatarHTML(author, isAgent, repeat)}<div class="body">${innerHTML}</div>`;
  el.msgs.appendChild(d);
  markOverflow(d);
  scrollMsgs();
  return d;
}

/**
 * Minimal markdown -> HTML. Agents write markdown; showing it raw means reading
 * literal asterisks and backticks, which is what a chat view exists to avoid.
 *
 * Safety: fenced code is lifted out FIRST so its contents are never transformed,
 * then the whole string is HTML-escaped, and only then are tags introduced. No
 * path puts unescaped source into the output.
 */
function mdToHtml(src) {
  const fences = [];
  let s = String(src).replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    fences.push({ lang, code });
    return `\x01F${fences.length - 1}\x01`;
  });
  s = esc(s);

  const inline = (t) => t
    .replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    // Only http(s) — a markdown link must never become javascript: or data:.
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  for (const raw of s.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (/^\x01F\d+\x01$/.test(line.trim())) { closeList(); out.push(line.trim()); continue; }
    if (!line.trim()) { closeList(); continue; }

    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      closeList();
      const lv = Math.min(6, m[1].length);
      out.push(`<h${lv}>${inline(m[2])}</h${lv}>`);
    } else if (/^(---+|\*\*\*+|___+)$/.test(line.trim())) {
      closeList(); out.push("<hr>");
    } else if ((m = line.match(/^\s*&gt;\s?(.*)$/))) {
      closeList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`);
    } else if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
      if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else {
      closeList(); out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();

  return out.join("").replace(/\x01F(\d+)\x01/g, (_m, i) => {
    const f = fences[Number(i)];
    return `<pre class="code"><code>${esc(f.code.replace(/\n$/, ""))}</code></pre>`;
  });
}

/**
 * Transient output — a tool result, a block of reasoning — renders EXPANDED
 * while it is the newest thing on screen, then collapses as soon as the next
 * frame arrives. That is how the terminal behaves: you watch it happen, and
 * afterwards it gets out of the way. Clicking a collapsed block reopens it.
 *
 * `live` marks the currently-expanded block; `collapseLive()` retires it.
 */
function clamped(html, cls, live = false) {
  const open = live ? " open" : "";
  return `<div class="clampwrap${live ? " isopen" : ""}">` +
    `<div class="${cls} clamp${live ? " live" : ""}${open}">${html}</div>` +
    `<button class="clamptog" type="button">${live ? "collapse" : "expand"}</button>` +
    `</div>`;
}

/**
 * Show the toggle only where the content actually overflows. Measured after
 * insertion because a block's height is not knowable from its markup.
 */
function markOverflow(root) {
  for (const w of root.querySelectorAll(".clampwrap")) {
    const c = w.querySelector(".clamp");
    if (!c) continue;
    const over = c.scrollHeight > c.clientHeight + 2 || w.classList.contains("isopen");
    w.classList.toggle("overflowing", over);
  }
}

function collapseLive() {
  for (const n of el.msgs.querySelectorAll(".clamp.live")) {
    n.classList.remove("live");
    const wrap = n.closest(".clampwrap");
    // Only actually collapse blocks tall enough to be worth hiding; a
    // three-line result flapping shut looks like a glitch.
    const shut = n.scrollHeight > 190;
    n.classList.toggle("open", !shut);
    if (wrap) {
      wrap.classList.toggle("isopen", !shut);
      const b = wrap.querySelector(".clamptog");
      if (b) b.textContent = shut ? "expand" : "collapse";
      markOverflow(wrap.parentNode || el.msgs);
    }
  }
}
el.msgs.addEventListener("click", (e) => {
  const hdr = e.target.closest(".tghdr");
  if (hdr) {
    const root = hdr.closest(".toolgroup");
    if (root) { setGroupOpen(root, !root.classList.contains("open")); markOverflow(root); }
    return;
  }
  const wrap = e.target.closest(".clampwrap");
  if (!wrap) return;
  // The block itself scrolls and can be selected, so only the toggle flips it.
  // Clicking the body to expand also meant every drag-select expanded a block.
  if (!e.target.closest(".clamptog")) return;
  const c = wrap.querySelector(".clamp");
  if (!c) return;
  const nowOpen = !c.classList.contains("open");
  c.classList.toggle("open", nowOpen);
  wrap.classList.toggle("isopen", nowOpen);
  e.target.textContent = nowOpen ? "collapse" : "expand";
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
    // `ready.seq` is a high-water mark: everything up to it is backlog.
    replayThrough = typeof f.seq === "number" ? f.seq : -1;
    if (turn) { clearInterval(turn.timer); turn = null; }
    toolGroup = null;
    el.msgs.innerHTML = "";
    historyFrom = Number(f.historyFrom ?? 0) || 0;
    if (historyFrom > 0) el.msgs.appendChild(makeLoadMore());
    appendSys(f.source === "transcript"
      ? `reading the session transcript${f.session ? ` · ${f.session}` : ""} — history and live updates, replies go in as keystrokes`
      : `connected to ${f.agent ?? "agent"}${f.session ? ` · ${f.session}` : ""}`);
    return;
  }
  if (f.type === "_queued") {
    // The agent's own copy arrives via the transcript a moment later; until it
    // does, say so rather than leaving an empty composer as the only feedback.
    pendingSay = true;
    el.chatq.textContent = f.state && f.state !== "sent" ? `sending… (${f.state})` : "sending…";
    clearTimeout(pendingSayTimer);
    pendingSayTimer = setTimeout(() => { pendingSay = false; el.chatq.textContent = ""; }, 20000);
    return;
  }
  if (f.type === "_sayfailed") {
    pendingSay = false; clearTimeout(pendingSayTimer); el.chatq.textContent = "";
    appendSys(`send failed: ${f.reason ?? "unknown"}`);
    return;
  }
  if (f.type === "_nostream") { appendSys("this agent does not expose a structured stream"); return; }
  if (f.type === "_closed")   { appendSys(`stream closed: ${f.reason ?? ""}`); return; }
  if (f.type === "participants") return;
  // A completed turn is "done" even if no further frame follows it.
  if (f.type === "frame" && f.msg?.type === "result") {
    collapseLive();
    endToolGroup(true);
    turnEnd(f.msg.usage, f.msg.duration_ms);
    return;
  }
  if (f.type === "error") { appendSys(`agent refused: ${f.code ?? "error"} ${f.message ?? ""}`); return; }

  // A HITL request means a turn is in flight and waiting on a human — that is
  // still "working" and deserves the status line. These return early, so the
  // turn has to start here or a permission-first turn shows nothing at all.
  const liveHitl = !renderingHistory && !(typeof f.seq === "number" && f.seq <= replayThrough);
  if (f.type === "permission_request") { if (liveHitl) turnStart(); renderPermission(f); return; }
  if (f.type === "question_request")   { if (liveHitl) turnStart(); renderQuestion(f); return; }
  if (f.type === "permission_resolved" || f.type === "question_resolved") { resolveHitl(f); return; }

  if (f.type !== "frame") return;
  const msg = f.msg ?? {};
  const role = msg.message?.role ?? (msg.type === "assistant" ? "assistant" : "user");
  const isAgent = role === "assistant";
  const content = msg.message?.content;

  if (msg.type === "system") {
    // Hooks write their own bookkeeping records into the transcript. They are
    // machinery, not conversation, and printing every one buried the messages.
    const SHOW = new Set(["init", "compact_boundary", "error"]);
    if (SHOW.has(msg.subtype)) {
      appendSys(`${msg.subtype}${msg.model ? ` · ${msg.model}` : ""}`);
    }
    return;
  }
  const isReplay = renderingHistory || (typeof f.seq === "number" && f.seq <= replayThrough);
  if (turn && !isReplay) turn.lastFrame = Date.now();
  if (pendingSay && !isReplay && role === "user") {
    pendingSay = false; clearTimeout(pendingSayTimer); el.chatq.textContent = "";
  }
  if (isAgent && !isReplay) { turnStart(); turnUsage(msg.message?.usage); }
  if (!Array.isArray(content)) return;

  for (const c of content) {
    // Glyphs and nesting follow the agent's own terminal rendering: a bullet
    // opens a turn, and ⎿ attaches a result to the call that produced it. The
    // hierarchy is the point — a flat list loses which output came from where.
    if (c.type === "text" && c.text?.trim()) {
      endToolGroup(!renderingHistory);
      const t = `<div class="md">${mdToHtml(c.text)}</div>`;
      msgBlock(f.author, isAgent,
        `<div class="line"><span class="glyph dot">●</span>` +
        (c.text.length > 2600 ? clamped(t, "txt") : `<div class="txt">${t}</div>`) + `</div>`);
    } else if (c.type === "thinking" && c.thinking?.trim()) {
      endToolGroup(!renderingHistory);
      const t = `<div class="md">${mdToHtml(c.thinking)}</div>`;
      msgBlock(f.author, true,
        `<div class="line"><span class="glyph spark">✳</span>` +
        clamped(t, "think", true) + `</div>`);
    } else if (c.type === "tool_use") {
      appendTool(f.author,
        `<div class="line"><span class="glyph dot">●</span>` +
        `<div class="tool">${toolLine(c.name, c.input)}</div></div>`, c.name || "tool", !isReplay);
    } else if (c.type === "tool_result") {
      const body = typeof c.content === "string" ? c.content : JSON.stringify(c.content ?? "");
      const err = /^(exit code [1-9]|fatal:|error|traceback)/i.test(body.trim());
      const t = esc(body.trim());
      appendTool(f.author,
        `<div class="line nested"><span class="glyph hook">⎿</span>` +
        clamped(t, `out${err ? " err" : ""}`, !isReplay) + `</div>`, null, !isReplay);
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
  // An attachment alone is a valid message — the paths are the content.
  const text = withAttachments(el.cin.value);
  if (!text.trim() || streamSock?.readyState !== 1) return;
  streamSock.send(JSON.stringify({ type: "say", text }));
  el.cin.value = "";
  clearAttachments();
}
