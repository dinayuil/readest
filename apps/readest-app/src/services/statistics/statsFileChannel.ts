import { v4 as uuidv4 } from 'uuid';
import { ancestorsOf } from '@/services/sync/file/layout';
import {
  FileSyncError,
  type FileEntry,
  type FileSyncProvider,
} from '@/services/sync/file/provider';
import type { PageStatEvent, StatBook } from '@/types/statistics';
import type { StatisticsDb } from './statisticsDb';
import {
  isSafeStatsPathSegment,
  isStatsFileChunkName,
  statsFileChunkPath,
  statsFileRootPath,
  statsFileWriterPath,
} from './statsFileLayout';
import {
  decodeStatsFileChunk,
  encodeStatsFileChunk,
  StatsFileChunkTooLargeError,
  StatsFileFormatError,
  type StatsFileBook,
  type StatsFileChunk,
  type StatsFileEvent,
} from './statsFileWire';

export interface StatsFileChannelDeps {
  stats: StatisticsDb;
  provider: FileSyncProvider;
  targetId: string;
  writerId: string;
  now?: () => number;
  newChunkId?: () => string;
  /** Live run guard; false aborts before the next remote read/apply/PUT. */
  shouldContinue?: () => boolean;
}

export interface StatsFileChannelResult {
  chunks: number;
  books: number;
  events: number;
  failedChunks?: number;
}

/** Raised when the caller's live eligibility guard turns false mid-run. */
export class StatsFileSyncInterruptedError extends Error {
  constructor() {
    super('statistics file sync interrupted');
    this.name = 'StatsFileSyncInterruptedError';
  }
}

/** Events (or metadata-only books) per immutable chunk. */
const PUSH_BATCH_SIZE = 5000;
const JSON_CONTENT_TYPE = 'application/json';
const CHUNK_SUFFIX_LENGTH = '.json'.length;

const assertContinue = (deps: StatsFileChannelDeps): void => {
  if (deps.shouldContinue && !deps.shouldContinue()) {
    throw new StatsFileSyncInterruptedError();
  }
};

const toStatBook = (book: StatsFileBook): StatBook => ({
  bookMd5: book.book_hash,
  title: book.title,
  authors: book.authors,
});

const toPageStatEvent = (event: StatsFileEvent): PageStatEvent => ({
  bookMd5: event.book_hash,
  page: event.page,
  startTime: event.start_time,
  duration: event.duration,
  totalPages: event.total_pages,
});

const isNotFound = (error: unknown): boolean =>
  error instanceof FileSyncError && error.code === 'NOT_FOUND';

/**
 * Pull immutable statistics chunks from every writer folder under
 * `<base>/stats/v1`.
 *
 * The root (or a writer folder) disappearing is treated as "nothing to pull";
 * auth and network failures propagate so the caller can report the sync as
 * failed instead of silently marking it complete. A listed chunk that reads as
 * null or decodes as malformed/unsupported stays unseen: a later run retries
 * it, and it is never applied partially.
 *
 * Chunks are streamed one at a time (read, decode, apply) instead of buffering
 * the whole unseen history. Event merges are order-independent; metadata is
 * protected by each book's per-field (written_at, chunk_path) clock, so a late
 * older chunk cannot overwrite a newer title/authors.
 */
export async function pullStatsFileChunks(
  deps: StatsFileChannelDeps,
): Promise<StatsFileChannelResult> {
  const { stats, provider, targetId } = deps;
  const rootPath = statsFileRootPath(provider.rootPath);

  assertContinue(deps);
  let writers: FileEntry[];
  try {
    writers = await provider.list(rootPath);
  } catch (error) {
    if (isNotFound(error)) return { chunks: 0, books: 0, events: 0 };
    throw error;
  }

  const seen = await stats.getSeenStatsFileChunkPaths(targetId);
  let failedChunks = 0;
  let chunks = 0;
  let books = 0;
  let events = 0;

  for (const writerEntry of writers) {
    if (!writerEntry.isDirectory) continue;
    if (!isSafeStatsPathSegment(writerEntry.name)) continue;
    const writerPath = statsFileWriterPath(provider.rootPath, writerEntry.name);
    // Never trust a backend-provided path outside the hierarchy we asked for.
    if (writerEntry.path !== writerPath) continue;

    assertContinue(deps);
    let entries: FileEntry[];
    try {
      entries = await provider.list(writerPath);
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }

    for (const entry of entries) {
      if (entry.isDirectory) continue;
      if (!isStatsFileChunkName(entry.name)) continue;
      const chunkId = entry.name.slice(0, -CHUNK_SUFFIX_LENGTH);
      const chunkPath = statsFileChunkPath(provider.rootPath, writerEntry.name, chunkId);
      if (entry.path !== chunkPath) continue;
      if (seen.has(chunkPath)) continue;

      assertContinue(deps);
      let text: string | null;
      try {
        text = await provider.readText(chunkPath);
      } catch (error) {
        if (isNotFound(error)) continue;
        throw error;
      }
      // A listed but absent file is a race, not a chunk to acknowledge.
      if (text === null) continue;

      let chunk: StatsFileChunk;
      try {
        chunk = decodeStatsFileChunk(text);
      } catch (error) {
        if (!(error instanceof StatsFileFormatError)) throw error;
        // Malformed/unsupported: leave unseen so a corrected file can retry.
        failedChunks += 1;
        continue;
      }

      assertContinue(deps);
      await stats.applyStatsFileChunk(
        targetId,
        chunkPath,
        chunk.books.map(toStatBook),
        chunk.events.map(toPageStatEvent),
        chunk.written_at,
      );
      chunks += 1;
      books += chunk.books.length;
      events += chunk.events.length;
    }
  }

  const result: StatsFileChannelResult = { chunks, books, events };
  if (failedChunks > 0) result.failedChunks = failedChunks;
  return result;
}

/**
 * Push pending local snapshots as immutable chunks.
 *
 * Every chunk gets a fresh id and is never rewritten or deleted, so two
 * devices (even ones sharing a cloned writer id) cannot overwrite each other.
 * The encoded payload is validated before any remote or ack side effect: an
 * own path is pre-marked seen, then ancestors are ensured, then the PUT runs,
 * and only a completed PUT is acknowledged. Oversized payloads reduce the next
 * batch and retry, so valid large history still progresses; one record larger
 * than the wire limit is an explicit error. Any failure stops the loop without
 * advancing snapshots, making the batch retryable. An empty backlog performs no
 * directory creation or writes.
 */
export async function pushStatsFileChunks(
  deps: StatsFileChannelDeps,
): Promise<StatsFileChannelResult> {
  const { stats, provider, targetId, writerId } = deps;
  const now = deps.now ?? (() => Date.now());
  const newChunkId = deps.newChunkId ?? (() => uuidv4());

  let batchSize = PUSH_BATCH_SIZE;
  let chunks = 0;
  let books = 0;
  let events = 0;

  for (;;) {
    assertContinue(deps);
    const batch = await stats.getStatsFilePushBatch(targetId, batchSize);
    if (batch.books.length === 0 && batch.events.length === 0) break;

    const writtenAt = now();
    const chunk: StatsFileChunk = {
      v: 1,
      written_at: writtenAt,
      books: batch.books.map((book) => ({
        book_hash: book.bookMd5,
        title: book.title,
        authors: book.authors,
      })),
      events: batch.events.map((event) => ({
        book_hash: event.bookMd5,
        page: event.page,
        start_time: event.startTime,
        duration: event.duration,
        total_pages: event.totalPages,
      })),
    };

    let body: string;
    try {
      body = encodeStatsFileChunk(chunk);
    } catch (error) {
      // A batch that is valid but too large must shrink until it fits; a single
      // record over the wire limit cannot be made smaller and is explicit.
      if (error instanceof StatsFileChunkTooLargeError) {
        const itemCount = Math.max(batch.events.length, batch.books.length);
        const nextSize = Math.max(1, Math.floor(itemCount / 2));
        if (batchSize <= nextSize) throw error;
        batchSize = nextSize;
        continue;
      }
      throw error;
    }

    assertContinue(deps);
    const chunkPath = statsFileChunkPath(provider.rootPath, writerId, newChunkId());
    await stats.beginStatsFilePush(targetId, chunkPath);
    assertContinue(deps);
    await provider.ensureDir(ancestorsOf(chunkPath));
    assertContinue(deps);
    await provider.writeText(chunkPath, body, JSON_CONTENT_TYPE);
    await stats.ackStatsFilePush(targetId, chunkPath, batch.books, batch.events, writtenAt);

    chunks += 1;
    books += batch.books.length;
    events += batch.events.length;
  }

  return { chunks, books, events };
}
