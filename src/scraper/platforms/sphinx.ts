import { type PlatformAdapter, resolve } from "./types";

/**
 * Sphinx (and Read the Docs): `searchindex.js` lists every document, and
 * `_sources/` holds each one's source. Markdown sources are read from there;
 * reStructuredText reads better rendered, so those pages are fetched as HTML.
 */
export const sphinx: PlatformAdapter = {
  name: "sphinx",
  async detect(pageUrl, html, fetchText) {
    const optionsSrc =
      /<script[^>]+src=["']([^"']*_static\/documentation_options\.js)[^"']*["']/i.exec(
        html,
      )?.[1];
    if (!optionsSrc && !/<meta[^>]+content=["']Sphinx/i.test(html)) return null;
    const optionsUrl = optionsSrc ? resolve(optionsSrc, pageUrl) : null;
    const root = optionsUrl ? resolve("../", optionsUrl) : null;
    if (!root) return null;

    const options = (optionsUrl && (await fetchText(optionsUrl))) || "";
    const option = (name: string, fallback: string) =>
      new RegExp(`${name}\\s*:\\s*['"]([^'"]*)['"]`).exec(options)?.[1] ?? fallback;
    const builder = option("BUILDER", "html");
    const fileSuffix = option("FILE_SUFFIX", ".html");
    const sourceSuffix = option("SOURCELINK_SUFFIX", ".txt");

    const script = await fetchText(`${root}searchindex.js`);
    const json = script?.slice(script.indexOf("(") + 1, script.lastIndexOf(")"));
    if (!json) return null;
    let index: { docnames?: string[]; filenames?: string[] };
    try {
      index = JSON.parse(json);
    } catch {
      // Older Sphinx writes a JavaScript object literal (unquoted keys); its
      // string arrays are still JSON.
      const array = (key: string) => {
        const found = new RegExp(`["']?${key}["']?\\s*:\\s*(\\[[^\\]]*\\])`).exec(
          json,
        )?.[1];
        try {
          return found ? (JSON.parse(found) as string[]) : undefined;
        } catch {
          return undefined;
        }
      };
      index = { docnames: array("docnames"), filenames: array("filenames") };
      if (!index.docnames) return null;
    }

    const docnames = index.docnames ?? [];
    const pageFor = (docname: string) => {
      if (builder === "dirhtml") {
        return resolve(
          docname === "index" ? "" : `${docname.replace(/\/index$/, "")}/`,
          root,
        );
      }
      return resolve(`${docname}${fileSuffix}`, root);
    };
    const sources = new Map<string, string>();
    docnames.forEach((docname, i) => {
      const filename = index.filenames?.[i];
      const page = pageFor(docname);
      if (page && filename && /\.(md|markdown)$/i.test(filename)) {
        const source = resolve(`_sources/${filename}${sourceSuffix}`, root);
        if (source) sources.set(page, source);
      }
    });
    return {
      witness: "sphinx index",
      pages: docnames.map(pageFor).filter((page): page is string => page !== null),
      sources,
    };
  },
};
