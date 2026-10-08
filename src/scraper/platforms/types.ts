/** Fetches a text file of the site; undefined when it is not there. */
export type FetchText = (url: string) => Promise<string | undefined>;

/** What a platform adapter found on a site. */
export interface DetectedPlatform {
  /** Name of the witness in coverage, e.g. "sphinx index". */
  witness: string;
  /** Pages the generator's own index lists. */
  pages: string[];
  /**
   * Where the generator publishes a page's source text, by page URL, for the
   * pages whose source reads better than the rendered page.
   */
  sources?: Map<string, string>;
}

/**
 * Knowledge about one documentation generator. It recognises the generator
 * from an entry point's HTML and turns the indexes the generator publishes
 * into a witness and per-page sources. Never knowledge about one site.
 */
export interface PlatformAdapter {
  name: string;
  /**
   * @param pageUrl The entry point.
   * @param html The entry point's HTML as served.
   * @param fetchText Reads the generator's index files.
   * @returns What was found, or null when the site is not built with this generator.
   */
  detect(
    pageUrl: string,
    html: string,
    fetchText: FetchText,
  ): Promise<DetectedPlatform | null>;
}

/** Resolves a relative reference against a base, null when invalid. */
export function resolve(reference: string, base: string): string | null {
  try {
    return new URL(reference, base).href;
  } catch {
    return null;
  }
}

/** The page's directory and each ancestor up to the host root, deepest first. */
export function ancestorDirectories(pageUrl: string): string[] {
  const url = new URL(pageUrl);
  const parts = url.pathname.split("/").slice(1, -1);
  const dirs: string[] = [];
  for (let i = parts.length; i >= 0; i--) {
    dirs.push(
      `${url.origin}/${parts
        .slice(0, i)
        .map((p) => `${p}/`)
        .join("")}`,
    );
  }
  return dirs;
}
