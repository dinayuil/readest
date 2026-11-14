import { describe, expect, it, vi } from 'vitest';
import { NodeDatabaseService } from '@/services/database/nodeDatabaseService';
import { migrate } from '@/services/database/migrate';
import { getMigrations } from '@/services/database/migrations';
import {
  FileSyncError,
  type FileEntry,
  type FileSyncProvider,
} from '@/services/sync/file/provider';
import { ancestorsOf } from '@/services/sync/file/layout';
import { StatisticsDb } from '@/services/statistics/statisticsDb';
import {
  pullStatsFileChunks,
  pushStatsFileChunks,
  StatsFileSyncInterruptedError,
} from '@/services/statistics/statsFileChannel';
import {
  decodeStatsFileChunk,
  encodeStatsFileChunk,
  STATS_FILE_MAX_CHARS,
  StatsFileChunkTooLargeError,
  type StatsFileChunk,
} from '@/services/statistics/statsFileWire';
import {
  statsFileChunkPath,
  statsFileRootPath,
  statsFileWriterPath,
} from '@/services/statistics/statsFileLayout';

/** In-memory remote with directories, failure injection, and an op log. */
class MemoryProvider implements FileSyncProvider {
  rootPath: string;
  readonly dirs = new Set<string>(['/']);
  readonly files = new Map<string, string>();
  readonly ops: string[] = [];
  readonly listErrors = new Map<string, Error>();
  readonly listOverrides = new Map<string, FileEntry[]>();
  readonly nullReads = new Set<string>();
  readonly readErrors = new Map<string, Error>();
  readonly writeFailures: Error[] = [];

  constructor(rootPath = '/') {
    this.rootPath = rootPath;
  }

  put(path: string, body: string): void {
    this.files.set(path, body);
    for (const dir of ancestorsOf(path)) this.dirs.add(dir);
  }

  private parent(path: string): string {
    const i = path.lastIndexOf('/');
    return i <= 0 ? '/' : path.slice(0, i);
  }

  private childName(dir: string, path: string): string {
    return path.slice(dir === '/' ? 1 : dir.length + 1);
  }

  async readText(path: string): Promise<string | null> {
    this.ops.push(`read:${path}`);
    const error = this.readErrors.get(path);
    if (error) throw error;
    if (this.nullReads.has(path)) return null;
    return this.files.get(path) ?? null;
  }

  async readBinary(): Promise<ArrayBuffer | null> {
    return null;
  }

  async head(): Promise<null> {
    return null;
  }

  async list(path: string): Promise<FileEntry[]> {
    this.ops.push(`list:${path}`);
    const error = this.listErrors.get(path);
    if (error) throw error;
    const override = this.listOverrides.get(path);
    if (override) return override;
    if (!this.dirs.has(path)) {
      throw new FileSyncError(`no such directory: ${path}`, 'NOT_FOUND', 404);
    }
    const out: FileEntry[] = [];
    for (const dir of this.dirs) {
      if (dir === path || this.parent(dir) !== path) continue;
      out.push({ name: this.childName(path, dir), path: dir, isDirectory: true });
    }
    for (const file of this.files.keys()) {
      if (this.parent(file) !== path) continue;
      out.push({ name: this.childName(path, file), path: file, isDirectory: false });
    }
    return out;
  }

  async writeText(path: string, body: string): Promise<void> {
    this.ops.push(`write:${path}`);
    const failure = this.writeFailures.shift();
    if (failure) throw failure;
    this.files.set(path, body);
  }

  async writeBinary(): Promise<void> {}

  async ensureDir(paths: string[]): Promise<void> {
    this.ops.push(`ensureDir:${paths.join(',')}`);
    for (const path of paths) this.dirs.add(path);
  }

  async deleteDir(): Promise<void> {}
}

async function freshStats(): Promise<StatisticsDb> {
  const db = await NodeDatabaseService.open(':memory:');
  await migrate(db, getMigrations('statistics'));
  return StatisticsDb.from(db);
}

interface SeedEvent {
  bookMd5: string;
  page: number;
  startTime: number;
  duration: number;
  totalPages?: number;
  title?: string;
  authors?: string;
}

async function seed(stats: StatisticsDb, events: SeedEvent[]): Promise<void> {
  const books = new Map<string, { title: string; authors: string }>();
  for (const e of events) {
    if (!books.has(e.bookMd5)) {
      books.set(e.bookMd5, { title: e.title ?? `Book ${e.bookMd5}`, authors: e.authors ?? 'A' });
    }
  }
  for (const [bookMd5, meta] of books) {
    await stats.upsertBook({ bookMd5, ...meta });
  }
  for (const e of events) {
    const book = await stats.getBookByMd5(e.bookMd5);
    await stats.insertPageEvent(book!.id, {
      page: e.page,
      startTime: e.startTime,
      duration: e.duration,
      totalPages: e.totalPages ?? 100,
    });
  }
}

function ids(...values: string[]): () => string {
  return () => {
    const next = values.shift();
    if (!next) throw new Error('ran out of chunk ids');
    return next;
  };
}

describe('stats file channel push', () => {
  it('backfills full history into immutable chunks and does not echo on repeat', async () => {
    const remote = new MemoryProvider();
    const a = await freshStats();
    await seed(a, [
      { bookMd5: 'b1', page: 1, startTime: 0, duration: 5 },
      { bookMd5: 'b1', page: 2, startTime: 100, duration: 7 },
      { bookMd5: 'b2', page: 1, startTime: 200, duration: 3 },
    ]);

    const pushed = await pushStatsFileChunks({
      stats: a,
      provider: remote,
      targetId: 'target-a',
      writerId: 'device-a',
      now: () => 1000,
      newChunkId: ids('chunk-1'),
    });
    expect(pushed).toEqual({ chunks: 1, books: 2, events: 3 });

    const path = statsFileChunkPath('/', 'device-a', 'chunk-1');
    const wire = decodeStatsFileChunk(remote.files.get(path)!);
    expect(wire).toMatchObject({ v: 1, written_at: 1000 });
    expect(wire.events).toHaveLength(3);
    expect(wire.events.map((e) => e.start_time).sort((x, y) => x - y)).toEqual([0, 100, 200]);

    const b = await freshStats();
    const pulled = await pullStatsFileChunks({
      stats: b,
      provider: remote,
      targetId: 'target-b',
      writerId: 'device-b',
    });
    expect(pulled).toEqual({ chunks: 1, books: 2, events: 3 });
    expect((await b.getBookByMd5('b1'))!.total_read_time).toBe(12);
    expect((await b.getBookByMd5('b2'))!.total_read_time).toBe(3);

    // Repeat pull: every chunk is acknowledged as seen.
    expect(
      await pullStatsFileChunks({
        stats: b,
        provider: remote,
        targetId: 'target-b',
        writerId: 'device-b',
      }),
    ).toEqual({ chunks: 0, books: 0, events: 0 });

    // Pulled snapshots are acknowledged, so B does not echo them back.
    expect(
      await pushStatsFileChunks({
        stats: b,
        provider: remote,
        targetId: 'target-b',
        writerId: 'device-b',
        now: () => 2000,
        newChunkId: ids('unused'),
      }),
    ).toEqual({ chunks: 0, books: 0, events: 0 });

    // The writer's own chunk is marked seen by the push ack.
    expect(
      await pullStatsFileChunks({
        stats: a,
        provider: remote,
        targetId: 'target-a',
        writerId: 'device-a',
      }),
    ).toEqual({ chunks: 0, books: 0, events: 0 });
  });

  it('pushes duration growth and imported older timestamps', async () => {
    const remote = new MemoryProvider();
    const a = await freshStats();
    await seed(a, [{ bookMd5: 'b1', page: 1, startTime: 200, duration: 10 }]);
    await pushStatsFileChunks({
      stats: a,
      provider: remote,
      targetId: 'ta',
      writerId: 'dev-a',
      now: () => 1000,
      newChunkId: ids('c1'),
    });

    const b = await freshStats();
    await pullStatsFileChunks({ stats: b, provider: remote, targetId: 'tb', writerId: 'dev-b' });
    expect((await b.getBookByMd5('b1'))!.total_read_time).toBe(10);

    // Local page duration grows (same event identity).
    const book = await a.getBookByMd5('b1');
    await a.insertPageEvent(book!.id, {
      page: 1,
      startTime: 200,
      duration: 30,
      totalPages: 100,
    });
    // Imported history with an older start_time than any existing event.
    await a.insertPageEvent(book!.id, {
      page: 2,
      startTime: 0,
      duration: 4,
      totalPages: 100,
    });

    const second = await pushStatsFileChunks({
      stats: a,
      provider: remote,
      targetId: 'ta',
      writerId: 'dev-a',
      now: () => 2000,
      newChunkId: ids('c2'),
    });
    expect(second).toEqual({ chunks: 1, books: 1, events: 2 });

    const pulled = await pullStatsFileChunks({
      stats: b,
      provider: remote,
      targetId: 'tb',
      writerId: 'dev-b',
    });
    expect(pulled.chunks).toBe(1);
    expect((await b.getBookByMd5('b1'))!.total_read_time).toBe(34);
    const events = await b.getEventsForPush(-1);
    expect(events.events.find((e) => e.startTime === 200)!.duration).toBe(30);
  });

  it('syncs metadata-only changes without events', async () => {
    const remote = new MemoryProvider();
    const a = await freshStats();
    await seed(a, [{ bookMd5: 'b1', page: 1, startTime: 100, duration: 10, title: 'Old title' }]);
    await pushStatsFileChunks({
      stats: a,
      provider: remote,
      targetId: 'ta',
      writerId: 'dev-a',
      now: () => 1000,
      newChunkId: ids('c1'),
    });

    await a.upsertBook({ bookMd5: 'b1', title: 'New title', authors: 'A' });
    const pushed = await pushStatsFileChunks({
      stats: a,
      provider: remote,
      targetId: 'ta',
      writerId: 'dev-a',
      now: () => 2000,
      newChunkId: ids('c2'),
    });
    expect(pushed).toEqual({ chunks: 1, books: 1, events: 0 });

    const b = await freshStats();
    const pulled = await pullStatsFileChunks({
      stats: b,
      provider: remote,
      targetId: 'tb',
      writerId: 'dev-b',
    });
    expect(pulled).toEqual({ chunks: 2, books: 2, events: 1 });
    expect((await b.getBookByMd5('b1'))!.title).toBe('New title');
  });

  it('does not write or create directories for an empty backlog', async () => {
    const remote = new MemoryProvider();
    const a = await freshStats();
    expect(
      await pushStatsFileChunks({
        stats: a,
        provider: remote,
        targetId: 'ta',
        writerId: 'dev-a',
        now: () => 1000,
        newChunkId: ids('unused'),
      }),
    ).toEqual({ chunks: 0, books: 0, events: 0 });
    expect(remote.ops).toEqual([]);
  });
});

describe('stats file channel retry and concurrency', () => {
  it('keeps events pending after a failed PUT and retries with a fresh chunk id', async () => {
    const remote = new MemoryProvider();
    const a = await freshStats();
    await seed(a, [{ bookMd5: 'b1', page: 1, startTime: 100, duration: 10 }]);
    remote.writeFailures.push(new FileSyncError('offline', 'NETWORK'));

    await expect(
      pushStatsFileChunks({
        stats: a,
        provider: remote,
        targetId: 'ta',
        writerId: 'dev-a',
        now: () => 1000,
        newChunkId: ids('failed'),
      }),
    ).rejects.toThrow('offline');

    expect(remote.files.size).toBe(0);
    expect((await a.getStatsFilePushBatch('ta', 100)).events).toHaveLength(1);

    const retried = await pushStatsFileChunks({
      stats: a,
      provider: remote,
      targetId: 'ta',
      writerId: 'dev-a',
      now: () => 2000,
      newChunkId: ids('retried'),
    });
    expect(retried).toEqual({ chunks: 1, books: 1, events: 1 });
    expect(remote.files.has(statsFileChunkPath('/', 'dev-a', 'retried'))).toBe(true);
    expect(remote.files.has(statsFileChunkPath('/', 'dev-a', 'failed'))).toBe(false);
  });

  it('retries after the PUT succeeded but the snapshot ack failed', async () => {
    const remote = new MemoryProvider();
    const a = await freshStats();
    await seed(a, [{ bookMd5: 'b1', page: 1, startTime: 100, duration: 10 }]);

    const ack = vi.spyOn(a, 'ackStatsFilePush').mockRejectedValueOnce(new Error('ack failed'));
    await expect(
      pushStatsFileChunks({
        stats: a,
        provider: remote,
        targetId: 'ta',
        writerId: 'dev-a',
        now: () => 1000,
        newChunkId: ids('put-1', 'put-2'),
      }),
    ).rejects.toThrow('ack failed');
    ack.mockRestore();

    expect(remote.files.has(statsFileChunkPath('/', 'dev-a', 'put-1'))).toBe(true);
    expect((await a.getStatsFilePushBatch('ta', 100)).events).toHaveLength(1);

    const retried = await pushStatsFileChunks({
      stats: a,
      provider: remote,
      targetId: 'ta',
      writerId: 'dev-a',
      now: () => 2000,
      newChunkId: ids('put-2'),
    });
    expect(retried.chunks).toBe(1);
    expect(remote.files.has(statsFileChunkPath('/', 'dev-a', 'put-2'))).toBe(true);
    expect(await a.getStatsFilePushBatch('ta', 100)).toEqual({ books: [], events: [] });

    // The receiver sees both immutable chunks; the repeated event merges once.
    const b = await freshStats();
    const pulled = await pullStatsFileChunks({
      stats: b,
      provider: remote,
      targetId: 'tb',
      writerId: 'dev-b',
    });
    expect(pulled).toEqual({ chunks: 2, books: 2, events: 2 });
    expect((await b.getBookByMd5('b1'))!.total_read_time).toBe(10);
  });

  it('converges two devices that copied the same writer id', async () => {
    const remote = new MemoryProvider();
    const a = await freshStats();
    const b = await freshStats();
    await seed(a, [
      { bookMd5: 'b1', page: 1, startTime: 100, duration: 10, totalPages: 100 },
      { bookMd5: 'b1', page: 2, startTime: 200, duration: 20, totalPages: 100 },
    ]);
    await seed(b, [
      { bookMd5: 'b1', page: 1, startTime: 100, duration: 30, totalPages: 100 },
      { bookMd5: 'b1', page: 2, startTime: 200, duration: 20, totalPages: 120 },
    ]);

    const push = (stats: StatisticsDb, targetId: string, chunkIds: string[]) =>
      pushStatsFileChunks({
        stats,
        provider: remote,
        targetId,
        writerId: 'cloned-device',
        now: () => 1000,
        newChunkId: ids(...chunkIds),
      });
    const pull = (stats: StatisticsDb, targetId: string) =>
      pullStatsFileChunks({
        stats,
        provider: remote,
        targetId,
        writerId: 'cloned-device',
      });

    // Concurrent writes from both devices under the same writer folder.
    await Promise.all([push(a, 'ta', ['a1']), push(b, 'tb', ['b1'])]);
    await Promise.all([pull(a, 'ta'), pull(b, 'tb')]);

    // B learned a shorter snapshot from A and still owes a correction.
    const pendingB = await b.getStatsFilePushBatch('tb', 100);
    expect(pendingB.events).toHaveLength(2);
    await push(b, 'tb', ['b2']);
    await pull(a, 'ta');
    await pull(b, 'tb');

    const snapshot = async (stats: StatisticsDb) => {
      const { events } = await stats.getEventsForPush(-1);
      return events
        .map((e) => ({
          page: e.page,
          startTime: e.startTime,
          duration: e.duration,
          totalPages: e.totalPages,
        }))
        .sort((x, y) => x.startTime - y.startTime);
    };
    const expected = [
      { page: 1, startTime: 100, duration: 30, totalPages: 100 },
      { page: 2, startTime: 200, duration: 20, totalPages: 120 },
    ];
    expect(await snapshot(a)).toEqual(expected);
    expect(await snapshot(b)).toEqual(expected);
    expect(await a.getStatsFilePushBatch('ta', 100)).toEqual({ books: [], events: [] });
    expect(await b.getStatsFilePushBatch('tb', 100)).toEqual({ books: [], events: [] });

    // Further pulls are no-ops for both once all chunks are seen.
    expect((await pull(a, 'ta')).chunks).toBe(0);
    expect((await pull(b, 'tb')).chunks).toBe(0);
  });

  it('keeps a longer local duration when a shorter remote arrives, then corrects the remote', async () => {
    const remote = new MemoryProvider();
    const a = await freshStats();
    const b = await freshStats();
    await seed(a, [{ bookMd5: 'b1', page: 1, startTime: 100, duration: 10, totalPages: 50 }]);
    await seed(b, [{ bookMd5: 'b1', page: 1, startTime: 100, duration: 30, totalPages: 100 }]);

    await pushStatsFileChunks({
      stats: a,
      provider: remote,
      targetId: 'ta',
      writerId: 'dev-a',
      now: () => 1000,
      newChunkId: ids('a1'),
    });

    await pullStatsFileChunks({
      stats: b,
      provider: remote,
      targetId: 'tb',
      writerId: 'dev-b',
    });
    const local = (await b.getEventsForPush(-1)).events[0]!;
    expect(local).toMatchObject({ duration: 30, totalPages: 100 });

    const correction = await pushStatsFileChunks({
      stats: b,
      provider: remote,
      targetId: 'tb',
      writerId: 'dev-b',
      now: () => 2000,
      newChunkId: ids('b1'),
    });
    expect(correction.chunks).toBe(1);

    await pullStatsFileChunks({
      stats: a,
      provider: remote,
      targetId: 'ta',
      writerId: 'dev-a',
    });
    expect((await a.getEventsForPush(-1)).events[0]).toMatchObject({
      duration: 30,
      totalPages: 100,
    });
  });
});

describe('stats file channel pull isolation', () => {
  it('returns empty when the stats root is missing and rethrows auth/network errors', async () => {
    const remote = new MemoryProvider();
    const stats = await freshStats();
    expect(
      await pullStatsFileChunks({
        stats,
        provider: remote,
        targetId: 't',
        writerId: 'dev',
      }),
    ).toEqual({ chunks: 0, books: 0, events: 0 });

    const root = statsFileRootPath('/');
    remote.listErrors.set(root, new FileSyncError('denied', 'AUTH_FAILED', 401));
    await expect(
      pullStatsFileChunks({ stats, provider: remote, targetId: 't', writerId: 'dev' }),
    ).rejects.toThrow('denied');

    remote.listErrors.set(root, new FileSyncError('offline', 'NETWORK'));
    await expect(
      pullStatsFileChunks({ stats, provider: remote, targetId: 't', writerId: 'dev' }),
    ).rejects.toThrow('offline');
  });

  it('skips malformed and unsupported chunks but leaves them unseen', async () => {
    const remote = new MemoryProvider();
    const root = statsFileRootPath('/');
    const writer = statsFileWriterPath('/', 'w');
    remote.ensureDir([root, writer]);

    remote.put(statsFileChunkPath('/', 'w', 'bad-json'), '{not json');
    remote.put(
      statsFileChunkPath('/', 'w', 'v2'),
      JSON.stringify({ v: 2, written_at: 1, books: [], events: [] }),
    );
    remote.put(
      statsFileChunkPath('/', 'w', 'negative'),
      JSON.stringify({
        v: 1,
        written_at: 2,
        books: [],
        events: [
          {
            book_hash: 'b1',
            page: -1,
            start_time: 100,
            duration: 5,
            total_pages: 10,
          },
        ],
      }),
    );
    const nullPath = statsFileChunkPath('/', 'w', 'null-text');
    remote.nullReads.add(nullPath);
    remote.put(nullPath, 'listed but evicted');

    const valid: StatsFileChunk = {
      v: 1,
      written_at: 3,
      books: [{ book_hash: 'b1', title: 'Book', authors: 'A' }],
      events: [{ book_hash: 'b1', page: 1, start_time: 100, duration: 5, total_pages: 10 }],
    };
    const validPath = statsFileChunkPath('/', 'w', 'valid');
    remote.put(validPath, encodeStatsFileChunk(valid));

    const stats = await freshStats();
    const result = await pullStatsFileChunks({
      stats,
      provider: remote,
      targetId: 't',
      writerId: 'dev',
    });
    expect(result).toEqual({ chunks: 1, books: 1, events: 1, failedChunks: 3 });
    expect(await stats.getSeenStatsFileChunkPaths('t')).toEqual(new Set([validPath]));

    // Malformed chunks stay unseen and are retried; the valid chunk is not.
    const again = await pullStatsFileChunks({
      stats,
      provider: remote,
      targetId: 't',
      writerId: 'dev',
    });
    expect(again).toEqual({ chunks: 0, books: 0, events: 0, failedChunks: 3 });
  });

  it('orders chunks by written_at across writer folders', async () => {
    const remote = new MemoryProvider();
    const root = statsFileRootPath('/');
    const writer = statsFileWriterPath('/', 'w');
    remote.ensureDir([root, writer]);
    const chunk = (writtenAt: number, title: string): StatsFileChunk => ({
      v: 1,
      written_at: writtenAt,
      books: [{ book_hash: 'b1', title, authors: '' }],
      events: [],
    });
    remote.put(statsFileChunkPath('/', 'w', 'a'), encodeStatsFileChunk(chunk(200, 'Newer')));
    remote.put(statsFileChunkPath('/', 'w', 'z'), encodeStatsFileChunk(chunk(100, 'Older')));

    const stats = await freshStats();
    expect(
      (await pullStatsFileChunks({ stats, provider: remote, targetId: 't', writerId: 'dev' }))
        .chunks,
    ).toBe(2);
    expect((await stats.getBookByMd5('b1'))!.title).toBe('Newer');
  });

  it('ignores listed entries outside the stats hierarchy', async () => {
    const remote = new MemoryProvider();
    const root = statsFileRootPath('/');
    const writer = statsFileWriterPath('/', 'w');
    remote.ensureDir([root, writer]);

    remote.listOverrides.set(root, [
      { name: 'evil', path: '/outside/writer', isDirectory: true },
      { name: '..', path: `${root}/../`, isDirectory: true },
    ]);
    // Listing outside the hierarchy must never happen.
    remote.listErrors.set('/outside/writer', new FileSyncError('unexpected', 'NETWORK'));

    const mismatch = encodeStatsFileChunk({
      v: 1,
      written_at: 1,
      books: [{ book_hash: 'b1', title: 'Book', authors: '' }],
      events: [],
    });
    remote.files.set(statsFileChunkPath('/', 'w', 'x'), mismatch);
    remote.listOverrides.set(writer, [
      { name: 'x.json', path: '/outside/x.json', isDirectory: false },
    ]);

    const stats = await freshStats();
    const result = await pullStatsFileChunks({
      stats,
      provider: remote,
      targetId: 't',
      writerId: 'dev',
    });
    expect(result).toEqual({ chunks: 0, books: 0, events: 0 });
    expect(remote.ops.some((op) => op.startsWith('read:/outside'))).toBe(false);
    expect(await stats.getSeenStatsFileChunkPaths('t')).toEqual(new Set());
  });

  it('pulls chunks from a folder matching its own writer id (cloned device id)', async () => {
    const remote = new MemoryProvider();
    const a = await freshStats();
    await seed(a, [{ bookMd5: 'b1', page: 1, startTime: 100, duration: 10 }]);
    await pushStatsFileChunks({
      stats: a,
      provider: remote,
      targetId: 'ta',
      writerId: 'shared-device',
      now: () => 1000,
      newChunkId: ids('c1'),
    });

    const b = await freshStats();
    const pulled = await pullStatsFileChunks({
      stats: b,
      provider: remote,
      targetId: 'tb',
      writerId: 'shared-device',
    });
    expect(pulled).toEqual({ chunks: 1, books: 1, events: 1 });
    expect((await b.getBookByMd5('b1'))!.total_read_time).toBe(10);
  });

  it('keeps acknowledgements and seen paths separate per target', async () => {
    const remote = new MemoryProvider();
    const a = await freshStats();
    await seed(a, [{ bookMd5: 'b1', page: 1, startTime: 100, duration: 10 }]);
    await pushStatsFileChunks({
      stats: a,
      provider: remote,
      targetId: 'ta',
      writerId: 'dev-a',
      now: () => 1000,
      newChunkId: ids('c1'),
    });
    // A second target has no push acknowledgements, so it backfills again.
    const second = await pushStatsFileChunks({
      stats: a,
      provider: remote,
      targetId: 't-other',
      writerId: 'dev-a',
      now: () => 2000,
      newChunkId: ids('c2'),
    });
    expect(second.chunks).toBe(1);

    const b = await freshStats();
    const first = await pullStatsFileChunks({
      stats: b,
      provider: remote,
      targetId: 't-one',
      writerId: 'dev-b',
    });
    expect(first.chunks).toBe(2);
    // Seen chunks are per target: the second target replays them idempotently.
    const replay = await pullStatsFileChunks({
      stats: b,
      provider: remote,
      targetId: 't-two',
      writerId: 'dev-b',
    });
    expect(replay.chunks).toBe(2);
    expect((await b.getBookByMd5('b1'))!.total_read_time).toBe(10);
  });
});

describe('stats file channel streaming and cancellation', () => {
  const chunk = (writtenAt: number, title: string, page: number): StatsFileChunk => ({
    v: 1,
    written_at: writtenAt,
    books: [{ book_hash: 'b1', title, authors: '' }],
    events: [{ book_hash: 'b1', page, start_time: 100 + page, duration: 5, total_pages: 100 }],
  });

  const seedTwoChunks = async (remote: MemoryProvider) => {
    const writer = statsFileWriterPath('/', 'w');
    await remote.ensureDir([statsFileRootPath('/'), writer]);
    const aPath = statsFileChunkPath('/', 'w', 'a');
    const zPath = statsFileChunkPath('/', 'w', 'z');
    remote.put(aPath, encodeStatsFileChunk(chunk(200, 'A', 1)));
    remote.put(zPath, encodeStatsFileChunk(chunk(100, 'Z', 2)));
    return { aPath, zPath };
  };

  it('streams chunks: applies each one before reading the next', async () => {
    const remote = new MemoryProvider();
    const { aPath, zPath } = await seedTwoChunks(remote);
    const stats = await freshStats();
    const flow: string[] = [];
    const originalRead = remote.readText.bind(remote);
    const readSpy = vi.spyOn(remote, 'readText').mockImplementation(async (path) => {
      flow.push(`read:${path}`);
      return originalRead(path);
    });
    const originalApply = stats.applyStatsFileChunk.bind(stats);
    const applySpy = vi
      .spyOn(stats, 'applyStatsFileChunk')
      .mockImplementation(async (...args: Parameters<StatisticsDb['applyStatsFileChunk']>) => {
        flow.push(`apply:${args[1]}`);
        return originalApply(...args);
      });

    await pullStatsFileChunks({
      stats,
      provider: remote,
      targetId: 't',
      writerId: 'dev',
    });
    expect(flow).toEqual([`read:${aPath}`, `apply:${aPath}`, `read:${zPath}`, `apply:${zPath}`]);
    readSpy.mockRestore();
    applySpy.mockRestore();
  });

  it('stops between chunks and keeps earlier applied chunks', async () => {
    const remote = new MemoryProvider();
    const { aPath } = await seedTwoChunks(remote);
    const stats = await freshStats();
    const continueRef = { value: true };
    const originalApply = stats.applyStatsFileChunk.bind(stats);
    const applySpy = vi
      .spyOn(stats, 'applyStatsFileChunk')
      .mockImplementation(async (...args: Parameters<StatisticsDb['applyStatsFileChunk']>) => {
        const result = await originalApply(...args);
        continueRef.value = false;
        return result;
      });

    await expect(
      pullStatsFileChunks({
        stats,
        provider: remote,
        targetId: 't',
        writerId: 'dev',
        shouldContinue: () => continueRef.value,
      }),
    ).rejects.toBeInstanceOf(StatsFileSyncInterruptedError);
    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(await stats.getSeenStatsFileChunkPaths('t')).toEqual(new Set([aPath]));
    expect((await stats.getEventsForPush(-1)).events.map((e) => e.page)).toEqual([1]);
    expect(remote.ops.some((op) => op === `read:${statsFileChunkPath('/', 'w', 'z')}`)).toBe(false);
    applySpy.mockRestore();
  });

  it('leaves a read chunk unseen when cancellation happens before DB apply', async () => {
    const remote = new MemoryProvider();
    await seedTwoChunks(remote);
    const stats = await freshStats();
    const continueRef = { value: true };
    const originalRead = remote.readText.bind(remote);
    const readSpy = vi.spyOn(remote, 'readText').mockImplementation(async (path) => {
      const text = await originalRead(path);
      continueRef.value = false;
      return text;
    });

    await expect(
      pullStatsFileChunks({
        stats,
        provider: remote,
        targetId: 't',
        writerId: 'dev',
        shouldContinue: () => continueRef.value,
      }),
    ).rejects.toBeInstanceOf(StatsFileSyncInterruptedError);
    expect(await stats.getSeenStatsFileChunkPaths('t')).toEqual(new Set());
    expect((await stats.getEventsForPush(-1)).events).toEqual([]);
    readSpy.mockRestore();
  });

  it('checks shouldContinue before listing the pull root', async () => {
    const remote = new MemoryProvider();
    const stats = await freshStats();
    const listSpy = vi.spyOn(remote, 'list');

    await expect(
      pullStatsFileChunks({
        stats,
        provider: remote,
        targetId: 't',
        writerId: 'dev',
        shouldContinue: () => false,
      }),
    ).rejects.toBeInstanceOf(StatsFileSyncInterruptedError);
    expect(listSpy).not.toHaveBeenCalled();
    listSpy.mockRestore();
  });

  it('keeps earlier chunks applied and seen when a later read fails', async () => {
    const remote = new MemoryProvider();
    const { aPath, zPath } = await seedTwoChunks(remote);
    remote.readErrors.set(zPath, new FileSyncError('read down', 'NETWORK'));
    const stats = await freshStats();

    await expect(
      pullStatsFileChunks({
        stats,
        provider: remote,
        targetId: 't',
        writerId: 'dev',
      }),
    ).rejects.toThrow('read down');
    expect(await stats.getSeenStatsFileChunkPaths('t')).toEqual(new Set([aPath]));
    expect((await stats.getEventsForPush(-1)).events.map((e) => e.page)).toEqual([1]);
  });

  it('checks shouldContinue before requesting a push batch', async () => {
    const remote = new MemoryProvider();
    const stats = await freshStats();
    const batchSpy = vi.spyOn(stats, 'getStatsFilePushBatch');

    await expect(
      pushStatsFileChunks({
        stats,
        provider: remote,
        targetId: 't',
        writerId: 'dev',
        shouldContinue: () => false,
      }),
    ).rejects.toBeInstanceOf(StatsFileSyncInterruptedError);
    expect(batchSpy).not.toHaveBeenCalled();
    expect(remote.ops).toEqual([]);
    batchSpy.mockRestore();
  });

  it('stops before PUT when shouldContinue turns false after batching', async () => {
    const remote = new MemoryProvider();
    const stats = await freshStats();
    await seed(stats, [{ bookMd5: 'b1', page: 1, startTime: 100, duration: 10 }]);
    const continueRef = { value: true };
    const originalBatch = stats.getStatsFilePushBatch.bind(stats);
    const batchSpy = vi
      .spyOn(stats, 'getStatsFilePushBatch')
      .mockImplementationOnce(
        async (...args: Parameters<StatisticsDb['getStatsFilePushBatch']>) => {
          const batch = await originalBatch(...args);
          continueRef.value = false;
          return batch;
        },
      );

    await expect(
      pushStatsFileChunks({
        stats,
        provider: remote,
        targetId: 't',
        writerId: 'dev',
        now: () => 1000,
        newChunkId: ids('unused'),
        shouldContinue: () => continueRef.value,
      }),
    ).rejects.toBeInstanceOf(StatsFileSyncInterruptedError);
    expect(remote.ops).toEqual([]);
    expect(await stats.getSeenStatsFileChunkPaths('t')).toEqual(new Set());
    expect((await stats.getStatsFilePushBatch('t', 100)).events).toHaveLength(1);
    batchSpy.mockRestore();
  });

  it('does not start a PUT when shouldContinue turns false in ensureDir', async () => {
    const remote = new MemoryProvider();
    const stats = await freshStats();
    await seed(stats, [{ bookMd5: 'b1', page: 1, startTime: 100, duration: 10 }]);
    const continueRef = { value: true };
    const originalEnsureDir = remote.ensureDir.bind(remote);
    const ensureSpy = vi.spyOn(remote, 'ensureDir').mockImplementationOnce(async (paths) => {
      continueRef.value = false;
      return originalEnsureDir(paths);
    });
    const ackSpy = vi.spyOn(stats, 'ackStatsFilePush');

    await expect(
      pushStatsFileChunks({
        stats,
        provider: remote,
        targetId: 't',
        writerId: 'dev',
        now: () => 1000,
        newChunkId: ids('guarded'),
        shouldContinue: () => continueRef.value,
      }),
    ).rejects.toBeInstanceOf(StatsFileSyncInterruptedError);
    expect(ackSpy).not.toHaveBeenCalled();
    expect(remote.files.size).toBe(0);
    expect((await stats.getStatsFilePushBatch('t', 100)).events).toHaveLength(1);
    // The pre-PUT seen marker is harmless and keeps a retry from re-importing.
    expect(await stats.getSeenStatsFileChunkPaths('t')).toEqual(
      new Set([statsFileChunkPath('/', 'dev', 'guarded')]),
    );
    ensureSpy.mockRestore();
    ackSpy.mockRestore();
  });

  it('does not re-import its own stale chunk after PUT success and ack failure', async () => {
    const remote = new MemoryProvider();
    const stats = await freshStats();
    await seed(stats, [{ bookMd5: 'b1', page: 1, startTime: 100, duration: 10 }]);
    await stats.upsertBook({ bookMd5: 'b1', title: 'Old title', authors: 'A' });

    const originalWrite = remote.writeText.bind(remote);
    const writeSpy = vi.spyOn(remote, 'writeText').mockImplementationOnce(async (path, body) => {
      // Local metadata changes while the PUT is in flight.
      await stats.upsertBook({ bookMd5: 'b1', title: 'New title', authors: 'A' });
      return originalWrite(path, body);
    });
    const ack = vi.spyOn(stats, 'ackStatsFilePush').mockRejectedValueOnce(new Error('ack failed'));

    await expect(
      pushStatsFileChunks({
        stats,
        provider: remote,
        targetId: 't',
        writerId: 'dev',
        now: () => 1000,
        newChunkId: ids('stale'),
      }),
    ).rejects.toThrow('ack failed');
    ack.mockRestore();
    writeSpy.mockRestore();
    expect(remote.files.has(statsFileChunkPath('/', 'dev', 'stale'))).toBe(true);

    const pulled = await pullStatsFileChunks({
      stats,
      provider: remote,
      targetId: 't',
      writerId: 'dev',
    });
    expect(pulled.chunks).toBe(0);
    expect((await stats.getBookByMd5('b1'))!.title).toBe('New title');

    const pending = await stats.getStatsFilePushBatch('t', 100);
    expect(pending.events).toHaveLength(1);
    expect(pending.books).toEqual([{ bookMd5: 'b1', title: 'New title', authors: 'A' }]);
  });

  it('shrinks the batch on encoded-size failure so valid history progresses', async () => {
    const db = await NodeDatabaseService.open(':memory:');
    await migrate(db, getMigrations('statistics'));
    const stats = StatisticsDb.from(db);
    const bigTitle = (i: number) => `${i}${'x'.repeat(3 * 1024 * 1024)}`;
    for (let i = 0; i < 3; i += 1) {
      await db.execute(`INSERT INTO book (title, authors, md5) VALUES (?, '', ?)`, [
        bigTitle(i),
        `big-${i}`,
      ]);
      const id = (
        await db.select<{ id: number }>(`SELECT id FROM book WHERE md5 = ?`, [`big-${i}`])
      )[0]!.id;
      await db.execute(
        `INSERT INTO page_stat_data (id_book, page, start_time, duration, total_pages)
         VALUES (?, ?, ?, ?, ?)`,
        [id, 1, 100 + i, 5, 10],
      );
    }
    const remote = new MemoryProvider();

    const pushed = await pushStatsFileChunks({
      stats,
      provider: remote,
      targetId: 't',
      writerId: 'dev',
      now: () => 1000,
      newChunkId: ids('c1', 'c2', 'c3'),
    });
    expect(pushed).toEqual({ chunks: 3, books: 3, events: 3 });
    expect(remote.files.size).toBe(3);
    expect(await stats.getStatsFilePushBatch('t', 100)).toEqual({ books: [], events: [] });
    for (const body of remote.files.values()) {
      const wire = decodeStatsFileChunk(body);
      expect(wire.books).toHaveLength(1);
      expect(wire.events).toHaveLength(1);
    }
  });

  it('rejects a single metadata record larger than the wire limit without acking', async () => {
    const db = await NodeDatabaseService.open(':memory:');
    await migrate(db, getMigrations('statistics'));
    const stats = StatisticsDb.from(db);
    await db.execute(`INSERT INTO book (title, authors, md5) VALUES (?, '', 'huge')`, [
      'x'.repeat(STATS_FILE_MAX_CHARS + 1),
    ]);
    const remote = new MemoryProvider();

    await expect(
      pushStatsFileChunks({
        stats,
        provider: remote,
        targetId: 't',
        writerId: 'dev',
        now: () => 1000,
        newChunkId: ids('unused'),
      }),
    ).rejects.toBeInstanceOf(StatsFileChunkTooLargeError);
    expect(remote.ops).toEqual([]);
    expect(await stats.getSeenStatsFileChunkPaths('t')).toEqual(new Set());
    expect((await stats.getStatsFilePushBatch('t', 100)).books).toHaveLength(1);
  });
});
