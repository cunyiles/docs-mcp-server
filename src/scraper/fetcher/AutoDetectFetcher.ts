/**
 * Fetcher that routes URLs to HTTP, browser, or file implementations, and
 * reaches hosts that refuse plain requests through a ladder of other ways in.
 * Requires the resolved scraper configuration to align with entrypoint-provided
 * settings.
 */

import { CancellationError } from "../../pipeline/errors";
import type { AppConfig } from "../../utils/config";
import { ChallengeError, HttpStatusError, TlsCertificateError } from "../../utils/errors";
import { logger } from "../../utils/logger";
import { MimeTypeUtils } from "../../utils/mimeTypeUtils";
import { BrowserFetcher } from "./BrowserFetcher";
import { FileFetcher } from "./FileFetcher";
import { HttpFetcher } from "./HttpFetcher";
import { ImpersonatingFetcher } from "./ImpersonatingFetcher";
import {
  type ContentFetcher,
  type FetchOptions,
  FetchStatus,
  type RawContent,
} from "./types";

/** Statuses with which a host refuses a crawler outright. */
const REFUSAL_STATUS_CODES = new Set([401, 403]);

/** One way into a host that refused plain requests. */
interface Rung {
  name: string;
  fetch(url: string, options?: FetchOptions): Promise<RawContent>;
}

/** What the ladder did during one crawl, for the library's status. */
export interface LadderReport {
  /** The way in that worked, per host that refused plain requests. */
  hostRungs: Record<string, string>;
  /** Hosts no rung got into, with the reason. */
  refusedHosts: Array<{ host: string; reason: string }>;
}

/**
 * AutoDetectFetcher selects the fetcher by URL type. A host that answers 403
 * or a bot challenge is tried through open doors first (another host serving
 * the same path, a web archive, a reader proxy), then browser fingerprint
 * impersonation, then Chromium. The rung that worked is remembered per host.
 */
export class AutoDetectFetcher implements ContentFetcher {
  private readonly httpFetcher: HttpFetcher;
  private readonly browserFetcher: BrowserFetcher;
  private readonly fileFetcher: FileFetcher;
  private readonly impersonatingFetcher: ImpersonatingFetcher;
  private readonly fetcherConfig: AppConfig["scraper"]["fetcher"];
  private readonly hostRungs = new Map<string, string>();
  private readonly refusedHosts = new Map<string, string>();

  constructor(scraperConfig: AppConfig["scraper"]) {
    this.httpFetcher = new HttpFetcher(scraperConfig);
    this.browserFetcher = new BrowserFetcher(scraperConfig);
    this.fileFetcher = new FileFetcher(scraperConfig);
    this.impersonatingFetcher = new ImpersonatingFetcher(scraperConfig);
    this.fetcherConfig = scraperConfig.fetcher;
  }

  /** Classifies a failure as a host refusing the crawler. */
  private static refusalReason(error: unknown): string | null {
    if (error instanceof ChallengeError) {
      return `bot challenge (${error.challengeType})`;
    }
    // Keyed off the response status, never the message text, which embeds the
    // url and would match any url containing "403".
    if (error instanceof HttpStatusError && REFUSAL_STATUS_CODES.has(error.statusCode)) {
      return `HTTP ${error.statusCode}`;
    }
    return null;
  }

  /** What the ladder did so far in this crawl. */
  ladderReport(): LadderReport {
    return {
      hostRungs: Object.fromEntries(this.hostRungs),
      refusedHosts: [...this.refusedHosts].map(([host, reason]) => ({ host, reason })),
    };
  }

  /**
   * Check if this fetcher can handle the given source.
   * Returns true for any URL that any of the underlying fetchers can handle.
   */
  canFetch(source: string): boolean {
    return (
      this.httpFetcher.canFetch(source) ||
      this.browserFetcher.canFetch(source) ||
      this.fileFetcher.canFetch(source)
    );
  }

  /**
   * Fetch content from the source, automatically selecting the appropriate fetcher
   * and finding another way in when the host refuses.
   */
  async fetch(source: string, options?: FetchOptions): Promise<RawContent> {
    // For file:// URLs, use FileFetcher directly
    if (this.fileFetcher.canFetch(source)) {
      logger.debug(`Using FileFetcher for: ${source}`);
      return this.fileFetcher.fetch(source, options);
    }

    if (!this.httpFetcher.canFetch(source)) {
      throw new Error(`No suitable fetcher found for URL: ${source}`);
    }

    const host = new URL(source).host;
    const remembered = this.hostRungs.get(host);
    if (remembered) {
      const rung = this.rungs(source).find((candidate) => candidate.name === remembered);
      const result = rung ? await this.tryRung(rung, source, options) : undefined;
      if (result) return result;
    }

    try {
      logger.debug(`Using HttpFetcher for: ${source}`);
      return await this.httpFetcher.fetch(source, options);
    } catch (error: unknown) {
      // A browser completes what stateless requests cannot: cookie redirect
      // chains and certificate chains it trusts. Neither is a refusal.
      if (
        error instanceof TlsCertificateError ||
        (error instanceof ChallengeError && error.challengeType === "redirect")
      ) {
        logger.info(`🔄 ${error.message}; using a browser for ${source}`);
        return this.browserFetcher.fetch(source, options);
      }
      const reason = AutoDetectFetcher.refusalReason(error);
      if (!reason) throw error;

      for (const rung of this.rungs(source)) {
        if (rung.name === remembered) continue;
        const result = await this.tryRung(rung, source, options);
        if (result) {
          logger.info(
            `🚪 ${host} refused us (${reason}); reached ${source} via ${rung.name}`,
          );
          this.hostRungs.set(host, rung.name);
          this.refusedHosts.delete(host);
          return result;
        }
      }
      if (!this.hostRungs.has(host)) {
        this.refusedHosts.set(host, `${reason}; no other way in worked`);
      }
      throw error;
    }
  }

  /** Runs one rung; undefined when it did not produce the page. */
  private async tryRung(
    rung: Rung,
    source: string,
    options?: FetchOptions,
  ): Promise<RawContent | undefined> {
    try {
      const result = await rung.fetch(source, options);
      return result.status === FetchStatus.SUCCESS ? result : undefined;
    } catch (error) {
      if (error instanceof CancellationError || options?.signal?.aborted) throw error;
      logger.debug(`${rung.name} did not reach ${source}: ${error}`);
      return undefined;
    }
  }

  /** The ways into a refusing host, cheapest and most honest first. */
  private rungs(source: string): Rung[] {
    const url = new URL(source);
    const rungs: Rung[] = [];
    // ponytail: only the same site's www/apex twin is assumed to serve the same
    // paths; a mirror elsewhere is added by a harness as an entry point.
    const alternates = [
      url.host.startsWith("www.") ? url.host.slice(4) : `www.${url.host}`,
    ];
    for (const alternate of alternates) {
      rungs.push({
        name: `alternate host ${alternate}`,
        fetch: async (target, options) => {
          const mirrored = new URL(target);
          mirrored.host = alternate;
          const result = await this.httpFetcher.fetch(mirrored.href, options);
          // Recorded under the refusing host's URL, links pointing back at it.
          return {
            ...rewriteHost(result, alternate, url.host),
            source: target,
          };
        },
      });
    }
    const { archiveBase, readerProxy, impersonate } = this.fetcherConfig;
    if (archiveBase) {
      rungs.push({
        name: "web archive",
        fetch: async (target, options) => ({
          ...(await this.httpFetcher.fetch(`${archiveBase}${target}`, {
            ...options,
            etag: undefined,
            lastModified: undefined,
          })),
          source: target,
        }),
      });
    }
    if (readerProxy) {
      rungs.push({
        name: "reader proxy",
        fetch: async (target, options) => {
          const result = await this.httpFetcher.fetch(`${readerProxy}${target}`, {
            ...options,
            etag: undefined,
            lastModified: undefined,
          });
          // Reader proxies answer with Markdown, whatever they label it.
          return { ...result, mimeType: "text/markdown", source: target };
        },
      });
    }
    if (impersonate) {
      rungs.push({
        name: "impersonation",
        fetch: async (target, options) => ({
          ...(await this.impersonatingFetcher.fetch(target, options)),
          impersonated: true,
        }),
      });
    }
    rungs.push({
      name: "browser",
      fetch: (target, options) => this.browserFetcher.fetch(target, options),
    });
    return rungs;
  }

  /**
   * Close all underlying fetchers to prevent resource leaks.
   */
  async close(): Promise<void> {
    await Promise.allSettled([
      this.browserFetcher.close(),
      // HttpFetcher and FileFetcher don't need explicit cleanup
    ]);
  }
}

/** Points a mirrored page's absolute links back at the host it stands in for. */
function rewriteHost(result: RawContent, from: string, to: string): RawContent {
  if (
    !MimeTypeUtils.isHtml(result.mimeType) &&
    !MimeTypeUtils.isMarkdown(result.mimeType)
  ) {
    return result;
  }
  const text = Buffer.isBuffer(result.content)
    ? result.content.toString("utf8")
    : result.content;
  return {
    ...result,
    content: text.split(`//${from}`).join(`//${to}`),
    charset: "utf-8",
  };
}
