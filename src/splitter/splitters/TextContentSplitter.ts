import { MinimumChunkSizeError } from "../errors";
import { findFenceRegions, hasOpenFenceAtEnd } from "./fenceState";
import type { ContentSplitter, ContentSplitterOptions } from "./types";

/**
 * Splits text content using a hierarchical approach:
 * 1. Try splitting by paragraphs (double newlines)
 * 2. If chunks still too large, split by single newlines
 * 3. Finally, slice at whitespace boundaries, splitting long tokens as needed
 *
 * Fences that fit remain intact. Larger fences are closed and reopened around
 * bounded source slices, preserving indentation, info strings and fence length.
 */
export class TextContentSplitter implements ContentSplitter {
  constructor(private options: ContentSplitterOptions) {
    if (!Number.isInteger(options.chunkSize) || options.chunkSize < 1) {
      throw new RangeError("chunkSize must be a positive integer");
    }
  }

  /**
   * Splits text content into chunks while trying to preserve semantic boundaries.
   * Prefers paragraph breaks, then line breaks, finally falling back to word boundaries.
   * Always preserves formatting - trimming should be done by higher-level splitters if needed.
   */
  async split(content: string): Promise<string[]> {
    if (content.length <= this.options.chunkSize) {
      return [content];
    }

    // First try splitting by paragraphs (double newlines)
    const paragraphChunks = this.mergeForFenceBalance(
      this.splitByParagraphs(content),
      "",
    );
    if (this.areChunksValid(paragraphChunks)) {
      // No merging for paragraph chunks; they are already semantically separated
      return paragraphChunks;
    }

    // If that doesn't work, try splitting by single newlines
    const lineChunks = this.mergeForFenceBalance(this.splitByLines(content), "");
    if (this.areChunksValid(lineChunks)) {
      return this.mergeChunks(lineChunks, ""); // No separator needed - newlines are preserved in chunks
    }

    return this.splitBounded(content);
  }

  private splitBounded(content: string): string[] {
    const result: string[] = [];
    let offset = 0;
    for (const region of findFenceRegions(content)) {
      result.push(
        ...this.splitSource(
          content.slice(offset, region.startOffset),
          this.options.chunkSize,
        ),
      );
      const fenced = content.slice(region.startOffset, region.endOffset);
      if (fenced.length <= this.options.chunkSize) {
        result.push(fenced);
      } else {
        const firstNewline = fenced.indexOf("\n");
        const opener = fenced.slice(0, firstNewline + 1);
        const match = opener.match(/^([ \t]*(?:>[ \t]*)*)(`{3,}|~{3,})/);
        if (!match || firstNewline === -1) {
          throw new MinimumChunkSizeError(fenced.length, this.options.chunkSize);
        }
        const closer = `${match[1]}${match[2]}`;
        const closed = !hasOpenFenceAtEnd(fenced);
        const lastLineStart =
          fenced.lastIndexOf(
            "\n",
            fenced.endsWith("\n") ? fenced.length - 2 : fenced.length - 1,
          ) + 1;
        const body = fenced.slice(opener.length, closed ? lastLineStart : fenced.length);
        const continuationPrefix = match[1].includes(">") ? match[1] : "";
        const capacity =
          this.options.chunkSize -
          opener.length -
          closer.length -
          continuationPrefix.length -
          1;
        if (capacity < 1)
          throw new MinimumChunkSizeError(
            opener.length + closer.length + 2,
            this.options.chunkSize,
          );
        let continuesLine = false;
        for (const part of this.splitSource(body, capacity)) {
          const prefix = continuesLine ? continuationPrefix : "";
          result.push(
            `${opener}${prefix}${part}${part.endsWith("\n") ? "" : "\n"}${closer}`,
          );
          continuesLine = !part.endsWith("\n");
        }
        if (closed && fenced.endsWith("\n")) {
          const last = result.length - 1;
          if (result[last].length < this.options.chunkSize) result[last] += "\n";
          else result.push("\n");
        }
      }
      offset = region.endOffset;
    }
    result.push(...this.splitSource(content.slice(offset), this.options.chunkSize));
    return result;
  }

  /** Slices source without trimming whitespace or dropping long tokens. */
  private splitSource(text: string, limit: number): string[] {
    const chunks: string[] = [];
    let offset = 0;
    while (offset < text.length) {
      let end = Math.min(offset + limit, text.length);
      if (end < text.length) {
        const window = text.slice(offset, end);
        const newline = window.lastIndexOf("\n");
        const whitespace = [...window.matchAll(/\s/g)].at(-1)?.index;
        if (newline >= 0) end = offset + newline + 1;
        else if (whitespace !== undefined) end = offset + whitespace + 1;
        // Keep UTF-16 surrogate pairs together at a hard boundary.
        else if (end > offset + 1 && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      }
      chunks.push(text.slice(offset, end));
      offset = end;
    }
    return chunks;
  }

  /**
   * Walks `chunks` left to right and merges adjacent chunks whenever the running
   * buffer ends inside an open fenced code block. Guarantees that every emitted
   * chunk has balanced fences (i.e. `hasOpenFenceAtEnd` returns false).
   */
  private mergeForFenceBalance(chunks: string[], separator: string): string[] {
    const result: string[] = [];
    let buffer = "";

    for (const chunk of chunks) {
      buffer = buffer ? `${buffer}${separator}${chunk}` : chunk;
      if (!hasOpenFenceAtEnd(buffer)) {
        result.push(buffer);
        buffer = "";
      }
    }

    if (buffer) {
      // Oversized buffers are handled by the bounded fallback below.
      result.push(buffer);
    }

    return result;
  }

  /**
   * Checks if all chunks are within the maximum size limit
   */
  private areChunksValid(chunks: string[]): boolean {
    return chunks.every((chunk) => chunk.length <= this.options.chunkSize);
  }

  /**
   * Splits text into chunks by paragraph boundaries (double newlines)
   * Preserves all formatting and whitespace including the paragraph separators
   */
  private splitByParagraphs(text: string): string[] {
    const chunks: string[] = [];
    let startPos = 0;

    // Find all paragraph boundaries
    const paragraphRegex = /\n\s*\n/g;
    let match = paragraphRegex.exec(text);

    while (match !== null) {
      // Include the paragraph separator in the current chunk
      const endPos = match.index + match[0].length;
      const chunk = text.slice(startPos, endPos);
      if (chunk.length > 0) {
        chunks.push(chunk);
      }
      startPos = endPos;
      match = paragraphRegex.exec(text);
    }

    // Add the remaining text
    if (startPos < text.length) {
      const remainingChunk = text.slice(startPos);
      if (remainingChunk.length > 0) {
        chunks.push(remainingChunk);
      }
    }

    return chunks.filter(Boolean);
  }

  /**
   * Splits text into chunks by line boundaries
   * Preserves all formatting and whitespace, including newlines at the end of each line
   */
  private splitByLines(text: string): string[] {
    const chunks: string[] = [];
    let startPos = 0;

    // Find all line boundaries
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\n") {
        // Include the newline in the current chunk
        const chunk = text.slice(startPos, i + 1);
        chunks.push(chunk);
        startPos = i + 1;
      }
    }

    // Add the remaining text (if any) without a trailing newline
    if (startPos < text.length) {
      chunks.push(text.slice(startPos));
    }

    return chunks;
  }

  /**
   * Attempts to merge small chunks with previous chunks to minimize fragmentation.
   * Only merges if combined size is within maxChunkSize.
   */
  protected mergeChunks(chunks: string[], separator: string): string[] {
    const mergedChunks: string[] = [];
    let currentChunk: string | null = null;

    for (const chunk of chunks) {
      if (currentChunk === null) {
        currentChunk = chunk;
        continue;
      }

      const currentChunkSize = this.getChunkSize(currentChunk);
      const nextChunkSize = this.getChunkSize(chunk);

      if (currentChunkSize + nextChunkSize + separator.length <= this.options.chunkSize) {
        // Merge chunks
        currentChunk = `${currentChunk}${separator}${chunk}`;
      } else {
        // Add the current chunk to the result and start a new one
        mergedChunks.push(currentChunk);
        currentChunk = chunk;
      }
    }

    if (currentChunk) {
      mergedChunks.push(currentChunk);
    }

    return mergedChunks;
  }

  protected getChunkSize(chunk: string): number {
    return chunk.length;
  }

  protected wrap(content: string): string {
    return content;
  }
}
