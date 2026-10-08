import { type PlatformAdapter, resolve } from "./types";

interface NavigatorNode {
  path?: string;
  children?: NavigatorNode[];
}

/**
 * DocC: pages are rendered in the browser, but the navigator index lists every
 * page of a framework. Static DocC archives serve it as `index/index.json`;
 * hosts that serve one index per module use `data/index/<module>`.
 */
export const docc: PlatformAdapter = {
  name: "docc",
  async detect(pageUrl, html, fetchText) {
    // The DocC renderer's shell: an empty app mount and its bundle.
    const bundle =
      /<script[^>]+src=["']([^"']*\/)js\/(?:chunk-vendors|index)[^"']*["']/i.exec(
        html,
      )?.[1];
    if (!bundle || !/<div id=["']app["']/i.test(html)) return null;
    const root = resolve(bundle, pageUrl);
    if (!root) return null;
    const module = /\/documentation\/([^/]+)/i.exec(new URL(pageUrl).pathname)?.[1];
    const candidates = [
      `${root}index/index.json`,
      ...(module ? [`${root}data/index/${module.toLowerCase()}`] : []),
    ];
    for (const candidate of candidates) {
      const text = await fetchText(candidate);
      if (!text) continue;
      try {
        const index = JSON.parse(text) as {
          interfaceLanguages?: Record<string, NavigatorNode[]>;
        };
        const pages = new Set<string>();
        const walk = (nodes: NavigatorNode[] = []) => {
          for (const node of nodes) {
            const url = node.path ? resolve(node.path, pageUrl) : null;
            if (url) pages.add(url);
            walk(node.children);
          }
        };
        for (const tree of Object.values(index.interfaceLanguages ?? {})) walk(tree);
        if (pages.size > 0) return { witness: "docc index", pages: [...pages] };
      } catch {}
    }
    return null;
  },
};
