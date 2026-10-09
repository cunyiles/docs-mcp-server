import { existsSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { AppConfig } from "../../utils/config";
import { logger } from "../../utils/logger";
import type { RawContent } from "../fetcher/types";
import type { ScraperOptions } from "../types";
import type { ConversionRequest } from "./conversionWorker";
import type { PipelineResult } from "./types";

/** The worker entry, built next to the bundle that loads this module. */
const WORKER_FILE = "conversionWorker.js";

interface Slot {
  worker: Worker;
  pending: Map<
    number,
    { resolve: (r: PipelineResult | undefined) => void; reject: (e: unknown) => void }
  >;
}

/**
 * Converts pages in worker threads, so converting a large page neither blocks
 * the server's answers to harnesses nor leaves the host's other cores idle.
 *
 * Exists only in a build, where the worker entry is a file of its own; from
 * source (tests, development) {@link ConversionPool.shared} is null and pages
 * are converted in process, with the same pipelines and the same results.
 */
export class ConversionPool {
  private static instance: ConversionPool | null | undefined;
  private readonly slots: Slot[] = [];
  private next = 0;
  private nextId = 0;

  private constructor(
    private readonly workerUrl: URL,
    private readonly size: number,
  ) {}

  /** The process-wide pool, or null when no worker entry is built. */
  static shared(): ConversionPool | null {
    if (ConversionPool.instance !== undefined) return ConversionPool.instance;
    const url = new URL(WORKER_FILE, import.meta.url);
    // ponytail: two workers keep a shared 4-core host usable; size by cores if
    // collection ever runs alone on a host.
    const size = Math.max(1, Math.min(2, os.availableParallelism() - 1));
    ConversionPool.instance =
      url.protocol === "file:" && existsSync(fileURLToPath(url))
        ? new ConversionPool(url, size)
        : null;
    if (ConversionPool.instance) {
      logger.debug(`Converting pages in ${size} worker thread(s)`);
    }
    return ConversionPool.instance;
  }

  private slot(): Slot {
    const index = this.next++ % this.size;
    let slot = this.slots[index];
    if (!slot) {
      const worker = new Worker(this.workerUrl);
      worker.unref();
      const created: Slot = { worker, pending: new Map() };
      worker.on(
        "message",
        (message: { id: number; result?: PipelineResult; error?: unknown }) => {
          const call = created.pending.get(message.id);
          if (!call) return;
          created.pending.delete(message.id);
          // An idle worker never keeps the process alive.
          if (created.pending.size === 0) worker.unref();
          if (message.error !== undefined) call.reject(message.error);
          else call.resolve(message.result);
        },
      );
      // A crashed worker fails what it held and is replaced on next use.
      const fail = (error: unknown) => {
        for (const call of created.pending.values()) call.reject(error);
        created.pending.clear();
        if (this.slots[index] === created) delete this.slots[index];
      };
      worker.on("error", fail);
      worker.on("exit", (code) => fail(new Error(`Conversion worker exited (${code})`)));
      this.slots[index] = created;
      slot = created;
    }
    return slot;
  }

  /** Converts a page in a worker; resolves like running the pipelines in process. */
  run(
    config: AppConfig,
    rawContent: RawContent,
    source: string,
    options: ScraperOptions,
  ): Promise<PipelineResult | undefined> {
    const slot = this.slot();
    const id = ++this.nextId;
    // Only what conversion reads crosses the thread boundary: signals and the
    // crawl's own bookkeeping cannot, and need not.
    const {
      signal: _signal,
      initialQueue: _initialQueue,
      knownUrls: _knownUrls,
      ...portable
    } = options;
    const request: ConversionRequest = {
      id,
      config,
      rawContent,
      source,
      options: portable,
    };
    return new Promise((resolve, reject) => {
      slot.pending.set(id, { resolve, reject });
      slot.worker.ref();
      slot.worker.postMessage(request);
    });
  }
}
