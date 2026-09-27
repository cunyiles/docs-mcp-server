import { logger } from "../utils/logger";
import type { DocumentStore } from "./DocumentStore";
import { EmbeddingBatchError } from "./errors";

/** Longest wait between retries after transient provider failures. */
const MAX_BACKOFF_MS = 10 * 60_000;
/** How often an empty backlog is re-checked, for writes from other processes. */
const IDLE_POLL_MS = 60_000;
/** How long a chunk the provider rejects on its own is left out before a retry. */
const REJECTED_CHUNK_RETRY_MS = 60 * 60_000;

/**
 * Drains the embedding backlog in the background.
 *
 * Collection stores chunks without vectors; this worker gives them vectors at
 * the configured pace. Transient provider failures (rate limits, timeouts, 5xx)
 * back off exponentially and honour `Retry-After`. A batch the provider rejects
 * outright is retried chunk by chunk, so one bad chunk cannot block the rest.
 * The backlog is the database itself, so a restart resumes where it stopped.
 */
export class EmbeddingBacklogWorker {
  private stopped = false;
  /** New chunks arrived; ends an idle wait. */
  private newWork = false;
  private endIdleWait: (() => void) | null = null;
  private endAnyWait: (() => void) | null = null;

  constructor(
    private readonly store: DocumentStore,
    private readonly paceMs: number,
    private readonly retryBaseDelayMs: number,
  ) {}

  /** Starts draining; new chunks written to the store wake an idle worker. */
  start(): void {
    this.store.onBacklogGrew = () => {
      this.newWork = true;
      this.endIdleWait?.();
    };
    void this.run();
  }

  /** Stops after the current request; an in-flight result is discarded by the store. */
  stop(): void {
    this.stopped = true;
    this.store.onBacklogGrew = undefined;
    this.endAnyWait?.();
  }

  private wait(ms: number, idle: boolean): Promise<void> {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = () => {
        clearTimeout(timer);
        this.endIdleWait = null;
        this.endAnyWait = null;
        resolve();
      };
      if (this.stopped || (idle && this.newWork)) return finish();
      timer = setTimeout(finish, ms);
      timer.unref?.();
      this.endAnyWait = finish;
      // Pacing and backoff are never cut short by new work, only an idle wait.
      this.endIdleWait = idle ? finish : null;
    });
  }

  private async run(): Promise<void> {
    let backoffMs = 0;
    let singlesLeft = 0;
    const rejected = new Map<number, number>();
    const backOff = () => {
      backoffMs = Math.min(
        MAX_BACKOFF_MS,
        Math.max(backoffMs * 2, this.retryBaseDelayMs),
      );
      return backoffMs;
    };

    while (!this.stopped) {
      this.newWork = false;
      const now = Date.now();
      for (const [id, until] of rejected) if (until <= now) rejected.delete(id);

      let waitMs = this.paceMs;
      let idle = false;
      try {
        const embedded = await this.store.embedPendingBatch({
          limit: singlesLeft > 0 ? 1 : undefined,
          skip: rejected.keys(),
        });
        backoffMs = 0;
        if (embedded.length === 0) {
          waitMs = IDLE_POLL_MS;
          idle = true;
        } else if (singlesLeft > 0) {
          singlesLeft--;
        }
      } catch (error) {
        if (!(error instanceof EmbeddingBatchError)) {
          logger.error(`❌ Embedding backlog error: ${error}`);
          waitMs = backOff();
        } else if (error.transient) {
          waitMs = Math.max(backOff(), error.retryAfterMs ?? 0, this.paceMs);
          logger.warn(
            `⚠️  Embedding provider unavailable, retrying in ${waitMs}ms: ${error}`,
          );
        } else if (error.chunkIds.length > 1) {
          singlesLeft = error.chunkIds.length;
        } else {
          for (const id of error.chunkIds)
            rejected.set(id, now + REJECTED_CHUNK_RETRY_MS);
          if (singlesLeft > 0) singlesLeft--;
          logger.error(
            `❌ Embedding provider rejected chunk ${error.chunkIds}: ${error}`,
          );
        }
      }
      await this.wait(waitMs, idle);
    }
  }
}
