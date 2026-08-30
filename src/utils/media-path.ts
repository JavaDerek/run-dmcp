import { isAbsolute, join, resolve, sep } from "path";
import { createLogger } from "./logger.js";

const log = createLogger("media-path");

/**
 * The one place a path beneath a media root is composed or resolved.
 *
 * Media file paths are built from ids that arrive over the wire -- a game id,
 * an entity id, an entity type -- and are then handed to `writeFileSync` and,
 * worse, to a recursive `rmSync`. `join()` resolves `..` happily, so an id
 * carrying one walks out of the data directory before the write. The rule this
 * breaks is the engine's: it writes nothing to the consumer's machine that the
 * consumer did not name.
 *
 * The guard is here, at the composition point, rather than at each call site,
 * because a per-site check is one forgotten site away from being no check. Two
 * things are asserted, and both are literal checks over characters -- never an
 * attempt to read meaning out of a value (root CLAUDE.md hard rule 4):
 *
 *   1. Every path segment matches an allowlist. Every id the engine mints is a
 *      UUID and every entity type is an ASCII word, so the allowlist costs
 *      nothing the engine actually uses.
 *   2. The resolved result is strictly beneath the resolved root -- a
 *      structural backstop that holds even for a path this module did not
 *      compose, such as one read back out of a row written before this guard
 *      existed.
 *
 * Rejection, never normalisation: an id containing `a/../b` is refused rather
 * than quietly rewritten to `b`, because the rewrite would silently store one
 * caller's media under a different id than the caller named.
 */
export class MediaPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaPathError";
  }
}

/** Directory names: ids the engine mints, plus pluralised entity types. */
const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

/** Leaf file names: a safe stem, one dot, an alphanumeric extension. */
const SAFE_FILENAME = /^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/;

function reject(what: string, value: string): never {
  log.warn("Refused a media path built from an unsafe value", { what, value });
  throw new MediaPathError(
    `Unsafe ${what} for a media path: ${JSON.stringify(value)}. ` +
      `Only letters, digits, underscore and hyphen are allowed; a path separator, ` +
      `"." or ".." would escape the media directory.`
  );
}

function assertSafeSegment(value: string): void {
  if (typeof value !== "string" || !SAFE_SEGMENT.test(value)) {
    reject("path segment", String(value));
  }
}

/**
 * Resolve a relative path against a media root, refusing anything that is not
 * strictly beneath it. Use for paths read back from a row; `mediaFilePath` and
 * `mediaDirPath` funnel through it too, so every media path in the codebase
 * passes this check exactly once.
 */
export function mediaPathWithin(root: string, relativePath: string): string {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    reject("stored path", String(relativePath));
  }
  if (isAbsolute(relativePath)) {
    reject("stored path", relativePath);
  }
  // Split on both separators regardless of platform: a stored path composed on
  // one and read on another must not sneak a traversal past the check.
  for (const segment of relativePath.split(/[\\/]/)) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      reject("stored path", relativePath);
    }
  }

  const rootResolved = resolve(root);
  const fullPath = resolve(rootResolved, relativePath);
  // Compare with the separator appended, so a sibling directory whose name
  // merely starts with the root's (`<root>-elsewhere`) is not mistaken for a
  // child of it.
  if (!fullPath.startsWith(rootResolved + sep)) {
    reject("stored path", relativePath);
  }
  return fullPath;
}

/**
 * Compose the path of a media file from segments and a leaf file name,
 * returning both the relative path to store in the row and the full path to
 * write to.
 */
export function mediaFilePath(
  root: string,
  segments: string[],
  filename: string
): { relativePath: string; fullPath: string } {
  segments.forEach(assertSafeSegment);
  if (typeof filename !== "string" || !SAFE_FILENAME.test(filename)) {
    reject("file name", String(filename));
  }

  const relativePath = join(...segments, filename);
  return { relativePath, fullPath: mediaPathWithin(root, relativePath) };
}

/**
 * Compose the path of a directory beneath a media root. The caller of this one
 * is a recursive delete, so an empty segment list -- which would resolve to the
 * media root itself -- is refused along with everything else.
 */
export function mediaDirPath(root: string, segments: string[]): string {
  if (segments.length === 0) {
    reject("path segment", "");
  }
  segments.forEach(assertSafeSegment);
  return mediaPathWithin(root, join(...segments));
}
