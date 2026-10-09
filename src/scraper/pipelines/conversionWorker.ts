/**
 * Worker-thread entry that converts fetched pages (HTML or Markdown to chunks)
 * off the main thread. Built as its own entry; see {@link ConversionPool}.
 */
import { parentPort } from "node:worker_threads";
import type { AppConfig } from "../../utils/config";
import type { RawContent } from "../fetcher/types";
import type { ScraperOptions } from "../types";
import { PipelineFactory } from "./PipelineFactory";
import { runPipelines } from "./runPipelines";
import type { ContentPipeline } from "./types";

/** One conversion asked of the worker. */
export interface ConversionRequest {
  id: number;
  config: AppConfig;
  rawContent: RawContent;
  source: string;
  options: ScraperOptions;
}

let pipelines: ContentPipeline[] | undefined;

parentPort?.on("message", async (request: ConversionRequest) => {
  try {
    pipelines ??= PipelineFactory.createStandardPipelines(request.config);
    const result = await runPipelines(
      pipelines,
      request.rawContent,
      request.source,
      request.options,
    );
    parentPort?.postMessage({ id: request.id, result });
  } catch (error) {
    parentPort?.postMessage({ id: request.id, error });
  }
});
