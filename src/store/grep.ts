import vm from "node:vm";

/** One line of one page that matched a grep pattern. */
export interface GrepMatch {
  url: string;
  /** 1-based line number in the page's Markdown. */
  line: number;
  /** The matching line, shortened around the match. */
  text: string;
}

/** Matches found, the first `limit` of them, and how many there were in all. */
export interface GrepResult {
  matches: GrepMatch[];
  total: number;
}

/** A pattern that is not a valid regular expression, or one too slow to run. */
export class GrepPatternError extends Error {}

const MAX_PATTERN_LENGTH = 1000;
const EXCERPT_LENGTH = 200;
/** Time a whole grep may spend inside regular expressions. */
const REGEX_BUDGET_MS = 5000;

const findLines = new vm.Script(
  "lines.flatMap((line, i) => { re.lastIndex = 0; return re.test(line) ? [i] : []; })",
);

/**
 * Parses a grep pattern: `/source/flags` is a regular expression, anything else
 * is literal text.
 *
 * @throws GrepPatternError When the pattern is empty, too long or an invalid regex.
 */
export function parseGrepPattern(pattern: string): RegExp | string {
  if (!pattern) throw new GrepPatternError("Pattern must not be empty.");
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new GrepPatternError(
      `Pattern is longer than ${MAX_PATTERN_LENGTH} characters.`,
    );
  }
  const regex = /^\/(.+)\/([a-z]*)$/s.exec(pattern);
  if (!regex) return pattern;
  try {
    return new RegExp(regex[1], regex[2].replace(/[gy]/g, ""));
  } catch (error) {
    throw new GrepPatternError(
      `Invalid regular expression ${pattern}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

function excerpt(line: string, at: number): string {
  const trimmed = line.trim();
  if (trimmed.length <= EXCERPT_LENGTH) return trimmed;
  const start = Math.max(
    0,
    Math.min(at - EXCERPT_LENGTH / 2, line.length - EXCERPT_LENGTH),
  );
  return `…${line.slice(start, start + EXCERPT_LENGTH).trim()}…`;
}

/**
 * Finds the lines of each page that contain `pattern`.
 *
 * Regular expressions run under a time budget, so a pattern with catastrophic
 * backtracking fails the call instead of stalling the server.
 *
 * @param pages Pages to search, in the order results should appear.
 * @param pattern Literal text or a parsed regular expression.
 * @param limit Matches to return; the rest are only counted.
 * @throws GrepPatternError When a regular expression exceeds the time budget.
 */
export function grepPages(
  pages: Iterable<{ url: string; markdown: string }>,
  pattern: RegExp | string,
  limit: number,
): GrepResult {
  const matches: GrepMatch[] = [];
  let total = 0;
  const deadline = Date.now() + REGEX_BUDGET_MS;
  const context = typeof pattern === "string" ? null : vm.createContext({ re: pattern });
  for (const page of pages) {
    const lines = page.markdown.split("\n");
    let hits: number[];
    if (context) {
      context.lines = lines;
      const timeout = deadline - Date.now();
      try {
        if (timeout <= 0) throw new Error("budget spent");
        hits = findLines.runInContext(context, { timeout }) as number[];
      } catch {
        throw new GrepPatternError(
          "Regular expression took too long; use a simpler pattern or literal text.",
        );
      }
    } else {
      hits = lines.flatMap((line, i) => (line.includes(pattern as string) ? [i] : []));
    }
    for (const i of hits) {
      total++;
      if (matches.length >= limit) continue;
      const at =
        typeof pattern === "string"
          ? lines[i].indexOf(pattern)
          : lines[i].search(pattern);
      matches.push({ url: page.url, line: i + 1, text: excerpt(lines[i], at) });
    }
  }
  return { matches, total };
}
