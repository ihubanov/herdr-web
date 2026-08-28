/**
 * Fleet state tracker.
 *
 * herdr reports each pane's current `agent_status` but not *how long* it has
 * held that status — the TUI does not need it, a triage view does. We derive it
 * by keeping a resident map and stamping the transition ourselves.
 *
 * Refresh strategy: herdr pushes lifecycle events cheaply, but the events carry
 * partial payloads. We use events purely as a "something changed" signal and
 * re-read the authoritative lists, debounced. pane.list is cheap.
 */
import { call, subscribe } from "./herdr-socket.ts";

export type Status = "blocked" | "working" | "idle" | "unknown";

/** Triage order: who needs a human first. */
export const STATUS_RANK: Record<string, number> = {
  blocked: 0, working: 1, idle: 2, unknown: 3,
};

export interface FleetEntry {
  pane_id: string;
  terminal_id?: string;
  workspace_id: string;
  workspace_label: string;
  tab_id?: string;
  tab_label?: string;
  agent: string | null;
  /** Stable herdr-side name (tab label). This is what the user controls. */
  title: string;
  /** What the agent set as its terminal title — the current task, when it adds
   *  anything beyond the stable name. Generic defaults are dropped. */
  task?: string;
  cwd: string;
  agent_status: Status;
  /** epoch ms when agent_status last changed (best effort: since we first saw it) */
  since: number;
  repo?: string;
  branch?: string;
  focused: boolean;
  /** Tail of the pane's visible screen. Populated for blocked panes only —
   *  reading every pane on every refresh would be wasteful. */
  preview?: string[];
}

interface Tracked { status: Status; since: number }

const tracked = new Map<string, Tracked>();
/** keyed by cwd, not workspace — see repoForCwd */
const repoCache = new Map<string, { repo?: string; branch?: string; at: number }>();
let snapshot: FleetEntry[] = [];
let listeners: Array<(f: FleetEntry[]) => void> = [];
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;

const REPO_TTL_MS = 30_000;
const PREVIEW_LINES = 14;

/** preview cache keyed by pane; invalidated when the pane's revision moves */
const previewCache = new Map<string, { rev: unknown; lines: string[] }>();

/**
 * Last meaningful lines of a pane's visible screen, so a blocked card can show
 * *what* is being asked. Trailing blank lines and box-drawing filler are
 * dropped — agents pad the viewport and the raw tail is mostly empty.
 */
async function previewFor(paneId: string, revision: unknown): Promise<string[] | undefined> {
  const hit = previewCache.get(paneId);
  if (hit && hit.rev === revision) return hit.lines;
  try {
    const res = await call("pane.read", {
      pane_id: paneId, source: "visible", format: "text", lines: 60, strip_ansi: true,
    });
    const raw = String(res?.read?.text ?? "");
    const lines = raw
      .split("\n")
      .map((l) => l.replace(/\s+$/, ""))
      .filter((l) => l.trim().length > 0)
      .slice(-PREVIEW_LINES);
    previewCache.set(paneId, { rev: revision, lines });
    return lines;
  } catch {
    return undefined;
  }
}

/** Titles agents set when they have nothing specific to say. */
const GENERIC_TITLES = new Set([
  "claude code", "claude", "codex", "copilot", "cursor", "droid", "grok",
  "opencode", "qwen", "devin", "shell", "bash", "zsh", "fish",
]);

/**
 * The agent's terminal title, but only when it adds information over the tab
 * label. Returns undefined for generic defaults or near-duplicates.
 */
function agentTask(p: any, label?: string): string | undefined {
  const t = String(p.terminal_title_stripped || "").trim();
  if (!t) return undefined;
  if (GENERIC_TITLES.has(t.toLowerCase())) return undefined;
  if (label && t.toLowerCase() === label.toLowerCase()) return undefined;
  return t;
}

function normStatus(s: unknown): Status {
  return s === "blocked" || s === "working" || s === "idle" ? s : "unknown";
}

/**
 * Repo name + branch for a pane, keyed by its cwd.
 *
 * Resolving per *workspace* is wrong: one herdr workspace routinely holds panes
 * in several different repos, and they would all inherit the workspace's repo.
 * worktree.list accepts a cwd, so ask about the directory the pane is actually in.
 */
async function repoForCwd(cwd: string): Promise<{ repo?: string; branch?: string }> {
  if (!cwd) return {};
  const hit = repoCache.get(cwd);
  if (hit && Date.now() - hit.at < REPO_TTL_MS) return { repo: hit.repo, branch: hit.branch };
  try {
    const res = await call("worktree.list", { cwd });
    const repo = res?.source?.repo_name as string | undefined;
    const src = res?.source?.source_checkout_path as string | undefined;
    const wts = (res?.worktrees ?? []) as Array<any>;
    // Prefer the worktree that actually contains this cwd, then the source checkout.
    const contains = wts.find((w) => w.path && (cwd === w.path || cwd.startsWith(w.path + "/")));
    const match = contains ?? wts.find((w) => w.path === src) ?? wts[0];
    const branch = match?.is_detached ? "(detached)" : (match?.branch as string | undefined);
    repoCache.set(cwd, { repo, branch, at: Date.now() });
    return { repo, branch };
  } catch {
    // Not a git directory, or git unavailable — perfectly normal.
    repoCache.set(cwd, { at: Date.now() });
    return {};
  }
}

export async function refresh(): Promise<FleetEntry[]> {
  if (inFlight) return snapshot;
  inFlight = true;
  try {
    const [panesRes, wsRes] = await Promise.all([call("pane.list"), call("workspace.list")]);
    const panes = (panesRes.panes ?? []) as Array<any>;
    const wsLabel = new Map<string, string>();
    for (const w of wsRes.workspaces ?? []) wsLabel.set(w.workspace_id, w.label || w.workspace_id);

    // Tab labels are herdr's stable, user-controlled names. The agent-set
    // terminal title is often generic ("Claude Code"), so it cannot be primary.
    const tabLabel = new Map<string, string>();
    await Promise.all(
      [...wsLabel.keys()].map(async (wsId) => {
        try {
          const res = await call("tab.list", { workspace_id: wsId });
          for (const t of res.tabs ?? []) if (t.label) tabLabel.set(t.tab_id, t.label);
        } catch { /* workspace vanished mid-refresh */ }
      }),
    );

    const now = Date.now();
    const seen = new Set<string>();

    // Resolve repo info per distinct cwd, in parallel. Panes sharing a directory
    // share one lookup; panes in different repos get their own.
    const cwds = [...new Set(panes.map((p) => p.cwd).filter(Boolean))] as string[];
    const repos = new Map<string, { repo?: string; branch?: string }>();
    await Promise.all(cwds.map(async (c) => repos.set(c, await repoForCwd(c))));

    const next: FleetEntry[] = panes.map((p) => {
      const status = normStatus(p.agent_status);
      seen.add(p.pane_id);
      const prev = tracked.get(p.pane_id);
      if (!prev || prev.status !== status) {
        tracked.set(p.pane_id, { status, since: now });
      }
      const since = tracked.get(p.pane_id)!.since;
      const r = repos.get(p.cwd) ?? {};
      return {
        pane_id: p.pane_id,
        terminal_id: p.terminal_id,
        workspace_id: p.workspace_id,
        workspace_label: wsLabel.get(p.workspace_id) ?? p.workspace_id,
        tab_id: p.tab_id,
        tab_label: tabLabel.get(p.tab_id),
        agent: p.agent ?? null,
        title: tabLabel.get(p.tab_id) || p.terminal_title_stripped || p.terminal_title || p.pane_id,
        task: agentTask(p, tabLabel.get(p.tab_id)),
        cwd: p.cwd ?? "",
        agent_status: status,
        since,
        repo: r.repo,
        branch: r.branch,
        focused: !!p.focused,
      };
    });

    // Drop panes that no longer exist so `since` / previews do not leak.
    for (const id of [...tracked.keys()]) if (!seen.has(id)) tracked.delete(id);
    for (const id of [...previewCache.keys()]) if (!seen.has(id)) previewCache.delete(id);

    // Fetch context only for panes that need a human — that is the whole point
    // of the preview, and it keeps the per-refresh read count near zero.
    const revById = new Map(panes.map((p) => [p.pane_id, p.revision]));
    await Promise.all(
      next
        .filter((e) => e.agent_status === "blocked")
        .map(async (e) => { e.preview = await previewFor(e.pane_id, revById.get(e.pane_id)); }),
    );

    next.sort((a, b) => {
      const d = STATUS_RANK[a.agent_status] - STATUS_RANK[b.agent_status];
      if (d !== 0) return d;
      return a.since - b.since; // longest in state first
    });

    snapshot = next;
    for (const fn of listeners) fn(snapshot);
    return snapshot;
  } finally {
    inFlight = false;
  }
}

function scheduleRefresh(delay = 200) {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { refresh().catch(() => {}); }, delay);
}

export function getFleet(): FleetEntry[] { return snapshot; }

export function onFleet(fn: (f: FleetEntry[]) => void): () => void {
  listeners.push(fn);
  return () => { listeners = listeners.filter((l) => l !== fn); };
}

/** Starts the resident tracker. Returns a stop function. */
export function startFleetTracker(): () => void {
  refresh().catch((e) => console.error("fleet: initial refresh failed:", e.message));

  const types = [
    "pane.created", "pane.closed", "pane.updated", "pane.focused",
    "pane.exited", "pane.agent_detected",
    "workspace.created", "workspace.closed", "workspace.renamed", "workspace.focused",
    "tab.created", "tab.closed",
  ];

  let stop: (() => void) | null = null;
  let stopped = false;

  const connect = () => {
    if (stopped) return;
    stop = subscribe(
      types.map((t) => ({ type: t })),
      () => scheduleRefresh(),
      (reason) => {
        if (stopped) return;
        console.error(`fleet: event stream closed (${reason}); reconnecting in 2s`);
        setTimeout(connect, 2000);
      },
    );
  };
  connect();

  // Safety net: herdr emits no event for a status that changes without a
  // lifecycle transition, so poll slowly as a floor.
  const poll = setInterval(() => scheduleRefresh(0), 10_000);

  return () => { stopped = true; clearInterval(poll); stop?.(); };
}
