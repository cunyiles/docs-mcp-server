import { describe, expect, it } from "vitest";
import type { ScraperOptions } from "../types";
import { EmbeddedImageMiddleware } from "./EmbeddedImageMiddleware";
import type { MiddlewareContext } from "./types";

async function clean(content: string): Promise<string> {
  const context: MiddlewareContext = {
    content,
    source: "https://example.com/guide",
    contentType: "text/markdown",
    links: [],
    errors: [],
    options: {} as ScraperOptions,
  };
  await new EmbeddedImageMiddleware().process(context, async () => {});
  return context.content;
}

describe("EmbeddedImageMiddleware", () => {
  it("leaves remote images, ordinary data URLs and code examples byte-for-byte intact", async () => {
    const content = [
      "![Remote](https://example.com/image.png)",
      "[Download](data:text/plain;base64,SGVsbG8=)",
      "`![Example](data:image/png;base64,SGVsbG8=)`",
      '```html\n<img src="data:image/png;base64,SGVsbG8=">\n```',
      '<pre><code>&lt;img src="data:image/png;base64,SGVsbG8="&gt;</code></pre>',
    ].join("\n\n");
    expect(await clean(content)).toBe(content);
  });

  it("handles image syntax, encoded delimiters, reference images and quoted HTML attributes", async () => {
    const content = [
      '![Inline](<data:image/svg+xml%3bbase64,AAAA> "title")',
      "![Reference][]",
      "[Reference]: data:image/png;base64,BBBB",
      '<details><summary>Diagram</summary><img title="a > b" alt="A &amp; B" src="DATA:IMAGE/PNG;base64,CCCC"></details>',
    ].join("\n\n");
    expect(await clean(content)).toBe(
      [
        "Inline",
        "Reference",
        "",
        "<details><summary>Diagram</summary>A &amp; B</details>",
      ].join("\n\n"),
    );
  });

  it("removes Markdown image payloads inside raw HTML wrappers while retaining fenced examples", async () => {
    const content =
      '<details>\n<summary>Figure</summary>\n![Diagram](data:image/png;base64,AAAA)\n```html\n<img src="data:image/png;base64,CODE">\n```\n</details>';
    const result = await clean(content);
    expect(result).not.toContain("AAAA");
    expect(result).toContain("Diagram");
    expect(result).toContain('```html\n<img src="data:image/png;base64,CODE">\n```');
  });

  it("drops embedded srcset candidates from raw HTML without removing the remote source", async () => {
    const result = await clean(
      '<picture><source srcset="data:image/png;base64,AAAA 1x"><img alt="Diagram" src="https://example.com/image.png" srcset="data:image/png;base64,BBBB 2x"></picture>',
    );
    expect(result).not.toContain("AAAA");
    expect(result).not.toContain("BBBB");
    expect(result).toContain("https://example.com/image.png");
    expect(result).toContain("Diagram");
  });

  it("removes the payload when an image definition is shared with a link", async () => {
    const result = await clean(
      "![Diagram][figure]\n\n[Open figure][figure]\n\n[figure]: data:image/png;base64,AAAA",
    );
    expect(result).not.toContain("AAAA");
    expect(result).toContain("Diagram");
    expect(result).toContain("Open figure");
  });

  it("resolves image references across a raw HTML wrapper boundary", async () => {
    const result = await clean(
      "<details>\n![Diagram][figure]\n</details>\n\n[figure]: data:image/png;base64,AAAA",
    );
    expect(result).not.toContain("AAAA");
    expect(result).toContain("Diagram");
  });

  it("does not let special characters in alt text become active Markdown", async () => {
    expect(await clean("![\\[label\\]\\(target\\)](data:image/png;base64,AAAA)")).toBe(
      "\\[label\\](target)",
    );
  });
});
