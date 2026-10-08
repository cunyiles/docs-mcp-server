import type { IDocumentManagement } from "../store/trpc/interfaces";
import { ToolError, ValidationError } from "./errors";
import { resolveSearchVersion } from "./GrepTool";

export interface ReadPageToolOptions {
  library: string;
  version?: string;
  url: string;
}

/** Returns one stored page's whole Markdown. */
export class ReadPageTool {
  constructor(private readonly docService: IDocumentManagement) {}

  async execute(options: ReadPageToolOptions): Promise<string> {
    const { library, url } = options;
    if (!library.trim() || !url.trim()) {
      throw new ValidationError("Library and url are required.", this.constructor.name);
    }
    const version = await resolveSearchVersion(this.docService, library, options.version);
    const markdown = await this.docService.readPage(library, version, url.trim());
    if (markdown === null) {
      const label = version ? `${library}@${version}` : library;
      throw new ToolError(
        `Page ${url} is not in ${label}. Use a URL that search_docs or grep_docs returned.`,
        this.constructor.name,
      );
    }
    return markdown;
  }
}
