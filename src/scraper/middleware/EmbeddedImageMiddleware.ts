import * as cheerio from "cheerio";
import type { Definition, Root, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { ContentProcessorMiddleware, MiddlewareContext } from "./types";

interface Replacement {
  start: number;
  end: number;
  text: string;
}

function isEmbeddedImage(url: string): boolean {
  // The payload need not be decoded: image URLs can have escaped metadata
  // delimiters, and non-base64 data images are binary content too.
  return /^data:image\//i.test(url.trim());
}

function escapeText(text: string): string {
  return text.replace(/[\\`*_[\]<>]/g, "\\$&");
}

function parseNodes(source: string): RootContent[] {
  const nodes: RootContent[] = [];
  const visit = (node: Root | RootContent): void => {
    if (node.type !== "root") nodes.push(node);
    if ("children" in node) for (const child of node.children) visit(child);
  };
  visit(unified().use(remarkParse).use(remarkGfm).parse(source));
  return nodes;
}

interface ImageDefinition {
  node: Definition;
  offset: number;
}

function markdownReplacements(
  nodes: RootContent[],
  offset = 0,
  definitions = new Map<string, ImageDefinition>(),
  usedDefinitions = new Set<ImageDefinition>(),
): Replacement[] {
  for (const node of nodes) {
    if (node.type === "definition") definitions.set(node.identifier, { node, offset });
  }
  const replacements: Replacement[] = [];
  const replaceNode = (node: RootContent, text: string): void => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined)
      replacements.push({ start: offset + start, end: offset + end, text });
  };
  for (const node of nodes) {
    if (node.type === "image" && isEmbeddedImage(node.url)) {
      replaceNode(node, escapeText(node.alt ?? ""));
    } else if (node.type === "imageReference") {
      const definition = definitions.get(node.identifier);
      if (definition && isEmbeddedImage(definition.node.url)) {
        replaceNode(node, escapeText(node.alt ?? ""));
        usedDefinitions.add(definition);
      }
    }
  }
  return replacements;
}

function htmlReplacements(
  source: string,
  offset: number,
  definitions: Map<string, ImageDefinition>,
  usedDefinitions: Set<ImageDefinition>,
): Replacement[] {
  const $ = cheerio.load(source, {
    xml: { xmlMode: false, withStartIndices: true, withEndIndices: true },
  });
  // A raw HTML block can contain Markdown. Mask parsed tags at their original
  // offsets so remark can recognize those images and code examples too.
  const mask = source.split("");
  const hide = (start: number, end: number): void => {
    for (let i = start; i < end; i++)
      if (mask[i] !== "\n" && mask[i] !== "\r") mask[i] = ".";
  };
  $("*").each((_, element) => {
    if (element.startIndex === null || element.endIndex === null) return;
    const start = element.startIndex;
    const end = element.endIndex + 1;
    if (
      "tagName" in element &&
      (element.tagName === "pre" || element.tagName === "code")
    ) {
      hide(start, end);
      return;
    }
    // Cheerio identifies the element; this tokenizer only locates its tag end,
    // respecting quoted '>' characters in attributes.
    const opener = source.slice(start, end).match(/^<(?:"[^"]*"|'[^']*'|[^'">])*>/);
    if (opener) hide(start, start + opener[0].length);
    const closer = source.slice(start, end).match(/<\/[^>]+>$/);
    if (closer) hide(end - closer[0].length, end);
  });
  // Definitions outside a raw wrapper still resolve its image references.
  const externalDefinitions = [...definitions.values()]
    .map(({ node }) => `[${node.identifier}]: <${node.url}>`)
    .join("\n");
  const nodes = parseNodes(`${mask.join("")}\n\n${externalDefinitions}`).filter(
    (node) => (node.position?.start.offset ?? Infinity) < source.length,
  );
  const replacements = markdownReplacements(nodes, offset, definitions, usedDefinitions);
  const codeRanges = nodes.filter(
    (node) => node.type === "code" || node.type === "inlineCode",
  );
  $("img, source").each((_, image) => {
    const element = $(image);
    const start = image.startIndex;
    const end = image.endIndex;
    if (start === null || end === null || element.parents("pre, code").length) return;
    if (
      codeRanges.some(
        (node) =>
          start >= (node.position?.start.offset ?? Infinity) &&
          start < (node.position?.end.offset ?? -1),
      )
    )
      return;
    if (isEmbeddedImage(element.attr("src") ?? "")) {
      const alt = (element.attr("alt") ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      replacements.push({ start: offset + start, end: offset + end + 1, text: alt });
    } else if (/(?:^|[\s,])data:image\//i.test(element.attr("srcset") ?? "")) {
      element.removeAttr("srcset");
      replacements.push({
        start: offset + start,
        end: offset + end + 1,
        text: $.html(image),
      });
    }
  });
  return replacements;
}

/** Removes rendered data images before splitting while retaining descriptions and examples. */
export class EmbeddedImageMiddleware implements ContentProcessorMiddleware {
  async process(context: MiddlewareContext, next: () => Promise<void>): Promise<void> {
    const source = context.content;
    const nodes = parseNodes(source);
    const definitions = new Map<string, ImageDefinition>();
    const usedDefinitions = new Set<ImageDefinition>();
    const replacements = markdownReplacements(nodes, 0, definitions, usedDefinitions);
    for (const node of nodes) {
      if (node.type === "html" && node.position?.start.offset !== undefined) {
        replacements.push(
          ...htmlReplacements(
            node.value,
            node.position.start.offset,
            definitions,
            usedDefinitions,
          ),
        );
      }
    }
    for (const { node, offset } of usedDefinitions) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined)
        replacements.push({ start: offset + start, end: offset + end, text: "" });
    }
    let cleaned = source;
    for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
      cleaned =
        cleaned.slice(0, replacement.start) +
        replacement.text +
        cleaned.slice(replacement.end);
    }
    context.content = cleaned;
    await next();
  }
}
