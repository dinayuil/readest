import type { AppService } from '@/types/system';
import type { DatabaseService, DatabaseRow } from '@/types/database';
import { DEFAULT_STATS_TRACKING_CONFIG } from '@/types/statistics';
import type { PageStatEvent, StatBook } from '@/types/statistics';

interface BookRow extends DatabaseRow {
  id: number;
  title: string;
  authors: string;
  md5: string;
  total_read_time: number;
  total_read_pages: number;
  last_open: number;
  pages: number;
}

type CursorKey = 'push' | 'pull' | 'bookorbit-push' | `grimmory-push:${string}`;

// Readest caps one page visit at this, so a longer event spans several pages
// (a CrossPoint session recorded in whole percents) and says nothing about pace.
const MAX_PAGE_SECONDS = DEFAULT_STATS_TRACKING_CONFIG.maxEventSeconds;

/** Sentinel path for clocks advanced by a local metadata edit (not a chunk). */
const LOCAL_METADATA_CLOCK_PATH = 'local';

const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * KOReader's `UNIQUE(title, authors, md5)` permits several `book` rows for one
 * md5 when an imported history carries different metadata versions. File-sync
 * identity is the md5, so every push-batch query uses this one deterministic
 * representative per hash: a real title beats a blank/hash placeholder, then
 * the lowest row id. Duplicate rows must not make metadata acknowledgements
 * alternate forever between titles.
 */
const STATS_FILE_BOOK_REP_CTE = `book_rep AS (
  SELECT id, md5, title, authors,
         ROW_NUMBER() OVER (
           PARTITION BY md5
           ORDER BY CASE
             WHEN title IS NULL OR trim(title) = '' OR trim(title) = trim(md5) THEN 1
             ELSE 0
           END,
           id ASC
         ) AS rn
  FROM book
  WHERE md5 IS NOT NULL AND trim(md5) <> ''
)`;

/**
 * Per-tab singleton open promise. OPFS permits only ONE access handle per file
 * across the whole origin, so a second `connect()` to statistics.db throws
 * `NoModificationAllowedError`. Every ReadingStatsTracker instance (and split-
 * view books) must therefore share a single connection — we memoise the open
 * and never thrash it.
 */
let sharedDb: Promise<StatisticsDb> | null = null;
let lifecycleBound = false;

function bindLifecycle(): void {
  if (lifecycleBound || typeof document === 'undefined') return;
  lifecycleBound = true;
  // Fold the WAL into the main db when the tab is backgrounded/closed — the
  // most reliable point for best-effort async OPFS work before teardown.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && sharedDb) {
      void sharedDb.then((s) => s.checkpoint()).catch(() => {});
    }
  });
}

/**
 * Typed wrapper over the KOReader-compatible `statistics.db`. All identity is
 * keyed on `book_hash` (= Book.hash); the local autoincrement `id_book` never
 * leaves this class.
 */
export class StatisticsDb {
  // One write gate for single-statement local writes and multi-statement
  // transactions (official pulls, file chunk applies, acks). A local insert
  // issued while a transaction is open must wait for COMMIT/ROLLBACK rather
  // than join that transaction and disappear with a rollback (Sentry READEST-N
  // for the nested-BEGIN sibling bug).
  private writeGate: Promise<void> = Promise.resolve();

  private constructor(private readonly db: DatabaseService) {}

  /** Production entry point — opens + migrates statistics.db (per-tab singleton). */
  static async open(appService: AppService): Promise<StatisticsDb> {
    bindLifecycle();
    if (!sharedDb) {
      const opening = (async () => {
        const db = await appService.openDatabase('statistics', 'statistics.db', 'Data');
        return new StatisticsDb(db);
      })();
      sharedDb = opening;
      void opening.catch(() => {
        if (sharedDb === opening) sharedDb = null;
      });
    }
    return sharedDb;
  }

  /** Test/advanced entry point — wrap an already-migrated DatabaseService. */
  static from(db: DatabaseService): StatisticsDb {
    return new StatisticsDb(db);
  }

  /**
   * Queue one write unit behind the shared write gate. The unit may be a
   * single statement or a transaction; nothing nested may call this again.
   */
  private async withWriteGate<T>(run: () => Promise<T>): Promise<T> {
    const previous = this.writeGate;
    let release!: () => void;
    this.writeGate = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      return await run();
    } finally {
      release();
    }
  }

  /**
   * Run one transaction under the shared write gate. Every multi-statement
   * write goes through here; transaction internals use only `*Unlocked`
   * helpers so they can never deadlock on the gate they already hold.
   */
  private async withTransaction<T>(run: () => Promise<T>): Promise<T> {
    return this.withWriteGate(async () => {
      await this.db.execute('BEGIN');
      try {
        const result = await run();
        await this.db.execute('COMMIT');
        return result;
      } catch (err) {
        await this.db.execute('ROLLBACK');
        throw err;
      }
    });
  }

  /**
   * Fold the WAL into the main db file and truncate it. The Turso engine does
   * NOT implement `PRAGMA wal_autocheckpoint` (so there's no auto threshold to
   * rely on), but `wal_checkpoint(TRUNCATE)` works — verified folding a 688 KB
   * WAL back to 0 B. We call this when the tab is hidden so the WAL stays bounded.
   */
  async checkpoint(): Promise<void> {
    await this.db.execute('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  /** Checkpoint, close the underlying connection, and reset the singleton. */
  async close(): Promise<void> {
    try {
      await this.checkpoint();
    } catch {
      // best-effort — a checkpoint failure must not block close
    }
    await this.db.close();
    sharedDb = null;
  }

  async upsertBook(book: StatBook): Promise<number> {
    return this.withWriteGate(async () => {
      const rows = await this.db.select<DatabaseRow>(
        `SELECT id, title, authors FROM book WHERE md5 = ? LIMIT 1`,
        [book.bookMd5],
      );
      const previous = rows[0];
      const id = await this.upsertBookUnlocked(book);

      // A real local edit advances that field's remote clock, but only when
      // the value actually changed. Repeating the same metadata (tracker open)
      // must not create a timestamp ping-pong against peers.
      const now = Date.now();
      if (
        this.isRealStatsTitle(book.bookMd5, book.title) &&
        asText(previous?.['title']) !== book.title
      ) {
        await this.touchBookFieldClock(book.bookMd5, 'title', now, LOCAL_METADATA_CLOCK_PATH);
      }
      if (book.authors.trim().length > 0 && asText(previous?.['authors']) !== book.authors) {
        await this.touchBookFieldClock(book.bookMd5, 'authors', now, LOCAL_METADATA_CLOCK_PATH);
      }
      return id;
    });
  }

  /** Raw book upsert; callers must already hold the write gate. */
  private async upsertBookUnlocked(book: StatBook): Promise<number> {
    const existing = await this.db.select<BookRow>(`SELECT id FROM book WHERE md5 = ? LIMIT 1`, [
      book.bookMd5,
    ]);
    if (existing[0]) {
      // md5 is the identity; keep the latest title/authors (LWW, matches server stat_books).
      await this.db.execute(`UPDATE book SET title = ?, authors = ? WHERE id = ?`, [
        book.title,
        book.authors,
        existing[0].id,
      ]);
      return existing[0].id;
    }
    await this.db.execute(
      `INSERT INTO book (title, authors, md5, notes, last_open, highlights, pages, total_read_time, total_read_pages)
       VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0)
       ON CONFLICT(title, authors, md5) DO NOTHING`,
      [book.title, book.authors, book.bookMd5],
    );
    const rows = await this.db.select<BookRow>(`SELECT id FROM book WHERE md5 = ? LIMIT 1`, [
      book.bookMd5,
    ]);
    return rows[0]!.id;
  }

  async insertPageEvent(
    idBook: number,
    e: { page: number; startTime: number; duration: number; totalPages: number },
  ): Promise<void> {
    await this.withWriteGate(() => this.insertPageEventUnlocked(idBook, e));
  }

  private async insertPageEventUnlocked(
    idBook: number,
    e: { page: number; startTime: number; duration: number; totalPages: number },
  ): Promise<void> {
    await this.db.execute(
      `INSERT INTO page_stat_data (id_book, page, start_time, duration, total_pages)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id_book, page, start_time)
       DO UPDATE SET duration = max(duration, excluded.duration), total_pages = excluded.total_pages`,
      [idBook, e.page, e.startTime, e.duration, e.totalPages],
    );
  }

  async recomputeBookTotals(idBook: number): Promise<void> {
    await this.withWriteGate(() => this.recomputeBookTotalsUnlocked(idBook));
  }

  private async recomputeBookTotalsUnlocked(idBook: number): Promise<void> {
    await this.db.execute(
      `UPDATE book SET
         total_read_time  = COALESCE((SELECT SUM(duration) FROM page_stat_data WHERE id_book = ?), 0),
         total_read_pages = COALESCE((SELECT COUNT(DISTINCT page) FROM page_stat_data WHERE id_book = ?), 0),
         last_open        = COALESCE((SELECT MAX(start_time + duration) FROM page_stat_data WHERE id_book = ?), last_open),
         pages            = COALESCE((SELECT total_pages FROM page_stat_data WHERE id_book = ? ORDER BY start_time DESC LIMIT 1), pages)
       WHERE id = ?`,
      [idBook, idBook, idBook, idBook, idBook],
    );
  }

  /**
   * Returns the median duration of time spent on each page in seconds. Returns
   * `null` if sufficient data is not available.
   *
   * Use the median since reading times are skewed; thus the median must be
   * used to get the middle value.
   */
  async getMedianPageDurationSecs(idBook: number): Promise<number | null> {
    const PAGE_THRESHOLD = 5;
    const rows = await this.db.select<{ duration: number }>(
      `SELECT duration
         FROM page_stat_data
         WHERE id_book = ? AND duration <= ?
         ORDER BY start_time DESC, page DESC
         LIMIT 50`,
      [idBook, MAX_PAGE_SECONDS],
    );
    if (rows.length < PAGE_THRESHOLD) return null;
    // The query orders by recency; sort by value so the middle is the true median.
    const pageDurations = rows.map((d) => d['duration']).sort((a, b) => a - b);
    const mid = Math.floor(pageDurations.length / 2);
    return pageDurations.length % 2 !== 0
      ? (pageDurations[mid] ?? 0)
      : ((pageDurations[mid - 1] ?? 0) + (pageDurations[mid] ?? 0)) / 2;
  }

  /** Load shelf paces in one query, using the same last-50 sample as book labels. */
  async getMedianPageDurationsSecs(): Promise<Record<string, number>> {
    const rows = await this.db.select<{ md5: string; duration: number }>(
      `SELECT md5, duration FROM (
         SELECT b.md5, p.duration,
           ROW_NUMBER() OVER (PARTITION BY p.id_book ORDER BY p.start_time DESC, p.page DESC) AS recency
         FROM page_stat_data p JOIN book b ON b.id = p.id_book
         WHERE p.duration <= ?
       ) WHERE recency <= 50 ORDER BY md5, duration`,
      [MAX_PAGE_SECONDS],
    );
    const samples = new Map<string, number[]>();
    for (const { md5, duration } of rows) {
      const durations = samples.get(md5) ?? [];
      durations.push(duration);
      samples.set(md5, durations);
    }
    const medians: Record<string, number> = {};
    for (const [md5, durations] of samples) {
      if (durations.length < 5) continue;
      const mid = Math.floor(durations.length / 2);
      medians[md5] =
        durations.length % 2 ? durations[mid]! : (durations[mid - 1]! + durations[mid]!) / 2;
    }
    return medians;
  }

  /**
   * Seconds read in each quarter hour (`start_time / 900`). Every UTC offset is
   * a multiple of 15 minutes, so callers can fold these into local days in JS
   * instead of trusting SQL `localtime` to know the host's time zone.
   */
  async getQuarterHourDurations(): Promise<{ quarter: number; seconds: number }[]> {
    return this.db.select<{ quarter: number; seconds: number }>(
      `SELECT start_time / 900 AS quarter, SUM(duration) AS seconds
       FROM page_stat_data GROUP BY quarter ORDER BY quarter`,
    );
  }

  async getReadingTotals(): Promise<{ seconds: number; books: number; pages: number }> {
    const rows = await this.db.select<{ seconds: number; books: number; pages: number }>(
      `SELECT COALESCE(SUM(duration), 0) AS seconds,
              COUNT(DISTINCT id_book) AS books,
              COUNT(DISTINCT id_book || '-' || page) AS pages
       FROM page_stat_data`,
    );
    return rows[0] ?? { seconds: 0, books: 0, pages: 0 };
  }

  async getBookByMd5(md5: string): Promise<BookRow | null> {
    const rows = await this.db.select<BookRow>(`SELECT * FROM book WHERE md5 = ? LIMIT 1`, [md5]);
    return rows[0] ?? null;
  }

  /**
   * Ensure a book row exists for an event whose metadata record isn't in the
   * current batch (paged pull can deliver an event before its `stat_books`
   * record). Unlike `upsertBook`, this NEVER overwrites an existing real title
   * with the hash placeholder — the real record, arriving in any page, wins.
   */
  private async ensureBookIdUnlocked(bookMd5: string): Promise<number> {
    const existing = await this.db.select<BookRow>(`SELECT id FROM book WHERE md5 = ? LIMIT 1`, [
      bookMd5,
    ]);
    if (existing[0]) return existing[0].id;
    return this.upsertBookUnlocked({ bookMd5, title: bookMd5, authors: '' });
  }

  /** Events with start_time > cursor, joined to their md5, for pushing. */
  async getEventsForPush(
    sinceStartTime: number,
  ): Promise<{ events: PageStatEvent[]; books: StatBook[] }> {
    const rows = await this.db.select<DatabaseRow>(
      `SELECT b.md5 AS bookMd5, b.title AS title, b.authors AS authors,
              p.page AS page, p.start_time AS startTime, p.duration AS duration, p.total_pages AS totalPages
       FROM page_stat_data p JOIN book b ON b.id = p.id_book
       WHERE p.start_time > ?
       ORDER BY p.start_time ASC`,
      [sinceStartTime],
    );
    const events: PageStatEvent[] = rows.map((r) => ({
      bookMd5: String(r['bookMd5']),
      page: Number(r['page']),
      startTime: Number(r['startTime']),
      duration: Number(r['duration']),
      totalPages: Number(r['totalPages']),
    }));
    const bookMap = new Map<string, StatBook>();
    for (const r of rows) {
      const md5 = String(r['bookMd5']);
      if (!bookMap.has(md5)) {
        bookMap.set(md5, {
          bookMd5: md5,
          title: asText(r['title']),
          authors: asText(r['authors']),
        });
      }
    }
    return { events, books: [...bookMap.values()] };
  }

  async applyRemoteEvents(books: StatBook[], events: PageStatEvent[]): Promise<void> {
    if (books.length === 0 && events.length === 0) return;
    // One transaction for the whole pulled batch: a single commit instead of
    // O(rows) fsyncs, and the apply is atomic (a failed pull leaves no partial
    // state). Critical when a fresh device backfills tens of thousands of rows.
    await this.withTransaction(async () => {
      const idByMd5 = new Map<string, number>();
      for (const b of books) idByMd5.set(b.bookMd5, await this.upsertBookUnlocked(b));
      // Books referenced only by events (no metadata record) get a placeholder row.
      const touched = new Set<number>();
      for (const e of events) {
        let id = idByMd5.get(e.bookMd5);
        if (id === undefined) {
          id = await this.ensureBookIdUnlocked(e.bookMd5);
          idByMd5.set(e.bookMd5, id);
        }
        await this.insertPageEventUnlocked(id, e);
        touched.add(id);
      }
      for (const id of touched) await this.recomputeBookTotalsUnlocked(id);
    });
  }

  /**
   * Next bounded batch of local state that a stats-file target has not
   * acknowledged yet.
   *
   * Confirmation is a durable snapshot, not a time cursor: any event is
   * pending when the target has no ack row for its identity, or its duration /
   * total_pages differ from the acknowledged snapshot. That covers a first
   * backfill (including startTime 0), imported older history, duration growth,
   * and total_pages corrections. Books whose title/authors changed are also
   * returned without events, and every event's book metadata rides along.
   *
   * Imported KOReader databases may hold several `book` rows for one md5 and
   * duplicate page rows for one logical event identity. Both queries collapse
   * those to one deterministic representative per hash and one max-duration
   * snapshot per (hash, page, start_time) before comparing against the ack,
   * so a batch always drains instead of alternating between duplicate rows.
   */
  async getStatsFilePushBatch(
    targetId: string,
    maxEvents: number,
  ): Promise<{ books: StatBook[]; events: PageStatEvent[] }> {
    const limit = Number.isFinite(maxEvents) ? Math.max(0, Math.floor(maxEvents)) : 0;
    if (limit === 0) return { books: [], events: [] };

    const rows = await this.db.select<DatabaseRow>(
      `WITH ${STATS_FILE_BOOK_REP_CTE},
       event_rep AS (
         SELECT b.md5 AS book_hash, p.page AS page, p.start_time AS start_time,
                p.duration AS duration, p.total_pages AS total_pages,
                ROW_NUMBER() OVER (
                  PARTITION BY b.md5, p.page, p.start_time
                  ORDER BY p.duration DESC, p.total_pages DESC, b.id ASC
                ) AS rn
         FROM page_stat_data p
         JOIN book b ON b.id = p.id_book
         WHERE b.md5 IS NOT NULL AND trim(b.md5) <> ''
           AND typeof(p.page) = 'integer' AND p.page >= 0
           AND p.page <= ${Number.MAX_SAFE_INTEGER}
           AND typeof(p.start_time) = 'integer' AND p.start_time >= 0
           AND p.start_time <= ${Number.MAX_SAFE_INTEGER}
           AND typeof(p.duration) = 'integer' AND p.duration >= 0
           AND p.duration <= ${Number.MAX_SAFE_INTEGER}
           AND typeof(p.total_pages) = 'integer' AND p.total_pages >= 0
           AND p.total_pages <= ${Number.MAX_SAFE_INTEGER}
       )
       SELECT e.book_hash AS bookMd5, br.title AS title, br.authors AS authors,
              e.page AS page, e.start_time AS startTime, e.duration AS duration,
              e.total_pages AS totalPages
       FROM event_rep e
       JOIN book_rep br ON br.md5 = e.book_hash AND br.rn = 1
       LEFT JOIN readest_stat_file_event_ack a
         ON a.target_id = ? AND a.book_hash = e.book_hash
        AND a.page = e.page AND a.start_time = e.start_time
       WHERE e.rn = 1
         AND (a.book_hash IS NULL OR a.duration <> e.duration OR a.total_pages <> e.total_pages)
       ORDER BY e.start_time ASC, e.book_hash ASC, e.page ASC
       LIMIT ?`,
      [targetId, limit],
    );

    const events: PageStatEvent[] = rows.map((row) => ({
      bookMd5: asText(row['bookMd5']),
      page: Number(row['page']),
      startTime: Number(row['startTime']),
      duration: Number(row['duration']),
      totalPages: Number(row['totalPages']),
    }));
    const booksByHash = new Map<string, StatBook>();
    for (const row of rows) {
      const bookMd5 = asText(row['bookMd5']);
      if (booksByHash.has(bookMd5)) continue;
      booksByHash.set(bookMd5, {
        bookMd5,
        title: asText(row['title']),
        authors: asText(row['authors']),
      });
    }

    const remaining = limit - booksByHash.size;
    if (remaining > 0) {
      // Book-level confirmations are independent of event-level ones, so a
      // book may already be in `booksByHash` through an event while its
      // metadata still changed. Exclude those hashes rather than letting them
      // consume the metadata-only LIMIT and starve other books.
      const includedHashes = [...booksByHash.keys()];
      const exclusions = includedHashes.length
        ? ` AND b.md5 NOT IN (${includedHashes.map(() => '?').join(', ')})`
        : '';
      const metadataRows = await this.db.select<DatabaseRow>(
        `WITH ${STATS_FILE_BOOK_REP_CTE}
         SELECT b.md5 AS bookMd5, b.title AS title, b.authors AS authors
         FROM book_rep b
         LEFT JOIN readest_stat_file_book_ack a ON a.target_id = ? AND a.book_hash = b.md5
         WHERE b.rn = 1
           AND (a.book_hash IS NULL OR a.title <> b.title OR a.authors <> b.authors)${exclusions}
         ORDER BY b.md5 ASC
         LIMIT ?`,
        [targetId, ...includedHashes, remaining],
      );
      for (const row of metadataRows) {
        if (booksByHash.size >= limit) break;
        const bookMd5 = asText(row['bookMd5']);
        if (booksByHash.has(bookMd5)) continue;
        booksByHash.set(bookMd5, {
          bookMd5,
          title: asText(row['title']),
          authors: asText(row['authors']),
        });
      }
    }

    return { books: [...booksByHash.values()], events };
  }

  /**
   * Mark an own immutable chunk path seen before its PUT. A retry after a
   * failed ack must not pull back the stale snapshot we already wrote, while
   * unacknowledged snapshots still retry through a new chunk. A failed PUT
   * leaves only this harmless seen marker.
   */
  async beginStatsFilePush(targetId: string, chunkPath: string): Promise<void> {
    await this.withTransaction(async () => {
      await this.markStatsFileChunkSeen(targetId, chunkPath, Date.now());
    });
  }

  /**
   * Confirm the exact snapshots that a successful PUT uploaded and mark the
   * immutable chunk as seen. Storing the snapshots passed in (not current
   * local values) is what leaves a tracker write made during the PUT pending
   * for the next run.
   *
   * With an upload `writtenAt`, also advance each book field's file clock when
   * the local field still matches the uploaded snapshot. This stops an older
   * peer chunk from erasing a newer local upload, while a title changed during
   * the PUT is not marked as uploaded.
   */
  async ackStatsFilePush(
    targetId: string,
    chunkPath: string,
    books: StatBook[],
    events: PageStatEvent[],
    writtenAt?: number,
  ): Promise<void> {
    await this.withTransaction(async () => {
      const now = Date.now();
      for (const book of books) await this.ackBookSnapshot(targetId, book, now);
      for (const event of events) await this.ackEventSnapshot(targetId, event, now);
      await this.markStatsFileChunkSeen(targetId, chunkPath, now);
      if (writtenAt !== undefined) {
        for (const book of books) {
          const current = await this.readRepresentativeBookUnlocked(book.bookMd5);
          if (!current) continue;
          if (
            this.isRealStatsTitle(book.bookMd5, book.title) &&
            asText(current['title']) === book.title
          ) {
            await this.touchBookFieldClock(book.bookMd5, 'title', writtenAt, chunkPath);
          }
          if (book.authors.trim().length > 0 && asText(current['authors']) === book.authors) {
            await this.touchBookFieldClock(book.bookMd5, 'authors', writtenAt, chunkPath);
          }
        }
      }
    });
  }

  async getSeenStatsFileChunkPaths(targetId: string): Promise<Set<string>> {
    const rows = await this.db.select<{ chunk_path: string }>(
      `SELECT chunk_path FROM readest_stat_file_seen WHERE target_id = ?`,
      [targetId],
    );
    return new Set(rows.map((row) => row.chunk_path));
  }

  /**
   * Merge one immutable remote chunk and confirm exactly what it carried.
   *
   * Merge policy:
   * - events only ever grow duration; total_pages follows the longer duration,
   *   and an equal-duration tie picks max(total_pages);
   * - title and authors each merge independently: a non-real incoming field is
   *   ignored without advancing its clock, a real field fills a blank/hash
   *   local field even from an older chunk, and two real fields are ordered by
   *   the per-book (written_at, chunk_path) clock so a late old chunk cannot
   *   erase newer metadata.
   *
   * The confirmation rows use the chunk's snapshots, not the merged maxima:
   * when a shorter remote chunk arrives over a longer local event, or an older
   * chunk carries metadata we did not merge, the local values stay pending so
   * this device can push the correction. Everything, including the seen
   * marker, commits atomically.
   */
  async applyStatsFileChunk(
    targetId: string,
    chunkPath: string,
    books: StatBook[],
    events: PageStatEvent[],
    writtenAt = 0,
  ): Promise<void> {
    await this.withTransaction(async () => {
      const now = Date.now();
      const idByMd5 = new Map<string, number>();
      for (const book of books) {
        idByMd5.set(book.bookMd5, await this.mergeStatsBook(book, writtenAt, chunkPath));
      }
      const touched = new Set<number>();
      for (const event of events) {
        let id = idByMd5.get(event.bookMd5);
        if (id === undefined) {
          id = await this.ensureBookIdUnlocked(event.bookMd5);
          idByMd5.set(event.bookMd5, id);
        }
        await this.mergeStatsPageEvent(id, event);
        touched.add(id);
      }
      for (const id of touched) await this.recomputeBookTotalsUnlocked(id);
      for (const book of books) await this.ackBookSnapshot(targetId, book, now);
      for (const event of events) await this.ackEventSnapshot(targetId, event, now);
      await this.markStatsFileChunkSeen(targetId, chunkPath, now);
    });
  }

  /** Deterministic representative row used for file-sync metadata. */
  private async readRepresentativeBookUnlocked(bookMd5: string): Promise<DatabaseRow | null> {
    const rows = await this.db.select<DatabaseRow>(
      `SELECT id, title, authors FROM book WHERE md5 = ?
       ORDER BY CASE
         WHEN title IS NULL OR trim(title) = '' OR trim(title) = trim(md5) THEN 1
         ELSE 0
       END, id ASC
       LIMIT 1`,
      [bookMd5],
    );
    return rows[0] ?? null;
  }

  /** Apply file-channel metadata field by field using its own clock. */
  private async mergeStatsBook(
    book: StatBook,
    writtenAt: number,
    chunkPath: string,
  ): Promise<number> {
    const existing = await this.readRepresentativeBookUnlocked(book.bookMd5);
    const clock = await this.readBookFieldClockUnlocked(book.bookMd5);
    const currentTitle = asText(existing?.['title']);
    const currentAuthors = asText(existing?.['authors']);
    let nextTitle = currentTitle;
    let nextAuthors = currentAuthors;

    if (this.isRealStatsTitle(book.bookMd5, book.title)) {
      const localReal = this.isRealStatsTitle(book.bookMd5, currentTitle);
      if (
        !localReal ||
        this.isNewerFileField(clock?.titleAt, clock?.titlePath, writtenAt, chunkPath)
      ) {
        nextTitle = book.title;
        await this.touchBookFieldClock(book.bookMd5, 'title', writtenAt, chunkPath);
      }
    }
    if (book.authors.trim().length > 0) {
      const localReal = currentAuthors.trim().length > 0;
      if (
        !localReal ||
        this.isNewerFileField(clock?.authorsAt, clock?.authorsPath, writtenAt, chunkPath)
      ) {
        nextAuthors = book.authors;
        await this.touchBookFieldClock(book.bookMd5, 'authors', writtenAt, chunkPath);
      }
    }

    if (!existing) {
      return this.upsertBookUnlocked({
        bookMd5: book.bookMd5,
        title: nextTitle,
        authors: nextAuthors,
      });
    }
    if (nextTitle !== currentTitle || nextAuthors !== currentAuthors) {
      await this.db.execute(`UPDATE book SET title = ?, authors = ? WHERE id = ?`, [
        nextTitle,
        nextAuthors,
        existing['id'],
      ]);
    }
    return Number(existing['id']);
  }

  /** True when a title carries information beyond a hash/blank placeholder. */
  private isRealStatsTitle(bookMd5: string, title: string | null): boolean {
    const trimmed = (title ?? '').trim();
    return trimmed.length > 0 && trimmed !== bookMd5.trim();
  }

  private async readBookFieldClockUnlocked(bookHash: string): Promise<{
    titleAt: number;
    titlePath: string;
    authorsAt: number;
    authorsPath: string;
  } | null> {
    const rows = await this.db.select<DatabaseRow>(
      `SELECT title_at, title_path, authors_at, authors_path
       FROM readest_stat_file_book_clock WHERE book_hash = ?`,
      [bookHash],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      titleAt: Number(row['title_at']),
      titlePath: asText(row['title_path']),
      authorsAt: Number(row['authors_at']),
      authorsPath: asText(row['authors_path']),
    };
  }

  private isNewerFileField(
    clockAt: number | undefined,
    clockPath: string | undefined,
    writtenAt: number,
    chunkPath: string,
  ): boolean {
    if (clockAt === undefined) return true;
    if (writtenAt !== clockAt) return writtenAt > clockAt;
    return chunkPath > (clockPath ?? '');
  }

  /** Advance one field's clock, never regressing; non-real fields skip this. */
  private async touchBookFieldClock(
    bookHash: string,
    field: 'title' | 'authors',
    writtenAt: number,
    chunkPath: string,
  ): Promise<void> {
    const atColumn = field === 'title' ? 'title_at' : 'authors_at';
    const pathColumn = field === 'title' ? 'title_path' : 'authors_path';
    const otherAt = field === 'title' ? 'authors_at' : 'title_at';
    const otherPath = field === 'title' ? 'authors_path' : 'title_path';
    await this.db.execute(
      `INSERT INTO readest_stat_file_book_clock
         (book_hash, ${atColumn}, ${pathColumn}, ${otherAt}, ${otherPath})
       VALUES (?, ?, ?, 0, '')
       ON CONFLICT(book_hash) DO UPDATE SET
         ${atColumn} = CASE
           WHEN excluded.${atColumn} > ${atColumn}
             OR (excluded.${atColumn} = ${atColumn} AND excluded.${pathColumn} > ${pathColumn})
           THEN excluded.${atColumn} ELSE ${atColumn} END,
         ${pathColumn} = CASE
           WHEN excluded.${atColumn} > ${atColumn}
             OR (excluded.${atColumn} = ${atColumn} AND excluded.${pathColumn} > ${pathColumn})
           THEN excluded.${pathColumn} ELSE ${pathColumn} END`,
      [bookHash, writtenAt, chunkPath],
    );
  }

  /**
   * File-channel merge: never reduce duration; keep total_pages associated
   * with the longer duration; resolve equal-duration total_pages ties with
   * max() so repeated pulls in different orders converge.
   */
  private async mergeStatsPageEvent(idBook: number, e: PageStatEvent): Promise<void> {
    await this.db.execute(
      `INSERT INTO page_stat_data (id_book, page, start_time, duration, total_pages)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id_book, page, start_time) DO UPDATE SET
         total_pages = CASE
           WHEN excluded.duration > duration THEN excluded.total_pages
           WHEN excluded.duration < duration THEN total_pages
           ELSE max(total_pages, excluded.total_pages)
         END,
         duration = max(duration, excluded.duration)`,
      [idBook, e.page, e.startTime, e.duration, e.totalPages],
    );
  }

  private async ackBookSnapshot(targetId: string, book: StatBook, ackedAt: number) {
    await this.db.execute(
      `INSERT INTO readest_stat_file_book_ack (target_id, book_hash, title, authors, acked_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(target_id, book_hash) DO UPDATE SET
         title = excluded.title, authors = excluded.authors, acked_at = excluded.acked_at`,
      [targetId, book.bookMd5, book.title, book.authors, ackedAt],
    );
  }

  private async ackEventSnapshot(targetId: string, event: PageStatEvent, ackedAt: number) {
    await this.db.execute(
      `INSERT INTO readest_stat_file_event_ack (target_id, book_hash, page, start_time, duration, total_pages, acked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(target_id, book_hash, page, start_time) DO UPDATE SET
         duration = excluded.duration, total_pages = excluded.total_pages,
         acked_at = excluded.acked_at`,
      [
        targetId,
        event.bookMd5,
        event.page,
        event.startTime,
        event.duration,
        event.totalPages,
        ackedAt,
      ],
    );
  }

  private async markStatsFileChunkSeen(
    targetId: string,
    chunkPath: string,
    seenAt: number,
  ): Promise<void> {
    await this.db.execute(
      `INSERT INTO readest_stat_file_seen (target_id, chunk_path, seen_at) VALUES (?, ?, ?)
       ON CONFLICT(target_id, chunk_path) DO UPDATE SET seen_at = excluded.seen_at`,
      [targetId, chunkPath, seenAt],
    );
  }

  async getCursor(key: CursorKey): Promise<number> {
    const rows = await this.db.select<{ value: number }>(
      `SELECT value FROM readest_stat_sync_state WHERE key = ?`,
      [key],
    );
    return rows[0]?.value ?? 0;
  }

  async setCursor(key: CursorKey, value: number): Promise<void> {
    await this.withWriteGate(() => this.setCursorUnlocked(key, value));
  }

  private async setCursorUnlocked(key: CursorKey, value: number): Promise<void> {
    await this.db.execute(
      `INSERT INTO readest_stat_sync_state (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  }
}
