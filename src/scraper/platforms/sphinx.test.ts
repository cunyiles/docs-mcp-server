import { describe, expect, it } from "vitest";
import { sphinx } from "./sphinx";

describe("sphinx adapter", () => {
  it("reads an older search index written as a JavaScript object literal", async () => {
    const files: Record<string, string> = {
      "https://a.test/en/latest/_static/documentation_options.js":
        "var DOCUMENTATION_OPTIONS = { FILE_SUFFIX: '.html', SOURCELINK_SUFFIX: '.txt' };",
      "https://a.test/en/latest/searchindex.js":
        'Search.setIndex({docnames:["api","index"],envversion:{sphinx:55},filenames:["api.rst","index.md"],titles:["API","Home"]})',
    };
    const found = await sphinx.detect(
      "https://a.test/en/latest/",
      '<script id="documentation_options" data-url_root="./" src="_static/documentation_options.js"></script>',
      async (url) => files[url],
    );
    expect(found?.pages).toEqual([
      "https://a.test/en/latest/api.html",
      "https://a.test/en/latest/index.html",
    ]);
    expect([...(found?.sources ?? [])]).toEqual([
      [
        "https://a.test/en/latest/index.html",
        "https://a.test/en/latest/_sources/index.md.txt",
      ],
    ]);
  });
});
