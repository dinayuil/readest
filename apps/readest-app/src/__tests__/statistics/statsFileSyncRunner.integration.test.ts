import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NodeDatabaseService } from '@/services/database/nodeDatabaseService';
import { migrate } from '@/services/database/migrate';
import { getMigrations } from '@/services/database/migrations';
import type { DatabaseService } from '@/types/database';
import {
  FileSyncError,
  type FileEntry,
  type FileSyncProvider,
} from '@/services/sync/file/provider';
import { ancestorsOf } from '@/services/sync/file/layout';
import { StatisticsDb } from '@/services/statistics/statisticsDb';
import {
  decodeStatsFileChunk,
  encodeStatsFileChunk,
  type StatsFileChunk,
} from '@/services/statistics/statsFileWire';
import {
  statsFileChunkPath,
  statsFileRootPath,
  statsFileWriterPath,
} from '@/services/statistics/statsFileLayout';
import type { SystemSettings } from '@/types/settings';
import { useSettingsStore } from '@/store/settingsStore';
import { runFileStatsSyncForBackend } from '@/services/statistics/statsFileSyncRunner';

/** The smallest in-memory remote the real stats channel can talk to. */
class MemoryProvider implements FileSyncProvider {
  readonly rootPath = '/';
  readonly dirs = new Set<string>(['/']);
  readonly files = new Map<string, string>();

  private parent(path: string): string {
    const i = path.lastIndexOf('/');
    return i <= 0 ? '/' : path.slice(0, i);
  }

  async readText(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }
  async readBinary(): Promise<ArrayBuffer | null> {
    return null;
  }
  async head(): Promise<null> {
    return null;
  }
  async list(path: string): Promise<FileEntry[]> {
    if (!this.dirs.has(path)) throw new FileSyncError(`missing ${path}`, 'NOT_FOUND', 404);
    const out: FileEntry[] = [];
    for (const dir of this.dirs) {
      if (dir !== path && this.parent(dir) === path) {
        const name = dir.slice(path === '/' ? 1 : path.length + 1);
        out.push({ name, path: dir, isDirectory: true });
      }
    }
    for (const file of this.files.keys()) {
      if (this.parent(file) === path) {
        const name = file.slice(path === '/' ? 1 : path.length + 1);
        out.push({ name, path: file, isDirectory: false });
      }
    }
    return out;
  }
  async writeText(path: string, body: string): Promise<void> {
    this.files.set(path, body);
    for (const dir of ancestorsOf(path)) this.dirs.add(dir);
  }
  async writeBinary(): Promise<void> {}
  async ensureDir(paths: string[]): Promise<void> {
    for (const path of paths) this.dirs.add(path);
  }
  async deleteDir(): Promise<void> {}
}

async function freshStats(): Promise<StatisticsDb> {
  const db: DatabaseService = await NodeDatabaseService.open(':memory:');
  await migrate(db, getMigrations('statistics'));
  return StatisticsDb.from(db);
}

const envConfig = {
  getAppService: vi.fn(async () => ({ saveSettings: vi.fn() }) as never),
} as never;

const settings: SystemSettings = {
  version: 1,
  webdav: {
    enabled: true,
    serverUrl: 'https://dav.example.com/dav',
    username: 'reader',
    password: 'pw',
    rootPath: '/',
    strategy: 'silent',
    syncStats: true,
    deviceId: 'device-a',
  },
} as unknown as SystemSettings;

beforeEach(() => {
  vi.restoreAllMocks();
  useSettingsStore.getState().setSettings(settings);
});

describe('statistics runner over the real file channel', () => {
  test('pushes local history and then pulls it back into another database', async () => {
    const remote = new MemoryProvider();
    const a = await freshStats();
    const id = await a.upsertBook({ bookMd5: 'b1', title: 'Book', authors: 'A' });
    await a.insertPageEvent(id, { page: 1, startTime: 0, duration: 5, totalPages: 100 });
    const open = vi.spyOn(StatisticsDb, 'open').mockResolvedValue(a);

    const pushed = await runFileStatsSyncForBackend(envConfig, 'webdav', {
      provider: remote,
      deviceId: 'device-a',
    });

    expect(pushed.pushedChunks).toBe(1);
    expect(pushed.pushedEvents).toBe(1);
    expect(remote.files.size).toBe(1);
    const [chunkPath, body] = [...remote.files.entries()][0]!;
    expect(chunkPath.startsWith('/Readest/stats/v1/device-a/')).toBe(true);
    expect(decodeStatsFileChunk(body).events[0]).toMatchObject({ start_time: 0, duration: 5 });

    const b = await freshStats();
    open.mockResolvedValue(b);
    const pulled = await runFileStatsSyncForBackend(envConfig, 'webdav', {
      provider: remote,
      deviceId: 'device-b',
    });

    expect(pulled.pulledChunks).toBe(1);
    expect(pulled.pulledEvents).toBe(1);
    expect((await b.getBookByMd5('b1'))!.total_read_time).toBe(5);
  });

  test('stops before the next remote read when the switch flips mid-pass', async () => {
    const remote = new MemoryProvider();
    const root = statsFileRootPath('/');
    remote.ensureDir([root, statsFileWriterPath('/', 'w1'), statsFileWriterPath('/', 'w2')]);
    const chunk = (start: number): StatsFileChunk => ({
      v: 1,
      written_at: start,
      books: [{ book_hash: 'b1', title: 'Book', authors: 'A' }],
      events: [{ book_hash: 'b1', page: 1, start_time: start, duration: 5, total_pages: 100 }],
    });
    remote.writeText(statsFileChunkPath('/', 'w1', 'a'), encodeStatsFileChunk(chunk(100)));
    remote.writeText(statsFileChunkPath('/', 'w2', 'b'), encodeStatsFileChunk(chunk(200)));
    const filesBefore = remote.files.size;

    // Flip the opt-in as the first chunk arrives, i.e. between channel I/O
    // operations, not before the pass starts.
    const originalRead = remote.readText.bind(remote);
    let remoteReads = 0;
    remote.readText = async (path: string) => {
      const value = await originalRead(path);
      remoteReads += 1;
      if (remoteReads === 1) {
        useSettingsStore.getState().setSettings({
          ...settings,
          webdav: { ...settings.webdav!, syncStats: false },
        } as SystemSettings);
      }
      return value;
    };

    const b = await freshStats();
    vi.spyOn(StatisticsDb, 'open').mockResolvedValue(b);

    await expect(
      runFileStatsSyncForBackend(envConfig, 'webdav', {
        provider: remote,
        deviceId: 'device-b',
      }),
    ).rejects.toThrow();

    expect(remoteReads).toBe(1);
    expect(remote.files.size).toBe(filesBefore);
  });
});
