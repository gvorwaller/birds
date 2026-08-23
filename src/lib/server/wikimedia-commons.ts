/**
 * Wikimedia Commons imageinfo gateway for field-guide sample media
 * (td-86a2b6). Turns P18/P51 Commons filenames (from wikidata.ts) into
 * usable metadata: URLs, dimensions, MIME type, license, artist. All Commons
 * media is CC-licensed or public domain, but license CODE/URL still vary per
 * file and are required for display attribution.
 * Plan: docs/2026-08-23-field-guide-sample-media-CLAUDE.md §4.
 */
import { enrichmentUserAgent, parseRetryAfterMs } from "$server/wikidata";

export const COMMONS_API_URL = "https://commons.wikimedia.org/w/api.php";
export const COMMONS_BATCH_SIZE = 50;
const REQUEST_TIMEOUT_MS = 30_000;
const THUMB_WIDTH = 640;

export class CommonsError extends Error {
  constructor(
    message: string,
    public status: number,
    /** 429 or explicit throttle — caller schedules a rate-limit retry. */
    public rateLimited: boolean,
    public retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "CommonsError";
  }
}

export interface CommonsFileInfo {
  filename: string;
  /** Full-resolution URL. */
  url: string;
  /** 640px-wide thumbnail URL; null for files smaller than the requested width. */
  thumbUrl: string | null;
  width: number | null;
  height: number | null;
  mimeType: string | null;
  /** Plain text, HTML stripped; null for anonymous Commons uploads. */
  artist: string | null;
  /** e.g. "CC BY-SA 4.0"; required for acceptance by the caller. */
  licenseCode: string | null;
  licenseUrl: string | null;
  /** Seconds, for audio/video files; null for images. */
  duration: number | null;
}

/** Direct link to a file's Commons description page. */
export function commonsSourceUrl(filename: string): string {
  return `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(filename.replace(/ /g, "_"))}`;
}

const PLAYABLE_AUDIO_MIME = new Set([
  "audio/ogg",
  // Commons commonly reports Ogg/Vorbis files as application/ogg (for
  // example File:Common loon yodels.ogg), which HTMLAudioElement supports.
  "application/ogg",
  "audio/mpeg",
  "audio/wav",
  "audio/flac",
  "audio/webm",
]);

export function isPlayableAudio(mime: string | null): boolean {
  return mime != null && PLAYABLE_AUDIO_MIME.has(mime.toLowerCase());
}

const DISPLAYABLE_IMAGE_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

export function isDisplayableImage(mime: string | null): boolean {
  return mime != null && DISPLAYABLE_IMAGE_MIME.has(mime.toLowerCase());
}

/**
 * The Artist extmetadata field is HTML (e.g. `<a href="...">John Doe</a>`,
 * or plain text). Strip tags, decode the handful of entities MediaWiki
 * actually emits here, collapse whitespace, trim. Null in → null out
 * (anonymous Commons uploads are a valid, expected state).
 */
export function parseArtistHtml(html: string | null): string | null {
  if (html == null) return null;
  const stripped = html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length > 0 ? stripped : null;
}

interface ImageInfoEntry {
  url?: string;
  thumburl?: string;
  width?: number;
  height?: number;
  thumbwidth?: number;
  thumbheight?: number;
  mime?: string;
  duration?: number;
  metadata?: Array<{ name?: string; value?: unknown }>;
  extmetadata?: {
    Artist?: { value?: string };
    LicenseShortName?: { value?: string };
    LicenseUrl?: { value?: string };
  };
}

function mediaDuration(info: ImageInfoEntry): number | null {
  if (typeof info.duration === "number" && Number.isFinite(info.duration))
    return info.duration;
  const raw = info.metadata?.find(
    (entry) => entry.name === "playtime_seconds" || entry.name === "length",
  )?.value;
  const parsed =
    typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

interface QueryPage {
  title?: string;
  missing?: boolean;
  imageinfo?: ImageInfoEntry[];
}

interface QueryResponse {
  query?: {
    /** Title-normalization mapping (formatversion=2): from = requested title. */
    normalized?: Array<{ from?: string; to?: string }>;
    pages?: QueryPage[];
  };
  error?: { code?: string; info?: string };
}

/**
 * Resolve up to COMMONS_BATCH_SIZE (50) Commons filenames to imageinfo.
 * Filenames NOT found (deleted/renamed since the Wikidata claim was made) are
 * simply absent from the returned map — not an error.
 */
export async function fetchCommonsFileInfo(
  filenames: readonly string[],
  opts: { signal?: AbortSignal; fetcher?: typeof fetch } = {},
): Promise<Map<string, CommonsFileInfo>> {
  if (filenames.length === 0) return new Map();
  if (filenames.length > COMMONS_BATCH_SIZE) {
    throw new Error(
      `batch too large: ${filenames.length} > ${COMMONS_BATCH_SIZE}`,
    );
  }
  const doFetch = opts.fetcher ?? fetch;
  const signal = opts.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const titles = filenames.map((f) => `File:${f}`).join("|");
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    prop: "imageinfo",
    titles,
    // `duration` is not a valid imageinfo property. Timed-media duration is
    // exposed in imageinfo's metadata array as playtime_seconds/length.
    iiprop: "url|size|mime|metadata|extmetadata",
    iiextmetadatafilter: "Artist|LicenseShortName|LicenseUrl",
    iiurlwidth: String(THUMB_WIDTH),
  });
  let res: Response;
  try {
    res = await doFetch(`${COMMONS_API_URL}?${params.toString()}`, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": enrichmentUserAgent() },
      signal,
    });
  } catch (err) {
    throw new CommonsError(
      `Commons unreachable: ${err instanceof Error ? err.message : "fetch failed"}`,
      0,
      false,
    );
  }
  if (!res.ok) {
    const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
    throw new CommonsError(
      `Commons imageinfo query failed (HTTP ${res.status})`,
      res.status,
      res.status === 429 || (res.status === 503 && retryAfterMs != null),
      retryAfterMs,
    );
  }
  const body = (await res.json()) as QueryResponse;
  if (body.error) {
    const code = body.error.code?.toLowerCase() ?? "";
    const rateLimited = code === "ratelimited" || code === "maxlag";
    throw new CommonsError(
      `Commons imageinfo query failed: ${body.error.code ?? body.error.info ?? "unknown error"}`,
      0,
      rateLimited,
      parseRetryAfterMs(res.headers.get("retry-after")),
    );
  }
  // The API normalizes titles (underscores → spaces, first-letter case, NFC)
  // and reports pages under the NORMALIZED title. Callers look files up by
  // the filename they requested, so key the map by the ORIGINAL title via
  // the response's normalized from→to mapping.
  const denormalize = new Map<string, string>();
  for (const n of body.query?.normalized ?? []) {
    if (n.from && n.to) denormalize.set(n.to, n.from);
  }
  const out = new Map<string, CommonsFileInfo>();
  for (const page of body.query?.pages ?? []) {
    if (page.missing || !page.title) continue;
    const requestedTitle = denormalize.get(page.title) ?? page.title;
    const filename = requestedTitle.replace(/^File:/, "");
    const info = page.imageinfo?.[0];
    if (!info || !info.url) continue;
    const licenseCode = info.extmetadata?.LicenseShortName?.value ?? null;
    out.set(filename, {
      filename,
      url: info.url,
      thumbUrl: info.thumburl ?? null,
      width: info.width ?? null,
      height: info.height ?? null,
      mimeType: info.mime ?? null,
      artist: parseArtistHtml(info.extmetadata?.Artist?.value ?? null),
      licenseCode,
      licenseUrl: info.extmetadata?.LicenseUrl?.value ?? null,
      duration: mediaDuration(info),
    });
  }
  return out;
}
