import { describe, expect, it, beforeEach } from 'vitest';
import { NodeDatabaseService } from '@/services/database/nodeDatabaseService';
import { migrate } from '@/services/database/migrate';
import { getMigrations } from '@/services/database/migrations';
import type { DatabaseRow, DatabaseService } from '@/types/database';
import { StatisticsDb } from '@/services/statistics/statisticsDb';
import type { PageStatEvent } from '@/types/statistics';

async function freshStatsDb(): Promise<DatabaseService> {
  const db = await NodeDatabaseService.open(':memory:');
  await migrate(db, getMigrations('statistics'));
  return db;
}

const event = (
  page: number,
  startTime: number,
  duration: number,
  totalPages = 100,
  bookMd5 = 'b1',
): PageStatEvent => ({ bookMd5, page, startTime, duration, totalPages });

/** A remote clock comfortably newer than a local `Date.now()` bump. */
const remoteClock = (): number => Date.now() + 60_000;

async function seedBook(
  stats: StatisticsDb,
  bookMd5 = 'b1',
  title = 'Title',
  authors = 'Author',
): Promise<number> {
  return stats.upsertBook({ bookMd5, title, authors });
}

/** Pauses a chunk-apply page insert, then lets the test force a rollback. */
class PausingDatabase implements DatabaseService {
  pauseOnPageInsert = false;
  readonly entered: Promise<void>;
  private enteredResolve!: () => void;
  private failApply!: (error: Error) => void;
  private readonly failure: Promise<never>;
  readonly localInsertDone: Promise<void>;
  private localInsertResolve!: () => void;

  constructor(private readonly inner: DatabaseService) {
    this.entered = new Promise<void>((resolve) => (this.enteredResolve = resolve));
    this.failure = new Promise<never>((_, reject) => (this.failApply = reject));
    this.localInsertDone = new Promise<void>((resolve) => (this.localInsertResolve = resolve));
  }

  fail(error = new Error('chunk apply failed')): void {
    this.failApply(error);
  }

  async execute(sql: string, params?: unknown[]) {
    if (this.pauseOnPageInsert && sql.includes('INSERT INTO page_stat_data')) {
      this.pauseOnPageInsert = false;
      this.enteredResolve();
      await this.failure;
    }
    const result = await this.inner.execute(sql, params);
    if (sql.includes('INSERT INTO page_stat_data') && params?.[1] === 3) {
      this.localInsertResolve();
    }
    return result;
  }

  select<T extends DatabaseRow = DatabaseRow>(sql: string, params?: unknown[]): Promise<T[]> {
    return this.inner.select<T>(sql, params);
  }

  batch(statements: string[]): Promise<void> {
    return this.inner.batch(statements);
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

describe('statistics file-sync migration', () => {
  it('adds event ack, book ack, and seen tables without touching official tables', async () => {
    const db = await freshStatsDb();
    const rows = await db.select<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    );
    const names = rows.map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'readest_stat_file_event_ack',
        'readest_stat_file_book_ack',
        'readest_stat_file_book_clock',
        'readest_stat_file_seen',
        'book',
        'page_stat_data',
      ]),
    );
    // Generic names would collide with upstream or imported KOReader schemas.
    expect(names).not.toContain('event_ack');
    expect(names).not.toContain('book_ack');
    expect(names).not.toContain('seen');
  });
});

describe('StatisticsDb file-sync snapshots', () => {
  let stats: StatisticsDb;
  beforeEach(async () => {
    stats = StatisticsDb.from(await freshStatsDb());
  });

  it('backfills the full history including startTime 0, then has nothing pending', async () => {
    const id = await seedBook(stats);
    await stats.insertPageEvent(id, event(1, 0, 5));
    await stats.insertPageEvent(id, event(2, 100, 7));

    const first = await stats.getStatsFilePushBatch('target-a', 100);
    expect(first.events.map((e) => e.startTime)).toEqual([0, 100]);
    expect(first.books).toEqual([{ bookMd5: 'b1', title: 'Title', authors: 'Author' }]);

    await stats.ackStatsFilePush('target-a', '/chunk-1.json', first.books, first.events);
    expect(await stats.getStatsFilePushBatch('target-a', 100)).toEqual({ books: [], events: [] });
  });

  it('re-pushes a grown duration while keeping the acknowledged old snapshot', async () => {
    const id = await seedBook(stats);
    await stats.insertPageEvent(id, event(1, 100, 10));
    const first = await stats.getStatsFilePushBatch('target-a', 100);

    // A tracker write lands while the PUT is in flight: ack the old snapshot.
    await stats.insertPageEvent(id, event(1, 100, 30));
    await stats.ackStatsFilePush('target-a', '/chunk-1.json', first.books, first.events);

    const next = await stats.getStatsFilePushBatch('target-a', 100);
    expect(next.events).toHaveLength(1);
    expect(next.events[0]!.duration).toBe(30);
  });

  it('includes events imported with older start times than acknowledged ones', async () => {
    const id = await seedBook(stats);
    await stats.insertPageEvent(id, event(1, 500, 10));
    const first = await stats.getStatsFilePushBatch('target-a', 100);
    await stats.ackStatsFilePush('target-a', '/chunk-1.json', first.books, first.events);

    // Imported KOReader history with an earlier timestamp is still pending.
    await stats.insertPageEvent(id, event(2, 50, 4));
    const next = await stats.getStatsFilePushBatch('target-a', 100);
    expect(next.events.map((e) => e.startTime)).toEqual([50]);
  });

  it('pushes metadata-only changes without any pending event', async () => {
    const id = await seedBook(stats, 'b1', 'Old title', 'Author');
    await stats.insertPageEvent(id, event(1, 100, 10));
    const first = await stats.getStatsFilePushBatch('target-a', 100);
    await stats.ackStatsFilePush('target-a', '/chunk-1.json', first.books, first.events);

    await stats.upsertBook({ bookMd5: 'b1', title: 'New title', authors: 'Author' });

    const next = await stats.getStatsFilePushBatch('target-a', 100);
    expect(next.events).toEqual([]);
    expect(next.books).toEqual([{ bookMd5: 'b1', title: 'New title', authors: 'Author' }]);
  });

  it('bounds the batch and keeps each event book metadata in the batch', async () => {
    const id1 = await seedBook(stats, 'b1', 'One', 'A');
    const id2 = await seedBook(stats, 'b2', 'Two', 'B');
    await stats.insertPageEvent(id1, event(1, 10, 1, 100, 'b1'));
    await stats.insertPageEvent(id1, event(2, 20, 1, 100, 'b1'));
    await stats.insertPageEvent(id2, event(1, 30, 1, 100, 'b2'));

    const first = await stats.getStatsFilePushBatch('target-a', 2);
    expect(first.events).toHaveLength(2);
    expect(first.books.map((b) => b.bookMd5).sort()).toEqual(['b1', 'b2']);
    await stats.ackStatsFilePush('target-a', '/chunk-1.json', first.books, first.events);

    const second = await stats.getStatsFilePushBatch('target-a', 2);
    expect(second.events).toHaveLength(1);
    expect(second.books.map((b) => b.bookMd5)).toEqual(['b2']);
  });

  it('bounds metadata-only batches and drains them', async () => {
    await seedBook(stats, 'b1', 'One', 'A');
    await seedBook(stats, 'b2', 'Two', 'A');
    await seedBook(stats, 'b3', 'Three', 'A');

    const first = await stats.getStatsFilePushBatch('target-a', 2);
    expect(first.events).toEqual([]);
    expect(first.books).toHaveLength(2);
    await stats.ackStatsFilePush('target-a', '/chunk-1.json', first.books, first.events);

    const second = await stats.getStatsFilePushBatch('target-a', 2);
    expect(second.books).toHaveLength(1);
    await stats.ackStatsFilePush('target-a', '/chunk-2.json', second.books, second.events);

    expect(await stats.getStatsFilePushBatch('target-a', 2)).toEqual({ books: [], events: [] });
  });

  it('normalizes imported duplicate md5 rows with conflicting event snapshots and terminates', async () => {
    const db = await freshStatsDb();
    const stats = StatisticsDb.from(db);
    // KOReader's unique(title, authors, md5) permits two rows for one md5.
    await db.execute(`INSERT INTO book (title, authors, md5) VALUES ('Old title', 'A', 'dup')`);
    await db.execute(`INSERT INTO book (title, authors, md5) VALUES ('New title', 'B', 'dup')`);
    const rows = await db.select<{ id: number }>(
      `SELECT id FROM book WHERE md5 = 'dup' ORDER BY id`,
    );
    await db.execute(
      `INSERT INTO page_stat_data (id_book, page, start_time, duration, total_pages)
       VALUES (?, ?, ?, ?, ?)`,
      [rows[0]!.id, 1, 100, 10, 50],
    );
    await db.execute(
      `INSERT INTO page_stat_data (id_book, page, start_time, duration, total_pages)
       VALUES (?, ?, ?, ?, ?)`,
      [rows[1]!.id, 1, 100, 30, 100],
    );
    await db.execute(
      `INSERT INTO page_stat_data (id_book, page, start_time, duration, total_pages)
       VALUES (?, ?, ?, ?, ?)`,
      [rows[0]!.id, 2, 200, 5, 50],
    );

    let chunks = 0;
    let batch = await stats.getStatsFilePushBatch('target-a', 100);
    // One normalized snapshot per logical key, and no distinct key is lost.
    expect(batch.events).toHaveLength(2);
    expect(batch.events.find((e) => e.page === 1)).toMatchObject({
      bookMd5: 'dup',
      startTime: 100,
      duration: 30,
      totalPages: 100,
    });
    expect(batch.events.find((e) => e.page === 2)).toMatchObject({
      duration: 5,
      totalPages: 50,
    });
    expect(batch.books).toHaveLength(1);

    while ((batch.books.length > 0 || batch.events.length > 0) && chunks < 5) {
      await stats.ackStatsFilePush('target-a', `/chunk-${chunks}.json`, batch.books, batch.events);
      chunks += 1;
      batch = await stats.getStatsFilePushBatch('target-a', 100);
    }
    expect(chunks).toBeLessThan(5);
    expect(batch).toEqual({ books: [], events: [] });
  });

  it('normalizes imported duplicate md5 rows that disagree only on metadata', async () => {
    const db = await freshStatsDb();
    const stats = StatisticsDb.from(db);
    await db.execute(`INSERT INTO book (title, authors, md5) VALUES ('Old title', 'A', 'dup')`);
    await db.execute(`INSERT INTO book (title, authors, md5) VALUES ('New title', 'B', 'dup')`);

    let chunks = 0;
    let batch = await stats.getStatsFilePushBatch('target-a', 100);
    expect(batch.events).toEqual([]);
    expect(batch.books).toHaveLength(1);

    while ((batch.books.length > 0 || batch.events.length > 0) && chunks < 5) {
      await stats.ackStatsFilePush('target-a', `/chunk-${chunks}.json`, batch.books, batch.events);
      chunks += 1;
      batch = await stats.getStatsFilePushBatch('target-a', 100);
    }
    expect(chunks).toBeLessThan(5);
    expect(batch).toEqual({ books: [], events: [] });
  });

  it('keeps acknowledgements and seen chunks per target', async () => {
    const id = await seedBook(stats);
    await stats.insertPageEvent(id, event(1, 100, 10));
    const first = await stats.getStatsFilePushBatch('target-a', 100);
    await stats.ackStatsFilePush('target-a', '/chunk-a.json', first.books, first.events);

    expect(await stats.getStatsFilePushBatch('target-a', 100)).toEqual({
      books: [],
      events: [],
    });
    expect((await stats.getStatsFilePushBatch('target-b', 100)).events).toHaveLength(1);
    expect(await stats.getSeenStatsFileChunkPaths('target-a')).toEqual(new Set(['/chunk-a.json']));
    expect(await stats.getSeenStatsFileChunkPaths('target-b')).toEqual(new Set());
  });

  it('queues local page writes behind an apply transaction so rollback cannot lose them', async () => {
    const db = new PausingDatabase(await freshStatsDb());
    const stats = StatisticsDb.from(db);
    const bookId = await stats.upsertBook({ bookMd5: 'b1', title: 'Book', authors: 'A' });

    db.pauseOnPageInsert = true;
    const applying = stats.applyStatsFileChunk('t', '/remote.json', [], [event(2, 200, 5)]);
    await db.entered;

    const localWrite = stats.insertPageEvent(bookId, {
      page: 3,
      startTime: 300,
      duration: 7,
      totalPages: 100,
    });
    // Give a pre-fix implementation time to join the open transaction.
    await Promise.race([
      db.localInsertDone,
      new Promise<void>((resolve) => setTimeout(resolve, 25)),
    ]);
    const during = await db.select<{ c: number }>(`SELECT COUNT(*) AS c FROM page_stat_data`);
    expect(during[0]!.c).toBe(0);

    db.fail();
    await expect(applying).rejects.toThrow('chunk apply failed');
    await localWrite;

    const rows = await db.select<{ page: number }>(`SELECT page FROM page_stat_data ORDER BY page`);
    expect(rows.map((row) => row.page)).toEqual([3]);
  });

  it('ignores invalid imported event rows and keeps null metadata empty', async () => {
    const db = await freshStatsDb();
    const stats = StatisticsDb.from(db);
    await db.execute(`INSERT INTO book (title, authors, md5) VALUES (NULL, NULL, 'b-null')`);
    await db.execute(`INSERT INTO book (title, authors, md5) VALUES ('Space', 'S', '   ')`);
    const nullBook = (
      await db.select<{ id: number }>(`SELECT id FROM book WHERE md5 = 'b-null'`)
    )[0]!;
    const spaceBook = (
      await db.select<{ id: number }>(`SELECT id FROM book WHERE md5 = '   '`)
    )[0]!;
    const insert = (
      idBook: number,
      page: unknown,
      startTime: unknown,
      duration: unknown,
      totalPages: unknown,
    ) =>
      db.execute(
        `INSERT INTO page_stat_data (id_book, page, start_time, duration, total_pages)
         VALUES (?, ?, ?, ?, ?)`,
        [idBook, page, startTime, duration, totalPages],
      );

    await insert(nullBook.id, 1, 100, 5, 10); // valid
    await insert(nullBook.id, -1, 100, 5, 10);
    await insert(nullBook.id, 2, -1, 5, 10);
    await insert(nullBook.id, 3, 100, 1.5, 10); // REAL duration
    await insert(nullBook.id, 4, 100, 5, 'not-a-number'); // TEXT total_pages
    await insert(nullBook.id, 9_007_199_254_740_994, 100, 5, 10); // > JS safe integer
    await insert(spaceBook.id, 1, 100, 5, 10); // whitespace md5

    const batch = await stats.getStatsFilePushBatch('t', 100);
    expect(batch.events).toEqual([
      { bookMd5: 'b-null', page: 1, startTime: 100, duration: 5, totalPages: 10 },
    ]);
    expect(batch.books).toEqual([{ bookMd5: 'b-null', title: '', authors: '' }]);

    await stats.ackStatsFilePush('t', '/valid.json', batch.books, batch.events);
    expect(await stats.getStatsFilePushBatch('t', 100)).toEqual({ books: [], events: [] });

    const count = await db.select<{ c: number }>(`SELECT COUNT(*) AS c FROM page_stat_data`);
    expect(count[0]!.c).toBe(7); // invalid source rows are preserved, only ignored
  });

  it('lets an older real field fill a newer blank/hash field', async () => {
    await stats.upsertBook({ bookMd5: 'b1', title: 'b1', authors: '' });
    await stats.applyStatsFileChunk(
      't',
      '/new-blank.json',
      [{ bookMd5: 'b1', title: '', authors: '' }],
      [],
      300,
    );
    await stats.applyStatsFileChunk(
      't',
      '/old-real.json',
      [{ bookMd5: 'b1', title: 'Real title', authors: 'Real author' }],
      [],
      200,
    );
    expect(await stats.getBookByMd5('b1')).toMatchObject({
      title: 'Real title',
      authors: 'Real author',
    });
  });

  it('keeps a newer real file title when a later older real chunk arrives', async () => {
    await stats.upsertBook({ bookMd5: 'b1', title: 'b1', authors: '' });
    await stats.applyStatsFileChunk(
      't',
      '/new.json',
      [{ bookMd5: 'b1', title: 'Newer', authors: '' }],
      [],
      300,
    );
    await stats.applyStatsFileChunk(
      't',
      '/old.json',
      [{ bookMd5: 'b1', title: 'Older', authors: '' }],
      [],
      200,
    );
    expect((await stats.getBookByMd5('b1'))!.title).toBe('Newer');
  });

  it('uses chunk path as the tie-break for equal written_at metadata', async () => {
    await stats.upsertBook({ bookMd5: 'b1', title: 'b1', authors: '' });
    await stats.applyStatsFileChunk(
      't',
      '/a.json',
      [{ bookMd5: 'b1', title: 'Path A', authors: '' }],
      [],
      500,
    );
    await stats.applyStatsFileChunk(
      't',
      '/z.json',
      [{ bookMd5: 'b1', title: 'Path Z', authors: '' }],
      [],
      500,
    );
    await stats.applyStatsFileChunk(
      't',
      '/m.json',
      [{ bookMd5: 'b1', title: 'Path M', authors: '' }],
      [],
      500,
    );
    expect((await stats.getBookByMd5('b1'))!.title).toBe('Path Z');
  });

  it('protects a locally changed real field from older remote metadata', async () => {
    await seedBook(stats, 'b1', 'Local title', 'Local author');
    await stats.applyStatsFileChunk(
      't',
      '/remote-old.json',
      [{ bookMd5: 'b1', title: 'Remote old', authors: 'Remote old author' }],
      [],
      1000,
    );
    expect(await stats.getBookByMd5('b1')).toMatchObject({
      title: 'Local title',
      authors: 'Local author',
    });

    await stats.applyStatsFileChunk(
      't',
      '/remote-new.json',
      [{ bookMd5: 'b1', title: 'Remote new', authors: 'Remote new author' }],
      [],
      remoteClock(),
    );
    expect(await stats.getBookByMd5('b1')).toMatchObject({
      title: 'Remote new',
      authors: 'Remote new author',
    });
  });

  it('records an upload clock so an older peer title cannot erase it', async () => {
    const db = await freshStatsDb();
    const stats = StatisticsDb.from(db);
    await db.execute(
      `INSERT INTO book (title, authors, md5) VALUES ('Newest', 'Newest author', 'b1')`,
    );
    const outbound = await stats.getStatsFilePushBatch('t', 100);
    expect(outbound.books).toEqual([{ bookMd5: 'b1', title: 'Newest', authors: 'Newest author' }]);
    await stats.ackStatsFilePush('t', '/own-200.json', outbound.books, [], 200);

    await stats.applyStatsFileChunk(
      't',
      '/peer-100.json',
      [{ bookMd5: 'b1', title: 'Older', authors: 'Older author' }],
      [],
      100,
    );
    expect(await stats.getBookByMd5('b1')).toMatchObject({
      title: 'Newest',
      authors: 'Newest author',
    });
  });

  it('applies a remote chunk atomically, merges metadata, and marks it seen', async () => {
    const remoteAt = remoteClock();
    const id = await seedBook(stats, 'b1', 'Local title', 'Local author');
    await stats.insertPageEvent(id, event(1, 100, 10));

    await stats.applyStatsFileChunk(
      'target-a',
      '/remote/chunk-1.json',
      [{ bookMd5: 'b1', title: 'Remote title', authors: 'Remote author' }],
      [event(1, 100, 10), event(2, 110, 5)],
      remoteAt,
    );

    const book = await stats.getBookByMd5('b1');
    expect(book!.title).toBe('Remote title');
    expect(book!.total_read_time).toBe(15);
    expect(book!.total_read_pages).toBe(2);
    expect(await stats.getSeenStatsFileChunkPaths('target-a')).toEqual(
      new Set(['/remote/chunk-1.json']),
    );

    // Re-applying the same chunk (e.g. a retry after a crash) is idempotent.
    await stats.applyStatsFileChunk(
      'target-a',
      '/remote/chunk-1.json',
      [{ bookMd5: 'b1', title: 'Remote title', authors: 'Remote author' }],
      [event(1, 100, 10), event(2, 110, 5)],
      remoteAt,
    );
    expect((await stats.getBookByMd5('b1'))!.total_read_time).toBe(15);
  });

  it('never reduces duration and keeps totalPages tied to the longer duration', async () => {
    const id = await seedBook(stats, 'b1', 'Book', 'Author');
    await stats.insertPageEvent(id, event(1, 100, 30, 100));

    // Shorter remote snapshot cannot replace duration or its totalPages.
    await stats.applyStatsFileChunk('t', '/c1.json', [], [event(1, 100, 10, 50)]);
    let rows = await stats.getEventsForPush(-1);
    expect(rows.events[0]).toMatchObject({ duration: 30, totalPages: 100 });

    // Equal durations resolve totalPages deterministically to the max.
    await stats.applyStatsFileChunk('t', '/c2.json', [], [event(1, 100, 30, 60)]);
    rows = await stats.getEventsForPush(-1);
    expect(rows.events[0]).toMatchObject({ duration: 30, totalPages: 100 });

    // A longer duration brings its own totalPages.
    await stats.applyStatsFileChunk('t', '/c3.json', [], [event(1, 100, 40, 70)]);
    rows = await stats.getEventsForPush(-1);
    expect(rows.events[0]).toMatchObject({ duration: 40, totalPages: 70 });

    // And a later equal-duration tie cannot lower it.
    await stats.applyStatsFileChunk('t', '/c4.json', [], [event(1, 100, 40, 60)]);
    rows = await stats.getEventsForPush(-1);
    expect(rows.events[0]).toMatchObject({ duration: 40, totalPages: 70 });
  });

  it('does not acknowledge a larger local snapshot when a remote chunk is shorter', async () => {
    const id = await seedBook(stats);
    await stats.insertPageEvent(id, event(1, 100, 30, 100));
    const own = await stats.getStatsFilePushBatch('target-a', 100);
    await stats.ackStatsFilePush('target-a', '/own.json', own.books, own.events);

    await stats.applyStatsFileChunk('target-a', '/remote.json', [], [event(1, 100, 10, 50)]);

    const correction = await stats.getStatsFilePushBatch('target-a', 100);
    expect(correction.events).toHaveLength(1);
    expect(correction.events[0]).toMatchObject({ duration: 30, totalPages: 100 });
  });

  it('does not overwrite a real title with a hash placeholder', async () => {
    await seedBook(stats, 'b1', 'Real title', 'Real author');

    await stats.applyStatsFileChunk(
      'target-a',
      '/placeholder.json',
      [{ bookMd5: 'b1', title: 'b1', authors: '' }],
      [],
    );
    expect(await stats.getBookByMd5('b1')).toMatchObject({
      title: 'Real title',
      authors: 'Real author',
    });

    await stats.applyStatsFileChunk(
      'target-a',
      '/real.json',
      [{ bookMd5: 'b1', title: 'Remote title', authors: 'Remote author' }],
      [],
      remoteClock(),
    );
    expect(await stats.getBookByMd5('b1')).toMatchObject({
      title: 'Remote title',
      authors: 'Remote author',
    });

    await stats.applyStatsFileChunk(
      'target-a',
      '/placeholder-2.json',
      [{ bookMd5: 'b1', title: 'b1', authors: '' }],
      [],
    );
    expect(await stats.getBookByMd5('b1')).toMatchObject({
      title: 'Remote title',
      authors: 'Remote author',
    });
  });

  it('does not erase meaningful metadata with blank metadata or empty authors', async () => {
    await seedBook(stats, 'b1', 'Real title', 'Real author');

    // A real md5 with a blank title/authors record must not wipe local data.
    await stats.applyStatsFileChunk(
      'target-a',
      '/blank.json',
      [{ bookMd5: 'b1', title: '', authors: '' }],
      [],
    );
    expect(await stats.getBookByMd5('b1')).toMatchObject({
      title: 'Real title',
      authors: 'Real author',
    });

    // A real rename with blank authors replaces the title only.
    await stats.applyStatsFileChunk(
      'target-a',
      '/partial.json',
      [{ bookMd5: 'b1', title: 'Renamed', authors: '' }],
      [],
      remoteClock(),
    );
    expect(await stats.getBookByMd5('b1')).toMatchObject({
      title: 'Renamed',
      authors: 'Real author',
    });

    // A blank row can still be upgraded once real metadata arrives.
    await stats.applyStatsFileChunk(
      'target-a',
      '/blank-new.json',
      [{ bookMd5: 'b2', title: '', authors: '' }],
      [],
    );
    await stats.applyStatsFileChunk(
      'target-a',
      '/upgrade.json',
      [{ bookMd5: 'b2', title: 'Book two', authors: 'Author two' }],
      [],
      remoteClock(),
    );
    expect(await stats.getBookByMd5('b2')).toMatchObject({
      title: 'Book two',
      authors: 'Author two',
    });
  });

  it('creates a placeholder book for an event whose metadata is not in the chunk', async () => {
    await stats.applyStatsFileChunk('t', '/events-only.json', [], [event(1, 100, 8, 20, 'm2')]);
    const book = await stats.getBookByMd5('m2');
    expect(book).not.toBeNull();
    expect(book!.title).toBe('m2');
    expect(book!.authors).toBe('');
    expect(book!.total_read_time).toBe(8);
  });

  it('does not echo applied remote metadata back as a pending change', async () => {
    const id = await seedBook(stats, 'b1', 'Local', 'A');
    await stats.insertPageEvent(id, event(1, 100, 10));
    const own = await stats.getStatsFilePushBatch('t', 100);
    await stats.ackStatsFilePush('t', '/own.json', own.books, own.events);

    await stats.applyStatsFileChunk(
      't',
      '/remote.json',
      [{ bookMd5: 'b1', title: 'Remote', authors: 'A' }],
      [event(1, 100, 10)],
      remoteClock(),
    );

    expect(await stats.getStatsFilePushBatch('t', 100)).toEqual({ books: [], events: [] });
  });

  it('shares one transaction lock across official and file merges', async () => {
    const official = stats.applyRemoteEvents(
      [{ bookMd5: 'ro', title: 'RO', authors: '' }],
      [event(1, 400, 3, 10, 'ro')],
    );
    const fileMerge = stats.applyStatsFileChunk(
      'target-a',
      '/remote.json',
      [{ bookMd5: 'rf', title: 'RF', authors: '' }],
      [event(1, 401, 4, 10, 'rf')],
    );
    const ack = stats.ackStatsFilePush(
      'target-a',
      '/own.json',
      [{ bookMd5: 'ra', title: 'RA', authors: '' }],
      [event(1, 402, 5, 10, 'ra')],
    );

    await expect(Promise.all([official, fileMerge, ack])).resolves.toBeDefined();
    expect((await stats.getBookByMd5('ro'))!.total_read_time).toBe(3);
    expect((await stats.getBookByMd5('rf'))!.total_read_time).toBe(4);
    expect(await stats.getSeenStatsFileChunkPaths('target-a')).toEqual(
      new Set(['/remote.json', '/own.json']),
    );
  });
});
