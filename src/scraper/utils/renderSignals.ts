/**
 * Visible text below which a page that runs scripts is taken for an empty
 * JavaScript shell. A server-rendered page carries its content in the HTML,
 * whatever framework marks it up; a shell carries a mount point and a bundle.
 */
const SHELL_TEXT_CHARS = 100;

/** Elements whose content is never visible page text. */
const INVISIBLE = /<(script|style|noscript|template|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/**
 * Decides whether served HTML needs a browser to show its content.
 *
 * True for an empty JavaScript shell (scripts, next to no visible text) and for
 * a frameset, whose content lives in other documents. Everything else is read
 * as served, which is what keeps a browser from starting on ordinary sites.
 *
 * Decided by a linear scan rather than a parsed DOM: it runs for every HTML
 * page, and parsing a multi-megabyte reference page only to find it has text
 * cost seconds on the thread that answers requests.
 *
 * @param html The HTML as the server sent it.
 * @returns True when the page should be rendered in a browser.
 */
export function needsBrowserRendering(html: string): boolean {
  if (/<frameset\b/i.test(html)) return true;
  if (!/<script\b/i.test(html)) return false;
  const body = html.replace(/<!--[\s\S]*?-->/g, "").replace(INVISIBLE, " ");
  let visible = 0;
  // Counts visible characters, stopping as soon as there are enough.
  for (const text of body.split(/<[^>]*>/)) {
    visible += text
      .replace(/&[a-z#0-9]+;/gi, "x")
      .replace(/\s+/g, " ")
      .trim().length;
    if (visible >= SHELL_TEXT_CHARS) return false;
  }
  return true;
}
