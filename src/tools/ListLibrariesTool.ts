import type { IDocumentManagement } from "../store/trpc/interfaces";
import type {
  CollectionStats,
  RunResult,
  VersionStatus,
  VersionSummary,
} from "../store/types";

export interface LibraryInfo {
  name: string;
  versions: Array<{
    id: number;
    version: string;
    documentCount: number;
    uniqueUrlCount: number;
    indexedAt: string | null;
    status: VersionStatus;
    progress?: { pages: number; maxPages: number };
    sourceUrl?: string | null;
    preserveHashes?: boolean;
    entryPoints: string[];
    pagesCollected: number;
    pagesEmbedded: number | null;
    lastCollection: RunResult | null;
    lastRefresh: RunResult | null;
    collectionStats: CollectionStats | null;
    smallCollection: boolean;
  }>;
}

export interface ListLibrariesResult {
  libraries: LibraryInfo[];
}

type VersionInfo = LibraryInfo["versions"][number];

const day = (iso: string) => iso.slice(0, 10);

const describeRun = (label: string, run: RunResult) =>
  `last ${label} ${day(run.at)} ${run.status}${run.error ? ` (${run.error})` : ""}`;

/**
 * Renders one version's status as a single line a harness can read at a glance:
 * coverage, where it is collected from, how its last runs ended and anything
 * that needs attention.
 *
 * @param library Library name.
 * @param v The version to describe.
 * @returns The line, without a leading bullet.
 */
export function formatVersionStatus(library: string, v: VersionInfo): string {
  const name = v.version ? `${library}@${v.version}` : library;
  const parts: string[] = [];
  const stats = v.collectionStats;
  const coverage =
    stats?.listed !== undefined
      ? `${v.pagesCollected} pages collected, ${stats.listedCollected ?? 0} of ${stats.listed} listed`
      : `${v.pagesCollected} pages collected`;
  parts.push(
    v.pagesEmbedded === null
      ? `${coverage} (keyword search only)`
      : `${coverage}, ${v.pagesEmbedded} of ${v.pagesCollected} embedded`,
  );
  if (stats?.witnesses && Object.keys(stats.witnesses).length > 0) {
    parts.push(
      `witnesses ${Object.entries(stats.witnesses)
        .map(([witness, count]) => `${witness} ${count}`)
        .join(", ")}`,
    );
  }
  if (stats?.absentWitnesses && stats.absentWitnesses.length > 0) {
    parts.push(`no ${stats.absentWitnesses.join(", ")}`);
  }
  if (v.entryPoints.length > 0) parts.push(`from ${v.entryPoints.join(", ")}`);
  if (v.status !== "completed") {
    parts.push(
      v.progress && v.progress.maxPages > 0
        ? `${v.status} ${v.progress.pages}/${v.progress.maxPages}`
        : v.status,
    );
  }
  if (v.lastCollection) parts.push(describeRun("collection", v.lastCollection));
  if (v.lastRefresh) parts.push(describeRun("refresh", v.lastRefresh));
  if (stats?.refusedHosts && stats.refusedHosts.length > 0) {
    parts.push(
      `refused by ${stats.refusedHosts.map((h) => `${h.host} (${h.reason})`).join(", ")}`,
    );
  }
  if (stats?.hostRungs && Object.keys(stats.hostRungs).length > 0) {
    parts.push(
      `reached ${Object.entries(stats.hostRungs)
        .map(([host, rung]) => `${host} via ${rung}`)
        .join(", ")}`,
    );
  }
  if (stats?.browserPages)
    parts.push(`${stats.browserPages} pages rendered in a browser`);
  if (stats?.impersonatedPages) {
    parts.push(`${stats.impersonatedPages} pages fetched with browser impersonation`);
  }
  if (v.smallCollection) {
    parts.push("⚠ suspiciously small collection: check the entry point");
  }
  return `${name}: ${parts.join("; ")}`;
}

/**
 * One line to append to search results when the searched version needs the
 * harness's attention: a failed last refresh or incomplete embedding.
 *
 * @param library Library name.
 * @param v The version that was searched.
 * @returns The note, or undefined when there is nothing to say.
 */
export function formatHealthNote(library: string, v: VersionInfo): string | undefined {
  const issues: string[] = [];
  const lastRun = [v.lastCollection, v.lastRefresh]
    .filter((run): run is RunResult => run !== null)
    .sort((a, b) => b.at.localeCompare(a.at))[0];
  if (lastRun && lastRun.status === "failed") {
    const label = lastRun === v.lastRefresh ? "refresh" : "collection";
    issues.push(
      `last ${label} failed on ${day(lastRun.at)}${lastRun.error ? ` (${lastRun.error})` : ""}`,
    );
  }
  if (v.pagesEmbedded !== null && v.pagesEmbedded < v.pagesCollected) {
    issues.push(
      `only ${v.pagesEmbedded} of ${v.pagesCollected} pages embedded so far, so ranking is partly keyword-only`,
    );
  }
  if (v.collectionStats?.refusedHosts && v.collectionStats.refusedHosts.length > 0) {
    issues.push(
      `not collected from ${v.collectionStats.refusedHosts.map((h) => h.host).join(", ")}`,
    );
  }
  const { listed, listedCollected = 0 } = v.collectionStats ?? {};
  // ponytail: 90% tolerates dead sitemap entries; a per-URL gap list if it hides real gaps.
  if (listed !== undefined && listedCollected < listed * 0.9) {
    issues.push(`only ${listedCollected} of ${listed} listed pages collected`);
  }
  if (v.smallCollection) issues.push("suspiciously few pages collected");
  if (issues.length === 0) return undefined;
  const name = v.version ? `${library}@${v.version}` : library;
  return `Note: ${name}: ${issues.join("; ")}.`;
}

/**
 * Tool for listing all available libraries and their indexed versions in the store.
 */
export class ListLibrariesTool {
  private docService: IDocumentManagement;

  constructor(docService: IDocumentManagement) {
    this.docService = docService;
  }

  async execute(_options?: Record<string, never>): Promise<ListLibrariesResult> {
    const rawLibraries = await this.docService.listLibraries();

    const libraries: LibraryInfo[] = rawLibraries.map(({ library, versions }) => ({
      name: library,
      versions: versions.map((v: VersionSummary) => ({
        id: v.id,
        version: v.ref.version,
        documentCount: v.counts.documents,
        uniqueUrlCount: v.counts.uniqueUrls,
        indexedAt: v.indexedAt,
        status: v.status,
        ...(v.progress ? { progress: v.progress } : undefined),
        sourceUrl: v.sourceUrl,
        preserveHashes: v.preserveHashes,
        entryPoints: v.entryPoints,
        pagesCollected: v.pagesCollected,
        pagesEmbedded: v.pagesEmbedded,
        lastCollection: v.lastCollection,
        lastRefresh: v.lastRefresh,
        collectionStats: v.collectionStats,
        smallCollection: v.smallCollection,
      })),
    }));

    return { libraries };
  }
}
