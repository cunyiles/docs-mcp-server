import { docc } from "./docc";
import { dokka } from "./dokka";
import { javadoc } from "./javadoc";
import { mkdocs } from "./mkdocs";
import { sphinx } from "./sphinx";
import type { DetectedPlatform, FetchText, PlatformAdapter } from "./types";

export type { DetectedPlatform, FetchText, PlatformAdapter } from "./types";

/** Every known documentation generator. A new one is added here. */
export const PLATFORM_ADAPTERS: PlatformAdapter[] = [
  mkdocs,
  sphinx,
  docc,
  dokka,
  javadoc,
];

/**
 * Asks each adapter whether an entry point's site is built with its generator.
 *
 * @returns The first adapter's findings, or null when no adapter recognises the site.
 */
export async function detectPlatform(
  pageUrl: string,
  html: string,
  fetchText: FetchText,
): Promise<DetectedPlatform | null> {
  for (const adapter of PLATFORM_ADAPTERS) {
    const found = await adapter.detect(pageUrl, html, fetchText);
    if (found) return found;
  }
  return null;
}
