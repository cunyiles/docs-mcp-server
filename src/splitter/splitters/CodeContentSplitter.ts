import { TextContentSplitter } from "./TextContentSplitter";
import type { ContentSplitter, ContentSplitterOptions } from "./types";

/**
 * Splits fenced code with a hard size bound, preserving the original fence,
 * info string and indentation. Long lines retain all characters across chunks.
 */
export class CodeContentSplitter implements ContentSplitter {
  constructor(private options: ContentSplitterOptions) {}

  async split(content: string): Promise<string[]> {
    const fenced = /^[ \t]*(?:`{3,}|~{3,})[^\n]*\n/.test(content)
      ? content
      : `\`\`\`\n${content}\n\`\`\``;
    return new TextContentSplitter(this.options).split(fenced);
  }
}
