/**
 * On-remote wire format for one immutable statistics chunk.
 *
 * Only book identity metadata and page events leave the device — no
 * credentials, account ids, or database rows beyond what statistics displays.
 * The decoder is deliberately strict so a truncated or foreign file is left
 * unseen and retried instead of poisoning the local statistics database.
 */
export interface StatsFileBook {
  book_hash: string;
  title: string;
  authors: string;
}

export interface StatsFileEvent {
  book_hash: string;
  page: number;
  start_time: number;
  duration: number;
  total_pages: number;
}

export interface StatsFileChunk {
  v: 1;
  written_at: number;
  books: StatsFileBook[];
  events: StatsFileEvent[];
}

/** Pre-parse bound; a chunk should never approach this in normal operation. */
export const STATS_FILE_MAX_CHARS = 8 * 1024 * 1024;

/** Thrown when a remote chunk is malformed or from an unsupported version. */
export class StatsFileFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatsFileFormatError';
  }
}

/** A valid-shaped chunk that exceeds the pre-parse size bound. */
export class StatsFileChunkTooLargeError extends StatsFileFormatError {
  constructor() {
    super('chunk exceeds the maximum size');
    this.name = 'StatsFileChunkTooLargeError';
  }
}

const fail = (message: string): never => {
  throw new StatsFileFormatError(message);
};

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== 'string') return fail(`${field} must be a string`);
  return value;
};

const requireInteger = (value: unknown, field: string): number => {
  if (!isNonNegativeInteger(value)) {
    return fail(`${field} must be a finite non-negative integer`);
  }
  return value;
};

export const encodeStatsFileChunk = (chunk: StatsFileChunk): string => {
  const body = JSON.stringify(chunk);
  // Run the same strict decoder used on receive: a chunk we could not accept
  // ourselves must never be PUT (or acknowledged) by this device. This also
  // enforces the pre-parse byte bound before any upload.
  decodeStatsFileChunk(body);
  return body;
};

export const decodeStatsFileChunk = (text: string): StatsFileChunk => {
  if (typeof text !== 'string') return fail('chunk is not text');
  // Bound the allocation before JSON.parse and before walking arrays.
  if (text.length > STATS_FILE_MAX_CHARS) throw new StatsFileChunkTooLargeError();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail('chunk is not valid JSON');
  }
  if (!isObject(parsed)) return fail('chunk must be a JSON object');
  if (parsed['v'] !== 1) return fail('unsupported chunk version');
  const writtenAt = requireInteger(parsed['written_at'], 'written_at');

  const rawBooks = parsed['books'];
  if (!Array.isArray(rawBooks)) return fail('books must be an array');
  const books: StatsFileBook[] = [];
  for (const raw of rawBooks) {
    if (!isObject(raw)) return fail('book entry must be an object');
    const bookHash = requireString(raw['book_hash'], 'book_hash');
    if (bookHash.trim().length === 0) return fail('book_hash must not be empty');
    books.push({
      book_hash: bookHash,
      title: requireString(raw['title'], 'title'),
      authors: requireString(raw['authors'], 'authors'),
    });
  }

  const rawEvents = parsed['events'];
  if (!Array.isArray(rawEvents)) return fail('events must be an array');
  const events: StatsFileEvent[] = [];
  for (const raw of rawEvents) {
    if (!isObject(raw)) return fail('event entry must be an object');
    const bookHash = requireString(raw['book_hash'], 'book_hash');
    if (bookHash.trim().length === 0) return fail('book_hash must not be empty');
    events.push({
      book_hash: bookHash,
      page: requireInteger(raw['page'], 'page'),
      start_time: requireInteger(raw['start_time'], 'start_time'),
      duration: requireInteger(raw['duration'], 'duration'),
      total_pages: requireInteger(raw['total_pages'], 'total_pages'),
    });
  }

  return { v: 1, written_at: writtenAt, books, events };
};
