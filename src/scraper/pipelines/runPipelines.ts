import { logger } from "../../utils/logger";
import type { ContentFetcher, RawContent } from "../fetcher/types";
import type { ScraperOptions } from "../types";
import type { ContentPipeline, PipelineResult } from "./types";

/**
 * Runs the first pipeline that can read the content.
 *
 * @returns The pipeline's result, or undefined when no pipeline can read it.
 */
export async function runPipelines(
  pipelines: ContentPipeline[],
  rawContent: RawContent,
  source: string,
  options: ScraperOptions,
  fetcher?: ContentFetcher,
): Promise<PipelineResult | undefined> {
  const contentBuffer = Buffer.isBuffer(rawContent.content)
    ? rawContent.content
    : Buffer.from(rawContent.content);
  for (const pipeline of pipelines) {
    if (pipeline.canProcess(rawContent.mimeType || "text/plain", contentBuffer)) {
      logger.debug(
        `Selected ${pipeline.constructor.name} for content type "${rawContent.mimeType}" (${source})`,
      );
      return pipeline.process({ ...rawContent, source }, options, fetcher);
    }
  }
  return undefined;
}
