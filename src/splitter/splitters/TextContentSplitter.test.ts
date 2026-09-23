import remarkParse from "remark-parse";
import { unified } from "unified";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { logger } from "../../utils/logger";
import { hasOpenFenceAtEnd } from "./fenceState";
import { TextContentSplitter } from "./TextContentSplitter";
import type { ContentSplitterOptions } from "./types";

const fenceCount = (s: string) => (s.match(/```/g) || []).length;
const tildeFenceCount = (s: string) => (s.match(/(?:^| |\n)~~~/g) || []).length;

describe("TextContentSplitter", () => {
  const options = {
    chunkSize: 100,
  } satisfies ContentSplitterOptions;
  const splitter = new TextContentSplitter(options);

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.5])(
    "rejects invalid chunk size %s before splitting",
    (chunkSize) => {
      expect(() => new TextContentSplitter({ chunkSize })).toThrow(RangeError);
    },
  );

  it("preserves CRLF code content across bounded fences", async () => {
    const body = Array.from({ length: 12 }, (_, i) => `    run(${i});\r\n`).join("");
    const chunks = await new TextContentSplitter({ chunkSize: 100 }).split(
      `\`\`\`js\r\n${body}\`\`\`\r\n`,
    );
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(100);
    expect(
      chunks
        .map((chunk) => chunk.replace(/^```js\r\n/, "").replace(/```(?:\r?\n)?$/, ""))
        .join(""),
    ).toBe(body);
  });

  it("keeps a long quoted code line inside its blockquote after splitting", async () => {
    const content = `> \`\`\`js\n> ${"x".repeat(170)}\n> \`\`\``;
    const chunks = await new TextContentSplitter({ chunkSize: 70 }).split(content);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(70);
      const tree = unified().use(remarkParse).parse(chunk);
      expect(tree.children.every((node) => node.type === "blockquote")).toBe(true);
    }
    expect(chunks.join("").match(/x/g)).toHaveLength(170);
  });

  it("should split on paragraph boundaries when possible", async () => {
    const text = `First paragraph with some content.

Second paragraph that continues the text.

Third paragraph to complete the example.`;

    const chunks = await splitter.split(text);

    expect(chunks.length).toBe(3);
    // Chunks now preserve paragraph separators for perfect reconstruction
    expect(chunks[0]).toBe("First paragraph with some content.\n\n");
    expect(chunks[1]).toBe("Second paragraph that continues the text.\n\n");
    expect(chunks[2]).toBe("Third paragraph to complete the example.");

    // Verify perfect reconstruction
    expect(chunks.join("")).toBe(text);
  });

  it("should fall back to line breaks when paragraphs too large", async () => {
    // Create a paragraph larger than preferredChunkSize
    const longParagraph = Array(5)
      .fill("This is a very long line of text that should be split.")
      .join(" ");

    const text = `${longParagraph}
Line two of the text.
Line three continues here.
And line four finishes it.`;

    const chunks = await splitter.split(text);

    // Should split into multiple chunks at line boundaries
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(options.chunkSize);
    }
  });

  it("should merge small chunks when possible", async () => {
    const text =
      "Short line 1.\nShort line 2.\nShort line 3.\n\nAnother short one.\nAnd another.";

    const chunks = await splitter.split(text);

    // Small consecutive lines should be merged
    expect(chunks.length).toBeLessThan(6); // Less than total number of lines
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(options.chunkSize);
    }
  });

  it("should handle empty content gracefully", async () => {
    const emptyChunks = await splitter.split("");
    expect(emptyChunks.length).toBe(1);
    expect(emptyChunks[0]).toBe("");

    // Whitespace should be preserved now
    const whitespaceChunks = await splitter.split("   \n  \n  ");
    expect(whitespaceChunks.length).toBe(1);
    expect(whitespaceChunks[0]).toBe("   \n  \n  ");
  });

  it("should preserve formatting and whitespace", async () => {
    const textWithFormatting = `  function example() {
    // This has indentation
    const value = "test";
    
    return value;
  }`;

    const chunks = await splitter.split(textWithFormatting);

    // Should preserve the exact content including indentation and blank lines
    expect(chunks.join("")).toBe(textWithFormatting);

    // Each chunk should maintain its formatting
    for (const chunk of chunks) {
      // Leading/trailing spaces should be preserved within chunks
      expect(chunk).not.toBe(chunk.trim());
    }
  });

  it("should preserve blank lines and spacing", async () => {
    const textWithSpacing = `Line 1

Line 3 with blank line above


Line 6 with multiple blank lines above`;

    const chunks = await splitter.split(textWithSpacing);

    // Should be able to reconstruct exactly
    expect(chunks.join("")).toBe(textWithSpacing);
  });

  it("should split words as last resort", async () => {
    const splitter = new TextContentSplitter({
      chunkSize: 20, // Very small for testing word splitting
    });

    const text =
      "This is a very long sentence that needs to be split into smaller chunks";

    const chunks = await splitter.split(text);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(20);
    }
  });

  it("preserves whitespace when word boundaries are required", async () => {
    const text = "  first  second\tthird    fourth  fifth  sixth seventh   ";
    const chunks = await new TextContentSplitter({ chunkSize: 20 }).split(text);
    expect(chunks.join("")).toBe(text);
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(20);
  });

  it("splits long tokens losslessly instead of bypassing the bound", async () => {
    const text = "x".repeat(301);
    const chunks = await new TextContentSplitter({ chunkSize: 100 }).split(text);
    expect(chunks.join("")).toBe(text);
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(100);
  });

  it("retains four-backtick fences around examples containing triple backticks", async () => {
    const body = Array.from(
      { length: 30 },
      (_, i) => `  example ${i}\n\n\`\`\`js\n    run();\n\`\`\`\n`,
    ).join("");
    const chunks = await new TextContentSplitter({ chunkSize: 120 }).split(
      `\`\`\`\`markdown\n${body}\`\`\`\``,
    );
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(120);
    for (const chunk of chunks) expect(hasOpenFenceAtEnd(chunk)).toBe(false);
    expect(
      chunks
        .map((chunk) => chunk.replace(/^`{4}markdown\n/, "").replace(/`{4}$/, ""))
        .join(""),
    ).toBe(body);
  });

  describe("fence balance", () => {
    let warnSpy: Mock<typeof logger.warn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it("keeps a fenced code block intact when it would otherwise straddle a paragraph boundary", async () => {
      const splitter = new TextContentSplitter({ chunkSize: 200 });
      // The fence contains a blank line, so a naive paragraph split would cut inside it.
      const text = [
        "Intro paragraph that takes up some space here in the document.",
        "",
        "```ts",
        "const x = 1;",
        "",
        "const y = 2;",
        "```",
        "",
        "Trailing paragraph that follows the example code block.",
      ].join("\n");

      const chunks = await splitter.split(text);
      for (const c of chunks) {
        expect(fenceCount(c) % 2).toBe(0);
        expect(hasOpenFenceAtEnd(c)).toBe(false);
      }
      // Reconstruct losslessly.
      expect(chunks.join("")).toBe(text);
    });

    it("bounds oversized fences while preserving every indented code line", async () => {
      const splitter = new TextContentSplitter({ chunkSize: 120 });
      const lines = Array.from(
        { length: 20 },
        (_, i) => `  const value_${i} = "some moderately long content";`,
      ).join("\n");
      const text = ["Intro line.", "", "```ts", lines, "```", "", "Trailing line."].join(
        "\n",
      );

      const chunks = await splitter.split(text);
      // All chunks must have balanced fences.
      for (const c of chunks) {
        expect(fenceCount(c) % 2).toBe(0);
        expect(hasOpenFenceAtEnd(c)).toBe(false);
      }
      expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(120);
      for (const line of lines.split("\n")) expect(chunks.join("\n")).toContain(line);
    });

    it("handles multiple fenced blocks separated by prose without breaking any fence", async () => {
      const splitter = new TextContentSplitter({ chunkSize: 200 });
      const text = [
        "Para A.",
        "",
        "```ts",
        "a();",
        "```",
        "",
        "Para B that takes a bit of space to write out fully.",
        "",
        "```python",
        "def f():",
        "    return 1",
        "```",
        "",
        "Para C trailing the example.",
      ].join("\n");

      const chunks = await splitter.split(text);
      for (const c of chunks) {
        expect(fenceCount(c) % 2).toBe(0);
        expect(hasOpenFenceAtEnd(c)).toBe(false);
      }
    });

    it("honors the invariant for tilde fences", async () => {
      const splitter = new TextContentSplitter({ chunkSize: 150 });
      const text = [
        "Intro.",
        "",
        "~~~",
        "line 1",
        "",
        "line 2 with a blank line inside the fence",
        "~~~",
        "",
        "Trailing.",
      ].join("\n");

      const chunks = await splitter.split(text);
      for (const c of chunks) {
        // Tilde fences must also be balanced.
        const opens = (c.match(/^~~~/gm) || []).length;
        expect(opens % 2).toBe(0);
        expect(hasOpenFenceAtEnd(c)).toBe(false);
      }
      // sanity check: at least one fence appears in the input
      expect(tildeFenceCount(text)).toBeGreaterThan(0);
    });

    it("treats fences with a language tag the same as bare fences", async () => {
      const splitter = new TextContentSplitter({ chunkSize: 200 });
      const text = [
        "Intro.",
        "",
        "```ts",
        "interface X {",
        "",
        "  foo: string;",
        "",
        "  bar: number;",
        "}",
        "```",
        "",
        "Trailing prose to push past chunkSize for variety.",
      ].join("\n");

      const chunks = await splitter.split(text);
      for (const c of chunks) {
        expect(fenceCount(c) % 2).toBe(0);
      }
    });
  });
});
