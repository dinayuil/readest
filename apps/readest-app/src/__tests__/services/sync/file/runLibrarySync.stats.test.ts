import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { SystemSettings } from '@/types/settings';

const mocks = vi.hoisted(() => ({
  provider: { rootPath: '/', tag: 'same-provider' },
  syncLibrary: vi.fn(),
  runStats: vi.fn(),
  recordLibraryPassFailure: vi.fn(),
  saveSettings: vi.fn(),
}));

vi.mock('@/services/sync/file/providerRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/sync/file/providerRegistry')>();
  return { ...actual, createFileSyncProvider: vi.fn(async () => mocks.provider) };
});
vi.mock('@/services/sync/file/appLocalStore', () => ({
  createAppLocalStore: vi.fn(() => ({}) as never),
}));
vi.mock('@/services/sync/file/engine', () => ({
  FileSyncEngine: vi.fn(function (this: Record<string, unknown>) {
    this['syncLibrary'] = mocks.syncLibrary;
  }),
}));
vi.mock('@/services/statistics/statsFileSyncRunner', () => ({
  runFileStatsSyncForBackend: mocks.runStats,
}));
vi.mock('@/services/sync/file/runLibrarySync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/sync/file/runLibrarySync')>();
  return { ...actual, recordLibraryPassFailure: mocks.recordLibraryPassFailure };
});

import { runFileLibrarySyncPass } from '@/services/sync/file/runLibrarySync';
import { useFileSyncStore } from '@/store/fileSyncStore';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';
import type { Book } from '@/types/book';

const syncResult = (over: Record<string, unknown> = {}) => ({
  totalBooks: 1,
  booksSynced: 1,
  failures: 0,
  failedBooks: [],
  indexPushFailed: false,
  configsUploaded: 1,
  configsDownloaded: 0,
  filesUploaded: 0,
  ...over,
});

const settings = (over: Partial<SystemSettings['webdav']> = {}): SystemSettings =>
  ({
    version: 1,
    webdav: {
      enabled: true,
      serverUrl: 'https://dav.example.com/dav',
      username: 'reader',
      password: 'pw',
      rootPath: '/',
      strategy: 'silent',
      syncBooks: false,
      syncStats: true,
      deviceId: 'device-a',
      ...over,
    },
  }) as SystemSettings;

const envConfig = {
  getAppService: vi.fn(async () => ({ saveSettings: mocks.saveSettings }) as never),
} as never;

const translationFn = (key: string, params?: Record<string, string | number>) =>
  params
    ? Object.entries(params).reduce((acc, [k, v]) => acc.replace(`{{${k}}}`, String(v)), key)
    : key;

const book = (hash: string): Book => ({
  hash,
  format: 'EPUB',
  title: `Book ${hash}`,
  sourceTitle: `Book ${hash}`,
  author: 'A',
  createdAt: 1,
  updatedAt: 1,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.syncLibrary.mockResolvedValue(syncResult());
  mocks.runStats.mockResolvedValue({
    pulledChunks: 1,
    pulledEvents: 2,
    pushedChunks: 1,
    pushedEvents: 2,
  });
  mocks.saveSettings.mockResolvedValue(undefined);
  useSettingsStore.getState().setSettings(settings());
  useLibraryStore.setState({ library: [book('h1')], libraryLoaded: true } as never);
  useFileSyncStore.setState({ byKind: {}, activeKind: null, lastErrorByKind: {} });
});

describe('library pass + statistics file channel', () => {
  test('runs stats after the library with the same provider and device id', async () => {
    const result = await runFileLibrarySyncPass(envConfig, translationFn);

    expect(mocks.runStats).toHaveBeenCalledWith(envConfig, 'webdav', {
      provider: mocks.provider,
      deviceId: 'device-a',
      // The target is pinned to the settings the provider was built from.
      settings: expect.objectContaining({
        webdav: expect.objectContaining({ serverUrl: 'https://dav.example.com/dav' }),
      }),
    });
    expect(mocks.syncLibrary.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runStats.mock.invocationCallOrder[0]!,
    );
    // The statistics pass never rewrites the library's counted result.
    expect(result?.booksSynced).toBe(1);
    expect(result?.failures).toBe(0);
  });

  test('stamps lastSyncedAt when both passes succeed', async () => {
    await runFileLibrarySyncPass(envConfig, translationFn);

    expect(useSettingsStore.getState().settings.webdav?.lastSyncedAt).toBeTypeOf('number');
    expect(mocks.saveSettings).toHaveBeenCalled();
  });

  test('stats failure keeps the library result but does not stamp success or a clean error', async () => {
    mocks.runStats.mockRejectedValue(new Error('stats upload failed'));

    const result = await runFileLibrarySyncPass(envConfig, translationFn);

    // Library counters survive untouched.
    expect(result?.booksSynced).toBe(1);
    expect(result?.failures).toBe(0);
    // But the backend's terminal state is honest, and this is not a library
    // failure.
    expect(useFileSyncStore.getState().lastErrorByKind.webdav).toBe('stats upload failed');
    expect(useSettingsStore.getState().settings.webdav?.lastSyncedAt).toBeUndefined();
    expect(mocks.recordLibraryPassFailure).not.toHaveBeenCalled();
  });

  test('surfaces both library and statistics failures without erasing either', async () => {
    mocks.syncLibrary.mockResolvedValueOnce(
      syncResult({
        failures: 1,
        failedBooks: [{ hash: 'h1', title: 'A', reason: 'quota exceeded', phase: 'upload-file' }],
      }),
    );
    mocks.runStats.mockRejectedValue(new Error('stats upload failed'));

    await runFileLibrarySyncPass(envConfig, translationFn);

    const lastError = useFileSyncStore.getState().lastErrorByKind.webdav;
    expect(lastError).toContain('quota exceeded');
    expect(lastError).toContain('stats upload failed');
  });

  test('does not call stats when the opt-in is absent', async () => {
    useSettingsStore.getState().setSettings(settings({ syncStats: undefined }));

    await runFileLibrarySyncPass(envConfig, translationFn);

    expect(mocks.runStats).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().settings.webdav?.lastSyncedAt).toBeTypeOf('number');
  });
});
