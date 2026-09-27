import * as cheerio from "cheerio";

/**
 * Visible text below which a page that runs scripts is taken for an empty
 * JavaScript shell. A server-rendered page carries its content in the HTML,
 * whatever framework marks it up; a shell carries a mount point and a bundle.
 */
const SHELL_TEXT_CHARS = 100;

/**
 * Decides whether served HTML needs a browser to show its content.
 *
 * True for an empty JavaScript shell (scripts, next to no visible text) and for
 * a frameset, whose content lives in other documents. Everything else is read
 * as served, which is what keeps a browser from starting on ordinary sites.
 *
 * @param html The HTML as the server sent it.
 * @returns True when the page should be rendered in a browser.
 */
export function needsBrowserRendering(html: string): boolean {
  const $ = cheerio.load(html);
  if ($("frameset").length > 0) return true;
  if ($("script").length === 0) return false;
  $("script, style, noscript, template, head").remove();
  const text = $("body").text().replace(/\s+/g, " ").trim();
  return text.length < SHELL_TEXT_CHARS;
}
