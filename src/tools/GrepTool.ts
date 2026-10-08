import { GrepPatternError, type GrepResult } from "../store/grep";
import type { IDocumentManagement } from "../store/trpc/interfaces";
import { ValidationError } from "./errors";

/**
 * Resolves `version` the way `search_docs` does: the library must exist, and
 * an exact label or X-range picks the best indexed version.
 */
export async function resolveSearchVersion(
  docService: IDocumentManagement,
  library: string,
  version?: string,
): Promise<string | null> {
  await docService.validateLibraryExists(library);
  return (await docService.findBestVersion(library, version)).bestMatch;
}

export interface GrepToolOptions {
  library: string;
  version?: string;
  pattern: string;
  limit?: number;
}

/** Finds an exact text or regex in a library's stored pages. */
export class GrepTool {
  constructor(private readonly docService: IDocumentManagement) {}

  async execute(
    options: GrepToolOptions,
  ): Promise<GrepResult & { version: string | null }> {
    const { library, pattern, limit = 30 } = options;
    if (!library.trim()) {
      throw new ValidationError("Library name is required.", this.constructor.name);
    }
    if (limit < 1 || limit > 200) {
      throw new ValidationError(
        "Limit must be between 1 and 200.",
        this.constructor.name,
      );
    }
    const version = await resolveSearchVersion(this.docService, library, options.version);
    try {
      return {
        ...(await this.docService.grepStore(library, version, pattern, limit)),
        version,
      };
    } catch (error) {
      if (error instanceof GrepPatternError) {
        throw new ValidationError(error.message, this.constructor.name);
      }
      throw error;
    }
  }
}
