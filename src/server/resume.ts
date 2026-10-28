/**
 * The resume contract with the agent launcher (HERDR_WEB_RESUME): ONE env var
 * prepended to the launch command, nothing else changes. Shared by the "+"
 * dialog's picker (which builds it in the browser) and POST /api/resume (which
 * builds it here, so an embedding host needs one call instead of two).
 */

/** A session id goes into a shell command line, so only this shape is accepted. */
export const SESSION_ID_RE = /^[A-Za-z0-9-]{1,128}$/;

/**
 * The command that reopens `sessionId` in a fresh shell, or null when it
 * cannot be built: no launch command configured, or an id that is not safe to
 * put on a command line.
 */
export function resumeCommand(base: string, sessionId: string, skipPermissions = false): string | null {
  const cmd = base.trim();
  if (!cmd || !SESSION_ID_RE.test(sessionId)) return null;
  return `HERDR_UI_RESUME=${sessionId} ${cmd}${skipPermissions ? " --dangerously-skip-permissions" : ""}`;
}
