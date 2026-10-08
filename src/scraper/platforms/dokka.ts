import { type PlatformAdapter, resolve } from "./types";

/** Dokka: `scripts/pages.json` names every symbol page of the API reference. */
export const dokka: PlatformAdapter = {
  name: "dokka",
  async detect(pageUrl, html, fetchText) {
    const pathToRoot = /var\s+pathToRoot\s*=\s*["']([^"']*)["']/.exec(html)?.[1];
    if (pathToRoot === undefined || !/dokka/i.test(html)) return null;
    const root = resolve(pathToRoot || "./", pageUrl);
    const text = root ? await fetchText(`${root}scripts/pages.json`) : undefined;
    if (!root || !text) return null;
    try {
      const entries = JSON.parse(text) as Array<{ location?: string }>;
      const pages = new Set<string>();
      for (const entry of entries) {
        const url = entry.location ? resolve(entry.location.split("#")[0], root) : null;
        if (url) pages.add(url);
      }
      return { witness: "dokka index", pages: [...pages] };
    } catch {
      return null;
    }
  },
};
