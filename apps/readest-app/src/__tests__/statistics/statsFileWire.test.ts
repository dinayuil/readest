import { describe, expect, test } from 'vitest';
import {
  decodeStatsFileChunk,
  encodeStatsFileChunk,
  STATS_FILE_MAX_CHARS,
  StatsFileChunkTooLargeError,
  StatsFileFormatError,
  type StatsFileChunk,
} from '@/services/statistics/statsFileWire';

const validChunk = (): StatsFileChunk => ({
  v: 1,
  written_at: 1_700_000_000,
  books: [{ book_hash: 'b1', title: 'Title', authors: 'Author' }],
  events: [{ book_hash: 'b1', page: 1, start_time: 0, duration: 12, total_pages: 100 }],
});

describe('stats file wire format', () => {
  test('round-trips a chunk', () => {
    const chunk = validChunk();
    expect(decodeStatsFileChunk(encodeStatsFileChunk(chunk))).toEqual(chunk);
  });

  test('encode validates the payload before it can be uploaded', () => {
    const invalid = validChunk();
    (invalid.events[0] as unknown as Record<string, unknown>)['duration'] = -1;
    expect(() => encodeStatsFileChunk(invalid)).toThrow(StatsFileFormatError);

    const oversized = validChunk();
    oversized.books[0]!.title = 'x'.repeat(STATS_FILE_MAX_CHARS + 1);
    expect(() => encodeStatsFileChunk(oversized)).toThrow(StatsFileFormatError);
  });

  test('accepts long hashes without imposing a length limit', () => {
    const hash = 'h'.repeat(512);
    const chunk = validChunk();
    chunk.books[0]!.book_hash = hash;
    chunk.events[0]!.book_hash = hash;
    expect(decodeStatsFileChunk(encodeStatsFileChunk(chunk)).books[0]!.book_hash).toBe(hash);
  });

  test('rejects malformed JSON and unsupported versions', () => {
    expect(() => decodeStatsFileChunk('{not json')).toThrow(StatsFileFormatError);
    expect(() => decodeStatsFileChunk(JSON.stringify({ ...validChunk(), v: 2 }))).toThrow(
      StatsFileFormatError,
    );
    expect(() => decodeStatsFileChunk(JSON.stringify(validChunk().events))).toThrow(
      StatsFileFormatError,
    );
  });

  test('rejects non-array or missing payload sections', () => {
    expect(() => decodeStatsFileChunk(JSON.stringify({ ...validChunk(), books: {} }))).toThrow(
      StatsFileFormatError,
    );
    expect(() =>
      decodeStatsFileChunk(JSON.stringify({ ...validChunk(), events: undefined })),
    ).toThrow(StatsFileFormatError);
  });

  test('rejects empty book hashes', () => {
    const chunk = validChunk();
    chunk.books[0]!.book_hash = '';
    expect(() => decodeStatsFileChunk(JSON.stringify(chunk))).toThrow(StatsFileFormatError);
    chunk.books[0]!.book_hash = '   ';
    expect(() => decodeStatsFileChunk(JSON.stringify(chunk))).toThrow(StatsFileFormatError);
  });

  test('rejects non-integer, negative, or non-finite event values', () => {
    for (const [field, value] of [
      ['page', -1],
      ['page', 1.5],
      ['start_time', -1],
      ['duration', 1.5],
      ['total_pages', -3],
      ['total_pages', '12'],
      ['duration', null],
    ] as const) {
      const chunk = validChunk();
      (chunk.events[0] as unknown as Record<string, unknown>)[field] = value;
      expect(() => decodeStatsFileChunk(JSON.stringify(chunk))).toThrow(StatsFileFormatError);
    }
  });

  test('rejects non-string book metadata', () => {
    const chunk = validChunk();
    (chunk.books[0] as unknown as Record<string, unknown>)['title'] = 7;
    expect(() => decodeStatsFileChunk(JSON.stringify(chunk))).toThrow(StatsFileFormatError);
  });

  test('rejects huge payloads before JSON.parse', () => {
    expect(() => decodeStatsFileChunk('x'.repeat(STATS_FILE_MAX_CHARS + 1))).toThrow(
      StatsFileChunkTooLargeError,
    );
  });

  test('ignores unknown extra fields in the payload', () => {
    const chunk = validChunk() as StatsFileChunk & { extra?: string };
    chunk.extra = 'ignored';
    expect(decodeStatsFileChunk(JSON.stringify(chunk))).toEqual(validChunk());
  });
});
