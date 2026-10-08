import YAML from "yaml";
import type { Chunk } from "../../splitter/types";
import type { AppConfig } from "../../utils/config";
import { MimeTypeUtils } from "../../utils/mimeTypeUtils";
import type { RawContent } from "../fetcher/types";
import { convertToString } from "../utils/buffer";
import { BasePipeline } from "./BasePipeline";
import type { PipelineResult } from "./types";

type Json = Record<string, unknown>;

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
/** How many `$ref` hops a schema is expanded through before it is named instead. */
const MAX_REF_DEPTH = 4;
/** `$ref`s expanded per schema; wide schema graphs grow exponentially with depth. */
const MAX_REF_EXPANSIONS = 100;
const SNIFF_BYTES = 4096;
const OPENAPI_JSON = /"(openapi|swagger)"\s*:\s*"[23]\./;
const OPENAPI_YAML = /^(openapi|swagger)\s*:\s*["']?[23]\./m;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Indexes an OpenAPI 3 (or Swagger 2) document, JSON or YAML, as one chunk per
 * operation: method, path, summary, parameters and request/response schemas
 * with `$ref`s resolved.
 *
 * Recognised by content, not by URL or file name, because contracts are
 * published under any name and often served as `text/plain`.
 */
export class OpenApiPipeline extends BasePipeline {
  constructor(private readonly config: AppConfig) {
    super();
  }

  canProcess(mimeType: string, content?: string | Buffer): boolean {
    if (!content) return false;
    const mime = (mimeType || "").split(";")[0].trim().toLowerCase();
    if (!MimeTypeUtils.isJson(mime) && !mime.includes("yaml") && mime !== "text/plain") {
      return false;
    }
    const head =
      typeof content === "string"
        ? content.slice(0, SNIFF_BYTES)
        : content.subarray(0, SNIFF_BYTES).toString("utf8");
    return OPENAPI_JSON.test(head) || OPENAPI_YAML.test(head);
  }

  async process(rawContent: RawContent): Promise<PipelineResult> {
    const text = convertToString(rawContent.content, rawContent.charset);
    let doc: unknown;
    try {
      doc = text.trimStart().startsWith("{")
        ? JSON.parse(text)
        : YAML.parse(text, { maxAliasCount: 100 });
    } catch (error) {
      return { textContent: "", links: [], errors: [error as Error], chunks: [] };
    }
    if (!isObject(doc) || !isObject(doc.paths)) {
      return {
        textContent: "",
        links: [],
        errors: [new Error("OpenAPI document has no paths")],
        chunks: [],
      };
    }

    const info = isObject(doc.info) ? doc.info : {};
    const title = [info.title, info.version]
      .filter((v) => typeof v === "string")
      .join(" ");
    const intro = [`# ${title || "API reference"}`, str(info.description)]
      .filter(Boolean)
      .join("\n\n");
    const resolver = new RefResolver(doc);
    const max = this.config.splitter.maxChunkSize;

    const chunks: Chunk[] = [];
    for (const [path, item] of Object.entries(doc.paths)) {
      if (!isObject(item)) continue;
      const shared = Array.isArray(item.parameters) ? item.parameters : [];
      for (const method of METHODS) {
        const op = item[method];
        if (!isObject(op)) continue;
        const heading = `${method.toUpperCase()} ${path}`;
        const content = renderOperation(heading, op, shared, resolver);
        chunks.push({
          types: ["text"],
          content: content.length > max ? `${content.slice(0, max - 1)}…` : content,
          section: { level: 2, path: [title || "API reference", heading] },
        });
      }
    }

    return {
      title: title || null,
      contentType: "text/markdown",
      textContent: [intro, ...chunks.map((c) => c.content)].join("\n\n"),
      links: [],
      errors: [],
      chunks,
    };
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function renderOperation(
  heading: string,
  op: Json,
  sharedParameters: unknown[],
  resolver: RefResolver,
): string {
  const lines = [`## ${heading}`];
  const summary = [str(op.summary), str(op.operationId) && `(\`${str(op.operationId)}\`)`]
    .filter(Boolean)
    .join(" ");
  if (summary) lines.push(summary);
  if (str(op.description)) lines.push(str(op.description));

  const parameters = [
    ...sharedParameters,
    ...(Array.isArray(op.parameters) ? op.parameters : []),
  ]
    .map((p) => resolver.resolve(p, 1))
    .filter(isObject);
  const body = parameters.filter((p) => p.in === "body");
  const params = parameters.filter((p) => p.in !== "body");
  if (params.length > 0) {
    lines.push(
      "Parameters:",
      params
        .map((p) => {
          const schema = isObject(p.schema) ? p.schema : p;
          const type = str(schema.type) || str(schema.$ref) || "any";
          const required = p.required === true ? ", required" : "";
          const description = str(p.description) ? `: ${str(p.description)}` : "";
          return `- \`${str(p.name)}\` (${str(p.in)}, ${type}${required})${description}`;
        })
        .join("\n"),
    );
  }

  const requestBody = resolver.resolve(op.requestBody, 1);
  if (isObject(requestBody)) {
    lines.push(`Request body:${describeContent(requestBody, resolver)}`);
  } else if (body.length > 0 && isObject(body[0].schema)) {
    lines.push(`Request body:\n${yamlBlock(resolver.expand(body[0].schema))}`);
  }

  if (isObject(op.responses)) {
    for (const [status, raw] of Object.entries(op.responses)) {
      const response = resolver.resolve(raw, 1);
      if (!isObject(response)) continue;
      const description = str(response.description);
      const schema = isObject(response.schema)
        ? `\n${yamlBlock(resolver.expand(response.schema))}`
        : describeContent(response, resolver);
      lines.push(`Response ${status}${description ? `: ${description}` : ""}${schema}`);
    }
  }
  return lines.join("\n\n");
}

function describeContent(holder: Json, resolver: RefResolver): string {
  if (!isObject(holder.content)) return "";
  for (const [mediaType, media] of Object.entries(holder.content)) {
    if (isObject(media) && media.schema !== undefined) {
      return ` (${mediaType})\n${yamlBlock(resolver.expand(media.schema))}`;
    }
  }
  return "";
}

function yamlBlock(value: unknown): string {
  return `\`\`\`yaml\n${YAML.stringify(value, { lineWidth: 0 }).trimEnd()}\n\`\`\``;
}

/** Follows local `$ref`s, with bounded depth and no infinite loop on cycles. */
class RefResolver {
  constructor(private readonly doc: Json) {}

  private lookup(ref: string): unknown {
    if (!ref.startsWith("#/")) return undefined;
    let node: unknown = this.doc;
    for (const part of ref.slice(2).split("/")) {
      const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
      node = isObject(node) ? node[key] : undefined;
    }
    return node;
  }

  /** Resolves a top-level `$ref` chain (parameters, responses, bodies). */
  resolve(value: unknown, hops: number): unknown {
    let node = value;
    for (let i = 0; i <= hops && isObject(node) && typeof node.$ref === "string"; i++) {
      node = this.lookup(node.$ref);
    }
    return node;
  }

  private budget = 0;

  /** Returns a schema with nested `$ref`s expanded, keeping only what documents it. */
  expand(schema: unknown): unknown {
    this.budget = MAX_REF_EXPANSIONS;
    return this.walk(schema, []);
  }

  private walk(schema: unknown, seen: string[]): unknown {
    if (Array.isArray(schema)) return schema.map((s) => this.walk(s, seen));
    if (!isObject(schema)) return schema;
    if (typeof schema.$ref === "string") {
      const name = schema.$ref.split("/").pop() ?? schema.$ref;
      if (
        seen.includes(schema.$ref) ||
        seen.length >= MAX_REF_DEPTH ||
        this.budget <= 0
      ) {
        return `<${name}>`;
      }
      this.budget--;
      return this.walk(this.lookup(schema.$ref), [...seen, schema.$ref]);
    }
    const out: Json = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key === "example" || key === "examples" || key === "xml") continue;
      out[key] = this.walk(value, seen);
    }
    return out;
  }
}
