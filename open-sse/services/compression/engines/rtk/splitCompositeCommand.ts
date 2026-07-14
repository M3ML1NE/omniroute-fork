/**
 * Quote-aware composite-command splitter.
 *
 * Splits a shell command string on top-level `&&`, `||`, or `;` separators (those NOT
 * inside single quotes, double quotes, backtick subshells, or `$(...)` subshells) and
 * returns the LAST significant segment (trimmed). No separator ⇒ input unchanged. Empty
 * last segment (trailing separator) ⇒ falls back to the previous non-empty one. O(n)
 * char-by-char scan with zero RegExp over the input (anti-ReDoS).
 */
export function lastCommandSegment(command: string): string {
  if (!command) return command;

  const segments: string[] = [];
  let current = 0;
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;

  const push = (end: number): void => {
    segments.push(command.slice(current, end));
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inBacktick) {
      if (ch === "`") inBacktick = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      if (ch === "$" && command[i + 1] === "(") {
        depth++;
        i++;
      }
      continue;
    }
    if (depth > 0) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "`") {
      inBacktick = true;
      continue;
    }
    if (ch === "$" && command[i + 1] === "(") {
      depth++;
      i++;
      continue;
    }
    if (ch === "(") {
      depth++;
      continue;
    }

    if (ch === "&" && command[i + 1] === "&") {
      push(i);
      i += 1;
      current = i + 1;
      continue;
    }
    if (ch === "|" && command[i + 1] === "|") {
      push(i);
      i += 1;
      current = i + 1;
      continue;
    }
    if (ch === ";") {
      push(i);
      current = i + 1;
      continue;
    }
  }

  push(command.length);

  if (segments.length === 1) {
    return command;
  }

  for (let i = segments.length - 1; i >= 0; i--) {
    const trimmed = segments[i].trim();
    if (trimmed) return trimmed;
  }

  return command;
}
