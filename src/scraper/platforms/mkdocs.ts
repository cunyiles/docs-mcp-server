import { ancestorDirectories, type PlatformAdapter, resolve } from "./types";

/** MkDocs: the search index lists every page of the site. */
export const mkdocs: PlatformAdapter = {
  name: "mkdocs",
  async detect(pageUrl, html, fetchText) {
    if (!/<meta[^>]+name=["']generator["'][^>]+content=["']mkdocs/i.test(html))
      return null;
    // Material declares its base in a config block, the classic theme in a
    // variable; otherwise the index is looked for upwards from the page.
    const declared =
      /"base"\s*:\s*"([^"]*)"/.exec(html)?.[1] ??
      /base_url\s*=\s*["']([^"']*)["']/.exec(html)?.[1];
    const declaredRoot = declared !== undefined ? resolve(`${declared}/`, pageUrl) : null;
    for (const root of [
      ...(declaredRoot ? [declaredRoot] : []),
      ...ancestorDirectories(pageUrl),
    ]) {
      const text = await fetchText(`${root}search/search_index.json`);
      if (!text) continue;
      try {
        const index = JSON.parse(text) as { docs?: Array<{ location?: string }> };
        const pages = new Set<string>();
        for (const doc of index.docs ?? []) {
          const location = (doc.location ?? "").split("#")[0];
          const url = resolve(location, root);
          if (url) pages.add(url);
        }
        return { witness: "mkdocs index", pages: [...pages] };
      } catch {}
    }
    return null;
  },
};
