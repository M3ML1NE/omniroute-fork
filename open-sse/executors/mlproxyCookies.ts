/**
 * Cookie and secret redaction helpers for the mlproxy executor.
 *
 * - parseSetCookies: extracts name=value pairs from Set-Cookie headers using
 *   the undici-compatible getSetCookie() method (preserves multi-cookie responses).
 * - redactSecret: masks any non-empty value for safe logging.
 * - redactMlproxyAuthBody: returns a shallow copy of an auth body with
 *   password (and optionally login) replaced by "***".
 *
 * Security: never log real Set-Cookie or Cookie values — always redact to "***".
 */

/**
 * Parse Set-Cookie response headers into a single cookie string of name=value pairs,
 * stripping all cookie attributes (Path, Expires, HttpOnly, Secure, SameSite, etc.).
 *
 * Uses res.headers.getSetCookie() (returns string[]) to correctly handle multiple
 * Set-Cookie headers — do NOT use headers.get("set-cookie") which would corrupt
 * multi-cookie responses by comma-joining them.
 *
 * @param res - A Response whose headers may contain Set-Cookie lines.
 * @returns Cookie string like "sid=abc; csrf=xyz", or "" if no cookies.
 */
export function parseSetCookies(res: Response): string {
  const raw = res.headers.getSetCookie();
  if (!raw || raw.length === 0) return "";

  const pairs: string[] = [];
  for (const line of raw) {
    // "name=value; Path=/; HttpOnly" → extract first "name=value"
    const first = line.split(";")[0];
    if (first && first.includes("=")) {
      pairs.push(first.trim());
    }
  }

  return pairs.join("; ");
}

/**
 * Redact a secret value for safe logging.
 * Returns "***" for any non-empty value, empty string otherwise.
 *
 * @param s - The value to redact.
 * @returns "***" if the input is truthy (non-empty string/number/object), "" otherwise.
 */
export function redactSecret(s: unknown): string {
  if (s === null || s === undefined) return "";
  const str = String(s);
  return str.length > 0 ? "***" : "";
}

/**
 * Return a shallow copy of an mlproxy auth body with sensitive fields redacted.
 *
 * Replaces `password` (and optionally `login`) with "***" so the body can be
 * safely logged without leaking credentials.
 *
 * @param body - The auth request body (login, password, and optional extra fields).
 * @returns A new object with sensitive fields redacted.
 */
export function redactMlproxyAuthBody(body: {
  login?: string;
  password?: string;
  [key: string]: unknown;
}): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === "password") {
      copy[k] = "***";
    } else if (k === "login") {
      copy[k] = "***";
    } else {
      copy[k] = v;
    }
  }
  return copy;
}
