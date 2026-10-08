/**
 * Web scraper strategy that normalizes URLs, fetches content with automatic
 * fetcher selection, and routes content through pipelines. Requires resolved
 * configuration from the entrypoint to avoid implicit config loading.
 */
import { randomUUID } from "node:crypto";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as cheerio from "cheerio";
import { CancellationError } from "../../pipeline/errors";
import type { ProgressCallback } from "../../types";
import type { AppConfig } from "../../utils/config";
import { logger } from "../../utils/logger";
import { MimeTypeUtils } from "../../utils/mimeTypeUtils";
import {
  isMarkdownTwinPath,
  normalizeUrl,
  stripMarkdownExtension,
  type UrlNormalizerOptions,
} from "../../utils/url";
import { AutoDetectFetcher } from "../fetcher";
import { getHeader } from "../fetcher/headers";
import { FetchStatus, type RawContent } from "../fetcher/types";
import { HtmlCheerioParserMiddleware } from "../middleware/HtmlCheerioParserMiddleware";
import { HtmlLinkExtractorMiddleware } from "../middleware/HtmlLinkExtractorMiddleware";
import type { MiddlewareContext } from "../middleware/types";
import {
  createMimeTypeCapabilityPredicate,
  type MimeTypeCapabilityPredicate,
} from "../pipelines/capability";
import { PipelineFactory } from "../pipelines/PipelineFactory";
import type { ContentPipeline, PipelineResult } from "../pipelines/types";
import { type DetectedPlatform, detectPlatform } from "../platforms";
import type {
  CollectionStats,
  CrawlFrontier,
  QueueItem,
  ScraperOptions,
  ScraperProgressEvent,
} from "../types";
import { convertToString } from "../utils/buffer";
import { isLlmsTxtUrl, type LlmsTxtResult, parseLlmsTxt } from "../utils/llmsTxtParser";
import { needsBrowserRendering } from "../utils/renderSignals";
import { isFileLikePath, isPathDescendant } from "../utils/scope";
import { type ParsedSitemap, parseSitemap, sitemapsFromRobots } from "../utils/sitemap";
import { BaseScraperStrategy, type ProcessItemResult } from "./BaseScraperStrategy";
import { LocalFileStrategy } from "./LocalFileStrategy";

export interface WebScraperStrategyOptions {
  urlNormalizerOptions?: UrlNormalizerOptions;
  shouldFollowLink?: (baseUrl: URL, targetUrl: URL) => boolean;
}

/** Sitemap files read per collection; large sites split theirs into hundreds. */
const MAX_SITEMAP_FILES = 500;

/**
 * Sitemaps read recently, shared by every crawl in the process: several
 * libraries often live on one host, and a refresh revisits them in a row.
 * ponytail: unbounded map, entries replaced after the TTL; an LRU if hosts multiply.
 */
const SITEMAP_CACHE = new Map<
  string,
  { at: number; parsed: ParsedSitemap | undefined }
>();
const SITEMAP_CACHE_MS = 6 * 60 * 60 * 1000;

/** Forgets every cached sitemap; for a process that starts over, such as a test. */
export function clearSitemapCache(): void {
  SITEMAP_CACHE.clear();
}

/** URL patterns of published Markdown twins, in the order they are tried. */
const TWIN_PATTERNS = ["md", "html.md"] as const;
type TwinPattern = (typeof TWIN_PATTERNS)[number];

/** Pages in a row a rung may add nothing before a host stops getting it. */
const RUNG_TRIALS = 2;

/** What a crawl has learned about one host's fetch ladder. */
interface HostMemory {
  /** The twin pattern the host uses, "none" when it soft-404s, "unknown" until seen. */
  twin: TwinPattern | "none" | "unknown";
  /** Resolves true when the host answers any `.md` URL, real or not. */
  softNotFound?: Promise<boolean>;
  /** Pages in a row whose HTML navigation found nothing the links had not. */
  navMisses: number;
  /** Set once HTML navigation stops being read for this host. */
  navExhausted?: boolean;
}

/**
 * Matches paths naming an archive we know how to unpack.
 *
 * This is a policy statement, not a capability one, which is why it is not
 * expressed through the pipeline capability predicate: archives are readable —
 * `processRootArchive` unpacks one when it is the start URL — but following them
 * mid-crawl is deliberately declined. The two call sites act on the same test in
 * opposite directions, so they share this helper rather than the literal.
 *
 * @param pathname The URL pathname to test.
 * @returns True when the path names a supported archive.
 */
function isArchivePath(pathname: string): boolean {
  return /\.(zip|tar|gz|tgz)$/i.test(pathname);
}

interface LlmsTxtProbeResult {
  url: string;
  result: LlmsTxtResult;
}

export class WebScraperStrategy extends BaseScraperStrategy {
  private readonly fetcher: AutoDetectFetcher;
  private readonly shouldFollowLinkFn?: (baseUrl: URL, targetUrl: URL) => boolean;
  private readonly pipelines: ContentPipeline[];
  private readonly canProcessMimeType: MimeTypeCapabilityPredicate;
  private readonly localFileStrategy: LocalFileStrategy;
  private readonly htmlParser = new HtmlCheerioParserMiddleware();
  private readonly htmlLinkExtractor = new HtmlLinkExtractorMiddleware();
  private tempFiles: string[] = [];
  private siblingwiseRedirectWarned = false;
  private pendingLlmsTxtProbe: LlmsTxtProbeResult | null = null;
  /** In-scope pages the link crawl found, as page identities. */
  private readonly linkWitness = new Set<string>();
  /** The fetch ladder per host, learned during this crawl. */
  private readonly hosts = new Map<string, HostMemory>();
  /** Source text a documentation generator publishes, by page identity. */
  private readonly platformSources = new Map<string, string>();
  /** In-scope pages each detected generator index lists, by witness name. */
  private platformLists: Array<readonly [string, string[]]> = [];
  /** HTML fetched for navigation beside a Markdown page, by queued URL. */
  private readonly navigationPages = new Map<string, RawContent>();

  constructor(config: AppConfig, options: WebScraperStrategyOptions = {}) {
    super(config, { urlNormalizerOptions: options.urlNormalizerOptions });
    this.shouldFollowLinkFn = options.shouldFollowLink;
    this.fetcher = new AutoDetectFetcher(config.scraper);
    this.pipelines = PipelineFactory.createStandardPipelines(config);
    this.canProcessMimeType = createMimeTypeCapabilityPredicate(this.pipelines);
    this.localFileStrategy = new LocalFileStrategy(config);
  }

  canHandle(url: string): boolean {
    try {
      const parsedUrl = new URL(url);
      return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:";
    } catch {
      return false;
    }
  }

  private restorePreservedHash(requestedUrl: string, actualUrl: string): string {
    if (!requestedUrl.includes("#")) {
      return actualUrl;
    }

    try {
      const requested = new URL(requestedUrl);
      const actual = new URL(actualUrl);
      const normalizePathname = (pathname: string): string =>
        pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
      if (
        requested.origin === actual.origin &&
        normalizePathname(requested.pathname) === normalizePathname(actual.pathname) &&
        requested.search === actual.search
      ) {
        actual.hash = requested.hash;
        return actual.toString();
      }
    } catch {
      return actualUrl;
    }

    return actualUrl;
  }

  // Removed custom isInScope logic; using shared scope utility for consistent behavior

  private createFetchOptions(
    item: QueueItem,
    options: ScraperOptions,
    signal?: AbortSignal,
  ) {
    return {
      signal,
      followRedirects: options.followRedirects,
      headers: options.headers,
      etag: item.etag,
      lastModified: item.lastModified,
      // Fetch-time gate. The fetcher stays ignorant of pipelines; it is simply
      // told what this strategy is able to read.
      acceptsMimeType: this.canProcessMimeType,
      ...(item.internalAllowedFileRoots
        ? { internalAllowedFileRoots: item.internalAllowedFileRoots }
        : {}),
    };
  }

  /** Runs the first pipeline that can read the content; undefined when none can. */
  private async runPipelines(
    rawContent: RawContent,
    source: string,
    options: ScraperOptions,
  ): Promise<PipelineResult | undefined> {
    const contentBuffer = Buffer.isBuffer(rawContent.content)
      ? rawContent.content
      : Buffer.from(rawContent.content);
    for (const pipeline of this.pipelines) {
      if (pipeline.canProcess(rawContent.mimeType || "text/plain", contentBuffer)) {
        logger.debug(
          `Selected ${pipeline.constructor.name} for content type "${rawContent.mimeType}" (${source})`,
        );
        return pipeline.process({ ...rawContent, source }, options, this.fetcher);
      }
    }
    return undefined;
  }

  /**
   * Fetches the Markdown twin an HTML page declares with
   * `<link rel="alternate" type="text/markdown">`, or links to as its own
   * `.md` twin (JavaScript shells offer one in `<noscript>`), when it has one.
   *
   * @returns The Markdown response, or undefined when the page declares none or
   *   the twin cannot be read as Markdown.
   */
  private async fetchMarkdownAlternate(
    rawContent: RawContent,
    pageUrl: string,
    options: ScraperOptions,
    signal?: AbortSignal,
  ): Promise<RawContent | undefined> {
    const text = convertToString(rawContent.content, rawContent.charset);
    const $ = cheerio.load(text);
    const declared = $('link[rel~="alternate"]')
      .filter((_, el) => /^text\/(x-)?markdown\b/i.test($(el).attr("type") ?? ""))
      .first()
      .attr("href");
    const twins = TWIN_PATTERNS.map((pattern) => this.twinUrl(pageUrl, pattern));
    // Read from the raw text: anchors inside <noscript> are not parsed as markup.
    const linked = [...text.matchAll(/href=["']([^"']+\.md)["']/gi)]
      .map((match) => {
        try {
          return new URL(match[1], pageUrl).href;
        } catch {
          return "";
        }
      })
      .find((url) => twins.includes(url));
    const href = declared ?? linked;
    if (!href) return undefined;
    let alternateUrl: string;
    try {
      alternateUrl = new URL(href, pageUrl).href;
    } catch {
      return undefined;
    }
    if (alternateUrl === pageUrl) return undefined;
    try {
      const fetched = await this.fetcher.fetch(alternateUrl, {
        signal,
        headers: options.headers,
        followRedirects: options.followRedirects,
      });
      if (fetched.status !== FetchStatus.SUCCESS) return undefined;
      if (!this.isAcceptableMarkdownVariant(fetched)) return undefined;
      this.learnTwinPattern(pageUrl, alternateUrl);
      return MimeTypeUtils.isMarkdown(fetched.mimeType)
        ? fetched
        : { ...fetched, mimeType: "text/markdown" };
    } catch (error) {
      if (error instanceof CancellationError) throw error;
      logger.debug(`Markdown alternate ${alternateUrl} unavailable: ${error}`);
      return undefined;
    }
  }

  private buildMarkdownVariantUrl(url: string): string {
    const variant = new URL(url);
    if (variant.pathname.endsWith("/")) {
      variant.pathname = `${variant.pathname}index.html.md`;
      return variant.toString();
    }

    const lastSegment = variant.pathname.split("/").at(-1) ?? "";
    if (lastSegment.includes(".")) {
      variant.pathname = `${variant.pathname}.md`;
      return variant.toString();
    }

    variant.pathname = `${variant.pathname}/index.html.md`;
    return variant.toString();
  }

  /**
   * Records a web page under its canonical URL.
   *
   * Web URLs are the case the shared normaliser was written for: a server
   * returns the same bytes for `/config` and `/config/`, and for a directory and
   * its index file, so those spellings name one page.
   */
  protected override canonicalizeStoredUrl(
    url: string,
    scrapeOptions: ScraperOptions,
  ): string {
    return normalizeUrl(url, this.getUrlNormalizerOptions(scrapeOptions));
  }

  /**
   * Restates an accepted Markdown variant's content type as Markdown.
   *
   * Sites disagree on how to serve a `.md` file: vite.dev sends `text/markdown`,
   * react.dev sends `text/plain`. Both are Markdown documents, so both are
   * parsed and recorded as Markdown — the extension is the author's statement
   * about the format, and the plain-text pipeline would throw away every
   * heading. Markdown is close enough to a superset of plain text that a file
   * using none of its syntax still comes through intact.
   *
   * `text/plain` is not treated as a weaker signal than HTML. It was, briefly,
   * to stop a plain-text soft error page outranking the page it folds onto —
   * but the hosts that soft-404 a `.md` URL answer `200 text/markdown` with a
   * `# Page Not Found` body (ai-sdk.dev, nextjs.org), so that rule caught none
   * of them, while react.dev — the `text/plain` host — returns a real 404.
   * It cost the published Markdown of every such site and bought nothing.
   * Soft-error detection needs to read the body, and belongs elsewhere.
   */
  private asMarkdownRepresentation(url: string, rawContent: RawContent): RawContent {
    if (!this.isMarkdownUrl(url) || !this.isAcceptableMarkdownVariant(rawContent)) {
      return rawContent;
    }
    return MimeTypeUtils.isMarkdown(rawContent.mimeType)
      ? rawContent
      : { ...rawContent, mimeType: "text/markdown" };
  }

  private isAcceptableMarkdownVariant(rawContent: RawContent): boolean {
    const mimeType = rawContent.mimeType.toLowerCase();
    return MimeTypeUtils.isMarkdown(mimeType) || mimeType === "text/plain";
  }

  private isMarkdownUrl(url: string): boolean {
    // Pathname only, for the reason `canProcessDiscoveredLink` documents: given a
    // whole URL the detector reads the host's suffix as an extension, and `.md`
    // is Moldova's ccTLD, so `https://example.md/` would report as Markdown.
    let pathname: string;
    try {
      pathname = new URL(url).pathname;
    } catch {
      return false;
    }
    return isMarkdownTwinPath(pathname);
  }

  private shouldDiscoverHtmlNavigation(
    item: QueueItem,
    effectiveSource: string,
    options: ScraperOptions,
  ): boolean {
    return (
      getHeader(options.headers, "accept") === undefined &&
      !this.isMarkdownUrl(item.url) &&
      !this.isMarkdownUrl(effectiveSource)
    );
  }

  private async discoverHtmlNavigationLinks(
    item: QueueItem,
    effectiveSource: string,
    options: ScraperOptions,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const {
      etag: _markdownEtag,
      lastModified: _markdownLastModified,
      ...fetchOptions
    } = this.createFetchOptions(item, options, signal);

    try {
      const htmlContent = await this.fetcher.fetch(effectiveSource, {
        ...fetchOptions,
        // A companion representation must never redirect into a URL that the
        // crawler has not admitted. The primary request has already resolved
        // the canonical page, so a redirect here is a diagnostic, not a hint.
        followRedirects: false,
        headers: { ...options.headers, Accept: "text/html" },
        acceptsMimeType: (mimeType) => MimeTypeUtils.isHtml(mimeType),
      });

      if (
        htmlContent.status !== FetchStatus.SUCCESS ||
        !MimeTypeUtils.isHtml(htmlContent.mimeType)
      ) {
        logger.warn(
          `⚠️  HTML navigation discovery for ${effectiveSource} did not return HTML ` +
            `(status=${htmlContent.status}, contentType=${htmlContent.mimeType}). ` +
            `Keeping the primary representation.`,
        );
        return [];
      }
      // A site that negotiates Markdown shows its generator only in the HTML.
      this.navigationPages.set(item.url, htmlContent);

      const context: MiddlewareContext = {
        contentType: htmlContent.mimeType,
        content: convertToString(htmlContent.content, htmlContent.charset),
        source: htmlContent.source,
        links: [],
        errors: [],
        options,
      };
      await this.htmlParser.process(context, async () => {
        await this.htmlLinkExtractor.process(context, async () => {});
      });

      if (context.errors.length > 0) {
        logger.warn(
          `⚠️  HTML navigation discovery failed for ${effectiveSource}: ` +
            context.errors.map((error) => error.message).join("; "),
        );
        return [];
      }

      return context.links;
    } catch (error) {
      if (error instanceof CancellationError) {
        throw error;
      }
      if (signal?.aborted) {
        throw new CancellationError("HTML navigation discovery cancelled");
      }
      logger.warn(
        `⚠️  HTML navigation discovery failed for ${effectiveSource}: ${error instanceof Error ? error.message : String(error)}. ` +
          `Keeping the primary representation.`,
      );
      return [];
    }
  }

  private filterDiscoveredLinks(
    links: string[],
    effectiveSource: string,
    options: ScraperOptions,
  ): string[] {
    // A query-string link brings its bare URL along, so a variant that serves
    // the same content can be collapsed into it once both are collected.
    const withBareUrls = links.flatMap((link) => {
      try {
        const target = new URL(link, effectiveSource);
        if (target.search === "") return [link];
        const bare = new URL(target.href);
        bare.search = "";
        return [link, bare.href];
      } catch {
        return [link];
      }
    });
    const admitted = [
      ...new Set(
        withBareUrls.flatMap((link) => {
          try {
            const targetUrl = new URL(link, effectiveSource);

            // Archives are readable but deliberately not followed mid-crawl.
            if (isArchivePath(targetUrl.pathname)) {
              return [];
            }

            if (!this.canProcessDiscoveredLink(targetUrl)) {
              return [];
            }

            if (!this.shouldProcessUrl(targetUrl.href, options)) {
              return [];
            }
            if (this.shouldFollowLinkFn) {
              const baseUrl = this.canonicalBaseUrl ?? new URL(options.url);
              return this.shouldFollowLinkFn(baseUrl, targetUrl) ? [targetUrl.href] : [];
            }
            return [targetUrl.href];
          } catch {
            return [];
          }
        }),
      ),
    ];
    for (const link of admitted) this.linkWitness.add(this.pageIdentity(link, options));
    return admitted;
  }

  /** The identity a listed URL is stored under, for comparing witnesses. */
  private pageIdentity(url: string, options: ScraperOptions): string {
    const identity = this.isMarkdownUrl(url) ? stripMarkdownExtension(url) : url;
    return this.canonicalizeStoredUrl(identity, options);
  }

  /** Fetches a witness file; undefined when it is not there. */
  private async fetchWitness(
    url: string,
    options: ScraperOptions,
    signal?: AbortSignal,
  ): Promise<RawContent | undefined> {
    try {
      const raw = await this.fetcher.fetch(url, { signal, headers: options.headers });
      return raw.status === FetchStatus.SUCCESS ? raw : undefined;
    } catch (error) {
      if (error instanceof CancellationError) throw error;
      logger.debug(`Witness ${url} unavailable: ${error}`);
      return undefined;
    }
  }

  /**
   * Recognises the documentation generator behind an entry point from the HTML
   * the crawl fetched for it, remembers where the generator publishes page
   * sources, and queues the pages its index lists.
   *
   * ponytail: a refresh whose entry page answers 304 re-reads no index; the
   * stored pages are still revisited, and new ones arrive through links.
   */
  private async detectPlatformAt(
    item: QueueItem,
    rawContent: RawContent,
    options: ScraperOptions,
    signal?: AbortSignal,
  ): Promise<QueueItem[]> {
    const isEntry =
      item.depth === 0 &&
      !item.fromLlmsTxt &&
      [options.url, ...(options.entryPoints ?? [])].some(
        (entry) =>
          this.pageIdentity(entry, options) === this.pageIdentity(item.url, options),
      );
    if (
      !isEntry ||
      rawContent.status !== FetchStatus.SUCCESS ||
      !MimeTypeUtils.isHtml(rawContent.mimeType)
    ) {
      return [];
    }
    const found: DetectedPlatform | null = await detectPlatform(
      rawContent.source,
      convertToString(rawContent.content, rawContent.charset),
      async (url) => {
        const raw = await this.fetchWitness(url, options, signal);
        return raw ? convertToString(raw.content, raw.charset) : undefined;
      },
    );
    if (!found) return [];
    for (const [page, source] of found.sources ?? []) {
      this.platformSources.set(this.pageIdentity(page, options), source);
    }
    const pages = found.pages.filter((url) => this.shouldProcessUrl(url, options));
    logger.info(`🧭 ${item.url}: ${found.witness} lists ${pages.length} pages in scope`);
    this.platformLists.push([found.witness, pages]);
    return pages.map((url) => ({ url, depth: 1, fromWitness: true }));
  }

  /**
   * Reads every sitemap the entry points' hosts publish (robots.txt
   * declarations, the host root, the entry point's directory), following
   * sitemap indexes, and returns the in-scope pages they list.
   *
   * @returns The listed pages, or null when no host publishes a sitemap.
   */
  private async readSitemapWitness(
    options: ScraperOptions,
    signal?: AbortSignal,
  ): Promise<string[] | null> {
    const candidates: string[] = [];
    for (const root of new Set([options.url, ...(options.entryPoints ?? [])])) {
      const { origin, pathname } = new URL(root);
      const robots = await this.fetchWitness(`${origin}/robots.txt`, options, signal);
      if (robots) {
        candidates.push(
          ...sitemapsFromRobots(convertToString(robots.content, robots.charset)),
        );
      }
      candidates.push(`${origin}/sitemap.xml`);
      const directory = pathname.slice(0, pathname.lastIndexOf("/") + 1);
      if (directory !== "/") candidates.push(`${origin}${directory}sitemap.xml`);
    }

    const seen = new Set<string>();
    const listed = new Set<string>();
    let found = false;
    // Read a level of the sitemap tree at a time, its files in parallel: large
    // sites serve each child slowly, and a crawl should not wait for them in turn.
    let level = candidates;
    while (level.length > 0 && seen.size < MAX_SITEMAP_FILES) {
      const batch = [...new Set(level)]
        .filter((url) => !seen.has(url))
        .slice(0, MAX_SITEMAP_FILES - seen.size);
      for (const url of batch) seen.add(url);
      const parsedLevel = await Promise.all(
        batch.map((url) => this.readSitemap(url, options, signal)),
      );
      level = [];
      for (const parsed of parsedLevel) {
        if (!parsed || (parsed.sitemaps.length === 0 && parsed.urls.length === 0))
          continue;
        found = true;
        level.push(...parsed.sitemaps);
        for (const url of parsed.urls) {
          if (this.shouldProcessUrl(url, options)) listed.add(url);
        }
      }
    }
    return found ? [...listed] : null;
  }

  /**
   * Reads one sitemap file, from a short-lived process-wide cache when another
   * crawl of the same host read it recently.
   */
  private async readSitemap(
    url: string,
    options: ScraperOptions,
    signal?: AbortSignal,
  ): Promise<ParsedSitemap | undefined> {
    const cached = SITEMAP_CACHE.get(url);
    if (cached && Date.now() - cached.at < SITEMAP_CACHE_MS) return cached.parsed;
    const raw = await this.fetchWitness(url, options, signal);
    const parsed = raw ? parseSitemap(raw.content) : undefined;
    SITEMAP_CACHE.set(url, { at: Date.now(), parsed });
    return parsed;
  }

  /**
   * Resolves the page identity for a fetched resource.
   *
   * A published Markdown file is a representation of a page rather than a page of
   * its own, so `guide.md` is recorded as `guide`. Both signals are required and
   * they answer different questions: the extension states what the author meant
   * the URL to be, the response states what the server actually returned. The
   * extension alone would fold a soft 404 or an HTML page onto an identity it
   * does not serve; the response alone would rewrite the identity of a document
   * that is legitimately its own resource.
   *
   * Being a property of the response, the rule needs no knowledge of how the URL
   * was discovered or of what else the crawl has seen — which is what lets an
   * `llms.txt` entry and a crawled link converge without ordering guarantees.
   *
   * @param url The URL the content was fetched from, after redirects.
   * @param rawContent The response, consulted for its resolved MIME type.
   * @returns The canonical page URL.
   */
  private resolvePageIdentity(url: string, rawContent: RawContent): string {
    if (!this.isMarkdownUrl(url) || !this.isAcceptableMarkdownVariant(rawContent)) {
      return url;
    }
    const canonical = stripMarkdownExtension(url);
    if (canonical !== url) {
      logger.debug(`Markdown variant ${url} recorded as ${canonical}`);
    }
    return canonical;
  }

  /**
   * Queue-time gate: rejects a discovered link whose path extension names binary
   * media that no configured pipeline can process, before any request is made.
   *
   * Two conditions must both hold, and they answer different questions. The binary
   * media check decides how far to trust an extension; the capability predicate
   * decides what can be processed. Keeping them separate means adding an image
   * pipeline still widens this gate automatically, while a `.csh` or `.tcl` file the
   * `mime` package files under `application/*` is never rejected on its name alone.
   *
   * A null detection means "no opinion" — the link is admitted so the fetch-time
   * gate can decide against the server's actual `Content-Type`. That covers
   * extensionless URLs, unknown extensions, and paths whose only dots sit in a
   * directory segment.
   *
   * @param targetUrl The resolved absolute URL of the discovered link.
   * @returns True when the link should continue through the remaining filters.
   */
  private canProcessDiscoveredLink(targetUrl: URL): boolean {
    const mimeType = MimeTypeUtils.detectMimeTypeFromPath(targetUrl.pathname);
    const isUnreadableMedia =
      !!mimeType &&
      MimeTypeUtils.isBinaryMediaType(mimeType) &&
      !this.canProcessMimeType(mimeType);

    if (!isUnreadableMedia) {
      return true;
    }
    logger.debug(`Skipping ${targetUrl.href}: ${mimeType} is not processable`);
    return false;
  }

  private async fetchItemContent(
    item: QueueItem,
    options: ScraperOptions,
    signal?: AbortSignal,
  ): Promise<RawContent> {
    const fetchOptions = this.createFetchOptions(item, options, signal);

    if (!item.fromLlmsTxt || this.isMarkdownUrl(item.url)) {
      const source =
        (await this.fetchPlatformSource(item, options, signal)) ??
        (await this.fetchMarkdownTwin(item, options, signal));
      return source ?? (await this.fetcher.fetch(item.url, fetchOptions));
    }

    const markdownVariantUrl = this.buildMarkdownVariantUrl(item.url);
    try {
      const markdownContent = await this.fetcher.fetch(markdownVariantUrl, fetchOptions);
      if (
        markdownContent.status === FetchStatus.SUCCESS &&
        this.isAcceptableMarkdownVariant(markdownContent)
      ) {
        logger.debug(
          `llms.txt Markdown URL preference succeeded: ${item.url} -> ${markdownVariantUrl}`,
        );
        this.learnTwinPattern(item.url, markdownVariantUrl);
        return markdownContent;
      }

      logger.debug(
        `llms.txt Markdown URL preference fell back for ${item.url}: ${markdownVariantUrl} returned status=${markdownContent.status}, contentType=${markdownContent.mimeType}`,
      );
    } catch (error) {
      logger.debug(
        `llms.txt Markdown URL preference fell back for ${item.url}: ${error}`,
      );
    }

    return this.fetcher.fetch(item.url, fetchOptions);
  }

  /**
   * The source text the site's documentation generator publishes for this page
   * (Sphinx `_sources`), recorded under the page's own URL.
   */
  private async fetchPlatformSource(
    item: QueueItem,
    options: ScraperOptions,
    signal?: AbortSignal,
  ): Promise<RawContent | undefined> {
    const pageUrl = item.identityUrl ?? item.url;
    const sourceUrl = this.platformSources.get(this.pageIdentity(pageUrl, options));
    if (!sourceUrl) return undefined;
    try {
      const fetched = await this.fetcher.fetch(sourceUrl, {
        ...this.createFetchOptions(item, options, signal),
        acceptsMimeType: undefined,
      });
      if (fetched.status === FetchStatus.NOT_MODIFIED) return { ...fetched, pageUrl };
      if (fetched.status !== FetchStatus.SUCCESS) return undefined;
      return { ...fetched, mimeType: "text/markdown", pageUrl };
    } catch (error) {
      if (error instanceof CancellationError) throw error;
      return undefined;
    }
  }

  /** What this crawl learned about a host's rungs. */
  private hostMemory(url: string): HostMemory {
    const host = new URL(url).host;
    let memory = this.hosts.get(host);
    if (!memory) {
      memory = { twin: "unknown", navMisses: 0 };
      this.hosts.set(host, memory);
    }
    return memory;
  }

  /**
   * Remembers which twin URL pattern a host publishes, from a twin the host
   * itself pointed to.
   */
  private learnTwinPattern(pageUrl: string, twinUrl: string): void {
    const memory = this.hostMemory(pageUrl);
    if (memory.twin !== "unknown") return;
    const pattern = TWIN_PATTERNS.find((p) => this.twinUrl(pageUrl, p) === twinUrl);
    if (pattern) {
      logger.debug(`${new URL(pageUrl).host} publishes Markdown twins (${pattern})`);
      memory.twin = pattern;
    }
  }

  /**
   * The first rung of the fetch ladder: the page's published Markdown twin.
   *
   * Asked only on hosts that showed they publish twins (a declared Markdown
   * alternate or an llms.txt twin), with the URL pattern they used, so later
   * pages skip the HTML. A host that answers any `.md` URL with a page (a
   * soft 404) is not trusted with twins.
   *
   * @returns The twin's response, or undefined to fetch the page itself.
   */
  private async fetchMarkdownTwin(
    item: QueueItem,
    options: ScraperOptions,
    signal?: AbortSignal,
  ): Promise<RawContent | undefined> {
    const url = new URL(item.url);
    if (
      this.isMarkdownUrl(item.url) ||
      url.search !== "" ||
      getHeader(options.headers, "accept") !== undefined
    ) {
      return undefined;
    }
    const memory = this.hostMemory(item.url);
    if (memory.twin === "none" || memory.twin === "unknown") return undefined;

    const probe = async (target: string) => {
      try {
        const fetched = await this.fetcher.fetch(target, {
          signal,
          headers: options.headers,
          followRedirects: false,
        });
        return fetched.status === FetchStatus.SUCCESS &&
          this.isAcceptableMarkdownVariant(fetched)
          ? fetched
          : undefined;
      } catch (error) {
        if (error instanceof CancellationError) throw error;
        return undefined;
      }
    };

    // A host that answers a URL that cannot exist has no trustworthy twins.
    memory.softNotFound ??= probe(`${url.origin}/${randomUUID()}.md`).then(Boolean);
    if (await memory.softNotFound) {
      memory.twin = "none";
      return undefined;
    }

    const twin = await probe(this.twinUrl(item.url, memory.twin));
    return twin ? { ...twin, mimeType: "text/markdown" } : undefined;
  }

  private twinUrl(pageUrl: string, pattern: TwinPattern): string {
    if (pattern === "html.md") return this.buildMarkdownVariantUrl(pageUrl);
    const twin = new URL(pageUrl);
    twin.pathname = twin.pathname.endsWith("/")
      ? `${twin.pathname}index.md`
      : `${twin.pathname}.md`;
    return twin.href;
  }

  private getLlmsTxtCandidates(baseUrl: string, inputUrl: string): string[] {
    const llmsTxtAt = (base: string, pathname: string): string => {
      const url = new URL(base);
      url.pathname = pathname.replace(/\/+/g, "/");
      url.search = "";
      url.hash = "";
      return url.toString();
    };

    const { pathname } = new URL(inputUrl);
    // Direct subpath candidate (e.g. /paymob-docs -> /paymob-docs/llms.txt).
    // Only for directory-like paths: appending to a file name (/docs/page.html)
    // would probe /docs/page.html/llms.txt, which is a guaranteed 404.
    // Appending to a file name (/docs/page.html, /docs/index) would probe a
    // guaranteed 404, so only directory-like paths get the subpath candidate.
    const isDirectoryLike = !isFileLikePath(pathname);
    // Parent path candidate (e.g. /docs/v1/page.html -> /docs/v1/llms.txt)
    const parentPath = pathname.endsWith("/")
      ? pathname
      : pathname.slice(0, pathname.lastIndexOf("/") + 1);

    return [
      ...new Set([
        ...(isDirectoryLike
          ? [llmsTxtAt(inputUrl, `${pathname.replace(/\/+$/, "")}/llms.txt`)]
          : []),
        llmsTxtAt(inputUrl, `${parentPath}llms.txt`),
        llmsTxtAt(baseUrl, "/llms.txt"),
      ]),
    ];
  }

  /**
   * Probes for an llms.txt file using the existing fetcher and access policy.
   * @param baseUrl The site base URL used for the root fallback probe.
   * @param inputUrl The original input URL used for the subpath probe.
   * @param options Scraper options to apply to probe requests.
   * @param signal Optional abort signal.
   * @returns The first valid llms.txt result, or null when none is available.
   */
  async probeLlmsTxt(
    baseUrl: string,
    inputUrl: string,
    options: ScraperOptions,
    signal?: AbortSignal,
  ): Promise<LlmsTxtProbeResult | null> {
    for (const candidate of this.getLlmsTxtCandidates(baseUrl, inputUrl)) {
      try {
        const { acceptsMimeType: _gate, ...probeOptions } = this.createFetchOptions(
          { url: candidate, depth: 0 },
          options,
          signal,
        );
        const rawContent = await this.fetcher.fetch(candidate, probeOptions);
        if (rawContent.status !== FetchStatus.SUCCESS) {
          logger.debug(`llms.txt probe failed for ${candidate}: ${rawContent.status}`);
          continue;
        }

        const result = parseLlmsTxt(
          convertToString(rawContent.content, rawContent.charset),
        );
        if (result.links.length === 0) {
          logger.debug(`llms.txt probe failed for ${candidate}: invalid content`);
          continue;
        }

        logger.info(
          `📄 Detected llms.txt at ${rawContent.source} (${result.links.length} URLs)`,
        );
        return { url: rawContent.source, result };
      } catch (error) {
        logger.debug(`llms.txt probe failed for ${candidate}: ${error}`);
      }
    }

    return null;
  }

  private createLlmsTxtQueueItems(
    options: ScraperOptions,
    probe: LlmsTxtProbeResult,
  ): QueueItem[] {
    const items: QueueItem[] = [];

    for (const link of probe.result.links) {
      try {
        const targetUrl = new URL(link.url, probe.url);
        if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
          continue;
        }
        // Seeds go through the same admission checks as discovered links: an
        // image or archive listed in llms.txt should be rejected at queue time
        // rather than fetched and then discarded.
        if (isArchivePath(targetUrl.pathname)) {
          continue;
        }
        if (!this.canProcessDiscoveredLink(targetUrl)) {
          continue;
        }
        if (!this.shouldProcessUrl(targetUrl.href, options)) {
          continue;
        }
        if (this.shouldFollowLinkFn) {
          const baseUrl = this.canonicalBaseUrl ?? new URL(options.url);
          if (!this.shouldFollowLinkFn(baseUrl, targetUrl)) {
            continue;
          }
        }
        items.push({ url: targetUrl.href, depth: 0, fromLlmsTxt: true });
      } catch {}
    }

    return items;
  }

  private consumePendingLlmsTxtQueueItems(
    item: QueueItem,
    options: ScraperOptions,
  ): QueueItem[] {
    if (item.depth !== 0) {
      return [];
    }

    const probe = this.pendingLlmsTxtProbe;
    this.pendingLlmsTxtProbe = null;

    return probe ? this.createLlmsTxtQueueItems(options, probe) : [];
  }

  private updateCanonicalBaseUrl(effectiveSource: string, options: ScraperOptions): void {
    // Protocol and host are always adopted from the redirected URL so cross-origin redirects
    // (http->https, apex<->www, port changes) don't drop every discovered link via the host check.
    // Keep the user-provided path as the scope anchor: callers who start at `/docs` expect the
    // whole docs subtree even when the server redirects that index URL to a concrete page.
    const final = new URL(effectiveSource);
    const userPath = new URL(options.url).pathname;
    if (!isPathDescendant(userPath, final.pathname) && !this.siblingwiseRedirectWarned) {
      logger.warn(
        `⚠️  Depth-0 redirect changed path siblingwise. Scope anchor remains the user-provided path; ` +
          `discovered links under the redirected path will not be in scope. ` +
          `Requested: ${options.url} → Final: ${effectiveSource} → Scope anchor: ${userPath}. ` +
          `If the redirected path is intended, resubmit with that URL.`,
      );
      this.siblingwiseRedirectWarned = true;
    }
    final.pathname = userPath;
    this.canonicalBaseUrl = final;
  }

  /**
   * Processes a single queue item by fetching its content and processing it through pipelines.
   * @param item - The queue item to process.
   * @param options - Scraper options including headers for HTTP requests.
   * @param _progressCallback - Optional progress callback (not used here).
   * @param signal - Optional abort signal for request cancellation.
   * @returns An object containing the processed document and extracted links.
   */
  protected override async processItem(
    item: QueueItem,
    options: ScraperOptions,
    signal?: AbortSignal,
  ): Promise<ProcessItemResult> {
    const { url } = item;

    try {
      if (isLlmsTxtUrl(url)) {
        logger.debug(`Skipping llms.txt meta-file: ${url}`);
        return { url, links: [], status: FetchStatus.SUCCESS };
      }

      // Log when processing with ETag for conditional requests
      if (item.etag) {
        logger.debug(`Processing ${url} with stored ETag: ${item.etag}`);
      }

      // Check for Archive Root URL (only the user's actual requested root)
      if (this.isRequestedRoot(item, options)) {
        if (isArchivePath(new URL(url).pathname)) {
          return this.processRootArchive(item, options, signal);
        }
      }

      // Use AutoDetectFetcher which handles fallbacks automatically
      const fetched = await this.fetchItemContent(item, options, signal);
      const fetchedSource = options.preserveHashes
        ? this.restorePreservedHash(url, fetched.source)
        : fetched.source;
      // Judged on where the bytes came from, not on where we asked: a redirect
      // from an extensionless URL to a `.md` resource is still a published
      // Markdown representation, and the queued URL would hide that. Applied
      // here rather than per fetch path so every route reaching this point —
      // including the llms.txt variant fallback — is covered by one rule.
      const rawContent = this.asMarkdownRepresentation(fetchedSource, fetched);
      // A Markdown variant is recorded under the page it represents, so a `.md`
      // URL and its canonical form resolve to one identity however each was found.
      // A generator's source text names the page it was written for, and so
      // does a refresh asking the location a page's content came from.
      const effectiveSource =
        fetched.pageUrl ??
        (item.identityUrl && fetchedSource === item.url
          ? item.identityUrl
          : this.resolvePageIdentity(fetchedSource, rawContent));
      if (this.isRequestedRoot(item, options)) {
        this.updateCanonicalBaseUrl(effectiveSource, options);
      }
      const llmsTxtQueueItems = [
        ...this.consumePendingLlmsTxtQueueItems(item, options),
        ...(await this.detectPlatformAt(item, fetched, options, signal)),
      ];

      logger.debug(
        `Fetch result for ${url}: status=${rawContent.status}, etag=${rawContent.etag || "none"}`,
      );

      const shouldDiscoverHtmlNavigation = this.shouldDiscoverHtmlNavigation(
        item,
        effectiveSource,
        options,
      );

      // Return the status directly - BaseScraperStrategy handles NOT_MODIFIED and NOT_FOUND
      // Use the final URL from rawContent.source (which may differ due to redirects)
      if (rawContent.status !== FetchStatus.SUCCESS) {
        logger.debug(`Skipping pipeline for ${url} due to status: ${rawContent.status}`);
        // An unchanged HTML page has unchanged navigation; only a page stored
        // from another representation needs its HTML navigation read again.
        const navigationLinks =
          rawContent.status === FetchStatus.NOT_MODIFIED &&
          this.isRequestedRoot(item, options) &&
          shouldDiscoverHtmlNavigation &&
          !MimeTypeUtils.isHtml(item.storedMimeType ?? "")
            ? await this.discoverHtmlNavigationLinks(
                item,
                effectiveSource,
                options,
                signal,
              )
            : [];
        const filteredNavigationLinks = this.filterDiscoveredLinks(
          navigationLinks,
          effectiveSource,
          options,
        );
        const maxDepth = options.maxDepth ?? this.config.scraper.maxDepth;
        const navigationQueueItems =
          maxDepth >= 0 && item.depth + 1 > maxDepth
            ? []
            : filteredNavigationLinks.map(
                (link) => ({ url: link, depth: item.depth + 1 }) satisfies QueueItem,
              );
        return {
          url: effectiveSource,
          links: filteredNavigationLinks,
          queueItems: [...llmsTxtQueueItems, ...navigationQueueItems],
          // A fatal root skip must retain the response MIME type for diagnostics.
          sourceContentType: rawContent.mimeType ?? null,
          status: rawContent.status,
        };
      }

      if (MimeTypeUtils.isMarkdown(rawContent.mimeType)) {
        logger.debug(
          `Server provided Markdown content for ${url} via content negotiation or Markdown URL (${rawContent.mimeType})`,
        );
      }

      // A JavaScript shell that offers its Markdown twin is read from the twin,
      // so no browser starts for it.
      let shellTwin: { raw: RawContent; processed: PipelineResult } | undefined;
      if (
        MimeTypeUtils.isHtml(rawContent.mimeType) &&
        needsBrowserRendering(convertToString(rawContent.content, rawContent.charset))
      ) {
        const twin = await this.fetchMarkdownAlternate(
          rawContent,
          effectiveSource,
          options,
          signal,
        );
        const fromTwin = twin
          ? await this.runPipelines(twin, effectiveSource, options)
          : undefined;
        if (twin && fromTwin?.textContent?.trim()) {
          shellTwin = { raw: twin, processed: fromTwin };
        }
      }

      // --- Start Pipeline Processing ---
      let processed =
        shellTwin?.processed ??
        (await this.runPipelines(rawContent, effectiveSource, options));

      if (!processed) {
        // If content type is unsupported (e.g. binary/archive encountered during crawl), we just skip
        logger.warn(
          `⚠️  Unsupported content type "${rawContent.mimeType}" for URL ${url}. Skipping processing.`,
        );
        return {
          url: effectiveSource,
          links: [],
          queueItems: llmsTxtQueueItems,
          sourceContentType: rawContent.mimeType ?? null,
          // Skipped, not empty: nothing read the body, so we cannot claim the
          // page has no content — and a refresh must not erase what is stored.
          status: FetchStatus.SKIPPED,
        };
      }

      // Log errors from pipeline
      for (const err of processed.errors ?? []) {
        logger.warn(`⚠️  Processing error for ${url}: ${err.message}`);
      }

      // A page that declares a Markdown alternate is recorded from it: the
      // site's own Markdown is cleaner than HTML we convert, and the page's
      // URL stays its identity. Links still come from both.
      let representation = shellTwin?.raw ?? rawContent;
      let representationUrl = shellTwin?.raw.source ?? fetchedSource;
      if (MimeTypeUtils.isHtml(rawContent.mimeType) && !shellTwin) {
        const alternate = await this.fetchMarkdownAlternate(
          rawContent,
          effectiveSource,
          options,
          signal,
        );
        const fromAlternate = alternate
          ? await this.runPipelines(alternate, effectiveSource, options)
          : undefined;
        if (alternate && fromAlternate?.textContent?.trim()) {
          processed = {
            ...fromAlternate,
            links: [...(processed.links ?? []), ...(fromAlternate.links ?? [])],
          };
          representation = alternate;
          representationUrl = alternate.source;
        }
      }

      // HTML navigation beside Markdown is read until it stops finding pages:
      // a site's sidebar is the same on every page, so after the first pages it
      // only costs a request per page.
      const memory = this.hostMemory(effectiveSource);
      const discoverNavigation =
        MimeTypeUtils.isMarkdown(rawContent.mimeType) &&
        shouldDiscoverHtmlNavigation &&
        !memory.navExhausted;
      const navigationLinks = discoverNavigation
        ? await this.discoverHtmlNavigationLinks(item, effectiveSource, options, signal)
        : [];
      if (discoverNavigation) {
        const known = new Set(
          this.filterDiscoveredLinks(processed.links ?? [], effectiveSource, options),
        );
        const found = this.filterDiscoveredLinks(
          navigationLinks,
          effectiveSource,
          options,
        ).some(
          (link) =>
            !known.has(link) &&
            !this.visited.has(normalizeUrl(link, this.getUrlNormalizerOptions(options))),
        );
        memory.navMisses = found ? 0 : memory.navMisses + 1;
        if (memory.navMisses >= RUNG_TRIALS) {
          logger.debug(
            `HTML navigation on ${new URL(effectiveSource).host} adds nothing`,
          );
          memory.navExhausted = true;
        }
      }
      const navigationPage = this.navigationPages.get(item.url);
      this.navigationPages.delete(item.url);
      if (navigationPage) {
        llmsTxtQueueItems.push(
          ...(await this.detectPlatformAt(item, navigationPage, options, signal)),
        );
      }
      const mergedLinks = [...new Set([...(processed.links ?? []), ...navigationLinks])];
      const filteredLinks = this.filterDiscoveredLinks(
        mergedLinks,
        effectiveSource,
        options,
      );

      // Check if content processing resulted in usable content
      if (!processed.textContent?.trim()) {
        const pipelineFailed = (processed.errors?.length ?? 0) > 0;
        logger.warn(
          `⚠️  No processable content found for ${url} after pipeline execution.`,
        );
        return {
          url: effectiveSource,
          // Recorded here as well as on the non-empty return: an empty page
          // still has a retrieval location, and the base strategy's fallback
          // cannot recover it once the identity has moved — it compares the
          // identity with itself and finds no divergence. Without this the row
          // stores NULL and the next refresh asks the identity while sending
          // the validator the Markdown file issued.
          contentUrl: effectiveSource === fetchedSource ? undefined : fetchedSource,
          title: processed.title ?? null,
          sourceContentType: rawContent.mimeType,
          contentType: processed.contentType || rawContent.mimeType,
          etag: rawContent.etag,
          lastModified: rawContent.lastModified,
          links: filteredLinks,
          queueItems: llmsTxtQueueItems,
          // A clean run that extracted nothing means the page is empty. An errored
          // run means we learned nothing about it, which is a different fact and
          // gets different handling downstream.
          pipelineFailed,
          renderedInBrowser: rawContent.renderedInBrowser || processed.renderedInBrowser,
          impersonated: rawContent.impersonated,
          status: FetchStatus.SUCCESS,
        };
      }

      return {
        url: effectiveSource,
        // Recorded only when the bytes came from somewhere other than the
        // page's identity, so a later refresh requests that representation and
        // the validator below goes back to the resource that issued it. Equal
        // values would claim a divergence that does not exist.
        contentUrl: effectiveSource === representationUrl ? undefined : representationUrl,
        etag: representation.etag,
        lastModified: representation.lastModified,
        sourceContentType: representation.mimeType,
        contentType: processed.contentType || representation.mimeType,
        content: processed,
        links: filteredLinks,
        queueItems: llmsTxtQueueItems,
        renderedInBrowser: rawContent.renderedInBrowser || processed.renderedInBrowser,
        impersonated: rawContent.impersonated,
        status: FetchStatus.SUCCESS,
      };
    } catch (error) {
      // Log fetch errors or pipeline execution errors (if run throws)
      logger.error(`❌ Failed processing page ${url}: ${error}`);
      throw error;
    }
  }

  /**
   * Collects, and reports what the refusing-host ladder did, also when the run
   * fails: a run that failed because every way in was refused should still
   * name the host and the reason.
   */
  async scrape(
    options: ScraperOptions,
    progressCallback: ProgressCallback<ScraperProgressEvent>,
    signal?: AbortSignal,
    frontier?: CrawlFrontier,
  ): Promise<CollectionStats> {
    const ladder = (): CollectionStats => {
      const report = this.fetcher.ladderReport();
      return {
        ...(Object.keys(report.hostRungs).length > 0
          ? { hostRungs: report.hostRungs }
          : {}),
        ...(report.refusedHosts.length > 0 ? { refusedHosts: report.refusedHosts } : {}),
      };
    };
    try {
      return {
        ...(await this.collect(options, progressCallback, signal, frontier)),
        ...ladder(),
      };
    } catch (error) {
      if (error instanceof Error) {
        Object.assign(error, { collectionStats: ladder() });
      }
      throw error;
    }
  }

  private async collect(
    options: ScraperOptions,
    progressCallback: ProgressCallback<ScraperProgressEvent>,
    signal?: AbortSignal,
    frontier?: CrawlFrontier,
  ): Promise<CollectionStats> {
    this.pendingLlmsTxtProbe = null;
    this.witnessSeeds = [];
    this.linkWitness.clear();
    // A resumed run admitted every witness's pages the first time round.
    if (options.resume) {
      return super.scrape(options, progressCallback, signal, frontier);
    }

    this.pendingLlmsTxtProbe = await this.probeLlmsTxt(
      options.url,
      options.url,
      options,
      signal,
    );
    const llmsTxt = this.pendingLlmsTxtProbe
      ? this.createLlmsTxtQueueItems(options, this.pendingLlmsTxtProbe).map(
          (item) => item.url,
        )
      : null;
    const sitemap = await this.readSitemapWitness(options, signal);
    this.witnessSeeds = (sitemap ?? []).map((url) => ({
      url,
      depth: 1,
      fromWitness: true,
    }));
    this.platformLists = [];

    const stats = await super.scrape(options, progressCallback, signal, frontier);
    const platformLists = this.platformLists;

    // Coverage: how many pages each witness lists, and which were absent.
    const witnesses: Record<string, number> = { links: this.linkWitness.size };
    const absent: string[] = [];
    const listed = new Set<string>();
    for (const [name, urls] of [
      ["sitemap", sitemap],
      ["llms.txt", llmsTxt],
      ...platformLists,
    ] as const) {
      if (urls === null) {
        absent.push(name);
        continue;
      }
      witnesses[name] = (witnesses[name] ?? 0) + urls.length;
      for (const url of urls) listed.add(this.pageIdentity(url, options));
    }
    return {
      ...stats,
      witnesses,
      absentWitnesses: absent,
      ...(listed.size > 0 ? { listed: listed.size, listedUrls: [...listed] } : {}),
    };
  }

  private async processRootArchive(
    item: QueueItem,
    options: ScraperOptions,
    signal?: AbortSignal,
  ): Promise<ProcessItemResult> {
    logger.info(`📦 Downloading root archive: ${item.url}`);

    // We need to stream the download to a temp file
    // Since fetcher.fetch returns a buffer (usually), we might want to bypass it or use it if small enough?
    // But archives can be huge. fetcher.fetch currently loads into memory.
    // For now, let's assume we can use fetcher but warn about memory, OR implement stream download here.
    // Our fetcher abstraction returns RawContent with Buffer.
    // If we want to stream, we might need to access the underlying axios/fetch stream.
    // `AutoDetectFetcher` doesn't expose stream easily.
    // Ideally we refactor fetcher to support streams, but that's out of scope.
    // So we will use fetcher and write buffer to temp file.
    // LIMITATION: Large archives will hit memory limits.

    const rawContent = await this.fetcher.fetch(item.url, {
      signal,
      headers: options.headers,
    });

    if (rawContent.status !== FetchStatus.SUCCESS) {
      return { url: rawContent.source, links: [], status: rawContent.status };
    }

    const buffer = Buffer.isBuffer(rawContent.content)
      ? rawContent.content
      : Buffer.from(rawContent.content);

    const tempDir = os.tmpdir();
    const tempFile = path.join(
      tempDir,
      `scraper-${Date.now()}-${path.basename(new URL(item.url).pathname)}`,
    );

    // Track file immediately so we can clean it up if write fails or later
    this.tempFiles.push(tempFile);

    await fsPromises.writeFile(tempFile, buffer);

    // Delegate to LocalFileStrategy
    const localUrl = `file://${tempFile}`;
    const localItem = { ...item, url: localUrl };
    const localOptions = {
      ...options,
      internalAllowedFileRoots: [...(options.internalAllowedFileRoots ?? []), tempFile],
    };

    const result = await this.localFileStrategy.processItem(
      localItem,
      localOptions,
      signal,
    );

    // We need to fix up the links to point back to something meaningful?
    // If we process a zip, we get file:///tmp/.../file.txt
    // These links are only useful if we continue to treat them as local files for this session.
    // But `WebScraper` expects http links usually?
    // Actually, if we return file:// links, the queue might try to fetch them.
    // `WebScraperStrategy` handles http/https. `LocalFileStrategy` handles file://.
    // If we return file:// links, the scraper will need to route them to `LocalFileStrategy`.
    // The `ScraperService` uses `ScraperRegistry` to pick strategy.
    // So file:// links will work!

    return {
      ...result,
      url: item.url, // Keep original URL as the source of this item
      links: result.links,
      internalAllowedFileRoots: [tempFile],
      // links are file://...
    };
  }

  /**
   * Cleanup resources used by this strategy, specifically the pipeline browser instances and fetcher.
   */
  async cleanup(): Promise<void> {
    await Promise.allSettled([
      ...this.pipelines.map((pipeline) => pipeline.close()),
      this.localFileStrategy.cleanup(),
      this.fetcher.close(),
      ...this.tempFiles.map((file) => fsPromises.unlink(file).catch(() => {})),
    ]);
  }
}
