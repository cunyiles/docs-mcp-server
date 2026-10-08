import { Impit } from "impit";
import { ScraperAccessPolicy } from "../../utils/accessPolicy";
import type { AppConfig } from "../../utils/config";
import { ScraperError } from "../../utils/errors";
import { MimeTypeUtils } from "../../utils/mimeTypeUtils";
import { type FetchOptions, FetchStatus, type RawContent } from "./types";

const MAX_REDIRECTS = 5;

/**
 * Fetches with a browser's TLS and HTTP/2 fingerprint and headers.
 *
 * A rung of the refusing-host ladder only: it disguises the crawler, so it is
 * used for hosts that already refused plain requests, never by default.
 */
export class ImpersonatingFetcher {
  private readonly accessPolicy: ScraperAccessPolicy;
  private readonly timeoutMs: number;
  private client?: Impit;

  constructor(scraperConfig: AppConfig["scraper"]) {
    this.accessPolicy = new ScraperAccessPolicy(scraperConfig.security);
    this.timeoutMs = scraperConfig.fetcher.timeoutMs;
  }

  async fetch(source: string, options?: FetchOptions): Promise<RawContent> {
    this.client ??= new Impit({
      browser: "chrome",
      followRedirects: false,
      timeout: this.timeoutMs,
    });
    let url = source;
    for (let redirects = 0; ; redirects++) {
      // Every hop is checked, as for plain requests.
      await this.accessPolicy.assertNetworkUrlAllowed(url);
      const response = await this.client.fetch(url, { signal: options?.signal });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        if (redirects >= MAX_REDIRECTS) {
          throw new ScraperError(`Too many redirects for ${source}`, false);
        }
        url = new URL(location, url).href;
        continue;
      }
      if (response.status === 404) {
        return {
          content: Buffer.from(""),
          mimeType: "text/plain",
          source,
          status: FetchStatus.NOT_FOUND,
        };
      }
      if (!response.ok) {
        throw new ScraperError(
          `Impersonated request for ${source} got HTTP ${response.status}`,
          false,
        );
      }
      const { mimeType, charset } = MimeTypeUtils.parseContentType(
        response.headers.get("content-type") ?? undefined,
      );
      return {
        content: Buffer.from(await response.arrayBuffer()),
        mimeType,
        charset,
        source: url,
        etag: response.headers.get("etag") ?? undefined,
        status: FetchStatus.SUCCESS,
      };
    }
  }
}
