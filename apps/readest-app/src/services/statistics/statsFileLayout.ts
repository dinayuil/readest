import { buildBasePath, normalizeRoot } from '@/services/sync/file/layout';

/**
 * Immutable statistics chunk layout, additive to the frozen file-sync tree:
 *
 *   <rootPath>/Readest/stats/v1/<writerId>/<chunkId>.json
 *
 * Chunks are write-once; a retry uses a new chunk id, and no chunk is ever
 * deleted or rewritten. Each device writes under its own writer id, but the
 * pull side never skips a matching id: a backup can clone `deviceId`, and
 * those chunks still hold history this database has not seen.
 */
const STATS_DIR = 'stats';
const STATS_VERSION_DIR = 'v1';
const CHUNK_SUFFIX = '.json';

/**
 * A writer id or chunk id must be exactly one path segment. Rejecting
 * separators, traversal, NUL, and control characters keeps a compromised or
 * malformed setting from addressing files outside the stats subtree.
 */
export const isSafeStatsPathSegment = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value === '.' || value === '..') return false;
  if (value.includes('/') || value.includes('\\')) return false;
  return !/[\u0000-\u001f\u007f]/.test(value);
};

const assertSafeSegment = (label: string, value: string): void => {
  if (!isSafeStatsPathSegment(value)) {
    throw new Error(`Invalid ${label} for statistics file sync: ${JSON.stringify(value)}`);
  }
};

const join = (...parts: string[]): string => {
  const cleaned = parts
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .filter((part) => part.length > 0);
  return `/${cleaned.join('/')}`;
};

/** Absolute path of the statistics file-sync root for a provider root path. */
export const statsFileRootPath = (rootPath: string): string =>
  join(buildBasePath(normalizeRoot(rootPath)), STATS_DIR, STATS_VERSION_DIR);

/** Absolute path of one writer's immutable chunk directory. */
export const statsFileWriterPath = (rootPath: string, writerId: string): string => {
  assertSafeSegment('writer id', writerId);
  return join(statsFileRootPath(rootPath), writerId);
};

/** Absolute path of one immutable chunk file. */
export const statsFileChunkPath = (rootPath: string, writerId: string, chunkId: string): string => {
  assertSafeSegment('chunk id', chunkId);
  return join(statsFileWriterPath(rootPath, writerId), `${chunkId}${CHUNK_SUFFIX}`);
};

/** True when a listed name is a chunk file name (`<safe-id>.json`). */
export const isStatsFileChunkName = (name: string): boolean =>
  name.endsWith(CHUNK_SUFFIX) && isSafeStatsPathSegment(name.slice(0, -CHUNK_SUFFIX.length));
