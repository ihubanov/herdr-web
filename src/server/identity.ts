/**
 * User identity for herdr-web.
 *
 * The spec is a comma-separated list of name:token pairs
 * ("alice:tokA,bob:tokB"). A single `HERDR_WEB_TOKEN` keeps working alongside
 * it as an admin account.
 *
 * herdr-web owns identity, not the agent: it authenticates the human and is the
 * authority on who said what. An agent may render the `author` we pass, but must
 * never trust it for anything security-relevant (see docs/PROTOCOL.md §3).
 */
import { timingSafeEqual, randomBytes } from "node:crypto";

export interface User {
  /** Display name. "admin" for the admin token — attributed like anyone else,
   *  because an anonymous voice in a shared chat is confusing, not a privilege. */
  name: string;
  isAdmin: boolean;
}

/** Constant-time compare, length-guarded (timingSafeEqual throws on mismatch). */
function eq(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Parse "alice:tokA,alice:tokB" into name -> token.
 * Only the first ':' splits, so tokens may contain colons. Blank or malformed
 * entries are skipped; a later duplicate name overrides an earlier one.
 */
export function parseUsers(spec: string | undefined): Map<string, string> {
  const users = new Map<string, string>();
  if (!spec) return users;
  for (const pair of spec.split(",")) {
    const s = pair.trim();
    if (!s) continue;
    const i = s.indexOf(":");
    if (i <= 0) continue;
    const name = s.slice(0, i).trim();
    const token = s.slice(i + 1).trim();
    if (name && token) users.set(name, token);
  }
  return users;
}

export class Identity {
  private readonly users: Map<string, string>;
  readonly adminToken: string;
  /** True when named users are configured; otherwise single-operator mode. */
  readonly multiuser: boolean;

  constructor(spec = process.env.HERDR_WEB_USERS, adminToken = process.env.HERDR_WEB_TOKEN) {
    this.users = parseUsers(spec);
    this.adminToken = adminToken || randomBytes(24).toString("hex");
    this.multiuser = this.users.size > 0;
  }

  /** Resolve a presented token to a user, or null to reject. Admin wins first. */
  resolve(token: string | null | undefined): User | null {
    if (!token) return null;
    if (eq(token, this.adminToken)) return { name: "admin", isAdmin: true };
    for (const [name, tok] of this.users) {
      if (eq(token, tok)) return { name, isAdmin: false };
    }
    return null;
  }

  /** Display label for a resolved user. */
  static label(u: User): string {
    return u.name || "operator";
  }

  names(): string[] {
    return [...this.users.keys()];
  }

  /** One line per user for the startup banner. Never prints tokens. */
  describe(): string {
    if (!this.multiuser) return "single operator (HERDR_WEB_TOKEN)";
    return `${this.users.size} named users: ${this.names().join(", ")} (+ admin token)`;
  }
}
