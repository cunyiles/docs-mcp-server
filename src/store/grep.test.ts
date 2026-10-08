import { describe, expect, it } from "vitest";
import { GrepPatternError, grepPages, parseGrepPattern } from "./grep";

const pages = [
  { url: "a", markdown: "alpha\nfoo.bar()\nfooXbar" },
  { url: "b", markdown: "nothing here\nfoo.bar" },
];

describe("grep", () => {
  it("treats plain text literally, so regex characters match themselves", () => {
    const { matches, total } = grepPages(pages, parseGrepPattern("foo.bar"), 10);
    expect(total).toBe(2);
    expect(matches).toEqual([
      { url: "a", line: 2, text: "foo.bar()" },
      { url: "b", line: 2, text: "foo.bar" },
    ]);
  });

  it("runs /regex/flags as a regular expression", () => {
    const { matches } = grepPages(pages, parseGrepPattern("/^foo.bar$/i"), 10);
    expect(matches.map((m) => `${m.url}:${m.line}`)).toEqual(["a:3", "b:2"]);
  });

  it("counts matches beyond the limit without returning them", () => {
    const { matches, total } = grepPages(pages, parseGrepPattern("/o/"), 1);
    expect(matches).toHaveLength(1);
    expect(total).toBe(4);
  });

  it("shortens long lines around the match", () => {
    const line = `${"x".repeat(500)}needle${"y".repeat(500)}`;
    const [match] = grepPages([{ url: "a", markdown: line }], "needle", 1).matches;
    expect(match.text).toContain("needle");
    expect(match.text.length).toBeLessThan(210);
  });

  it("rejects invalid and catastrophically slow regular expressions", () => {
    expect(() => parseGrepPattern("/(/")).toThrow(GrepPatternError);
    const slow = [{ url: "a", markdown: `${"a".repeat(40)}!` }];
    expect(() => grepPages(slow, parseGrepPattern("/(a+)+$/"), 1)).toThrow(/too long/);
  }, 15_000);
});
