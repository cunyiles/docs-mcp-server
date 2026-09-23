/**
 * Remove command - Removes documents for a specific library and version.
 */

import type { Argv } from "yargs";
import { PipelineFactory } from "../../pipeline";
import type { IPipeline } from "../../pipeline/trpc/interfaces";
import { createDocumentManagement, type DocumentManagementService } from "../../store";
import { TelemetryEvent, telemetry } from "../../telemetry";
import { RemoveTool } from "../../tools/RemoveTool";
import { loadConfig } from "../../utils/config";
import { logger } from "../../utils/logger";
import { renderTextOutput } from "../output";
import { type CliContext, getEventBus } from "../utils";

export function createRemoveCommand(cli: Argv) {
  cli.command(
    "remove <library>",
    "Delete a library's documentation from the index",
    (yargs) => {
      return yargs
        .version(false)
        .positional("library", {
          type: "string",
          description: "Library name to remove",
          demandOption: true,
        })
        .option("version", {
          type: "string",
          description:
            "Exact version to remove (omitted or empty removes unversioned docs)",
          alias: "v",
        })
        .option("server-url", {
          type: "string",
          description:
            "URL of external pipeline worker RPC (e.g., http://localhost:8080/api)",
          alias: "serverUrl",
        });
    },
    async (argv) => {
      await telemetry.track(TelemetryEvent.CLI_COMMAND, {
        command: "remove",
        library: argv.library,
        version: argv.version,
        useServerUrl: !!argv.serverUrl,
      });

      const library = argv.library as string;
      const version = argv.version as string | undefined;
      const serverUrl = argv.serverUrl as string | undefined;

      const appConfig = loadConfig(argv, {
        configPath: argv.config as string,
        searchDir: argv.storePath as string, // resolved globally
      });

      const eventBus = getEventBus(argv as CliContext);

      // Remove command doesn't need embeddings - explicitly disable for local execution
      const docService = await createDocumentManagement({
        serverUrl,
        eventBus,
        appConfig: appConfig,
      });
      let pipeline: IPipeline | undefined;
      try {
        pipeline = serverUrl
          ? await PipelineFactory.createPipeline(undefined, eventBus, {
              serverUrl,
              appConfig,
            })
          : await PipelineFactory.createPipeline(
              docService as DocumentManagementService,
              eventBus,
              { recoverJobs: false, appConfig },
            );
        await pipeline.start();
        const result = await new RemoveTool(docService, pipeline).execute({
          library,
          version,
        });
        renderTextOutput(result.message);
      } catch (error) {
        logger.error(
          `❌ Failed to remove ${library}${version ? `@${version}` : ""}: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      } finally {
        try {
          await pipeline?.stop();
        } finally {
          await docService.shutdown();
        }
      }
    },
  );
}
