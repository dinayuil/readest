import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { SystemSettings } from '@/types/settings';
import type { FileSyncProvider } from '@/services/sync/file/provider';

const mocks = vi.hoisted(() => ({
  pull: vi.fn(),
  push: vi.fn(),
  open: vi.fn(),
  createProvider: vi.fn(),
  saveSettings: vi.fn(),
}));

vi.mock('@/services/statistics/statsFileChannel', () => ({
  pullStatsFileChunks: mocks.pull,
  pushStatsFileChunks: mocks.push,
}));
vi.mock('@/services/statistics/statisticsDb', () => ({
  StatisticsDb: { open: mocks.open },
}));
vi.mock('@/services/sync/file/providerRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/sync/file/providerRegistry')>();
  return { ...actual, createFileSyncProvider: mocks.createProvider };
});

import { useFileSyncStore } from '@/store/fileSyncStore';
import { useSettingsStore } from '@/store/settingsStore';
import {
  pushFileStatsForBackend,
  runFileStatsSyncForAllBackends,
  runFileStatsSyncForBackend,
} from '@/services/statistics/statsFileSyncRunner';
import { statsFileTargetId } from '@/services/statistics/statsFileTarget';

const envConfig = {
  getAppService: vi.fn(async () => ({ saveSettings: mocks.saveSettings }) as never),
};

const provider = (rootPath = '/', tag = 'p'): FileSyncProvider =>
  ({ rootPath, __tag: tag }) as unknown as FileSyncProvider;

const settings = (over: Partial<SystemSettings> = {}): SystemSettings =>
  ({
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
    s3: {
      enabled: false,
      endpoint: 'https://s3.example.com',
      region: 'auto',
      bucket: 'bucket',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      strategy: 'silent',
      syncStats: false,
      deviceId: 'device-b',
    },
    ...over,
  }) as unknown as SystemSettings;

const pushResult = () => ({ chunks: 1, books: 1, events: 4 });
const pullResult = (failedChunks = 0) => ({ chunks: 2, books: 3, events: 10, failedChunks });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.open.mockResolvedValue({});
  mocks.pull.mockResolvedValue(pullResult());
  mocks.push.mockResolvedValue(pushResult());
  mocks.createProvider.mockImplementation(async (kind: string) => provider('/', kind));
  mocks.saveSettings.mockResolvedValue(undefined);
  useFileSyncStore.setState({ byKind: {}, activeKind: null, lastErrorByKind: {} });
  useSettingsStore.getState().setSettings(settings());
});

describe('runFileStatsSyncForBackend', () => {
  test('does nothing at all when syncStats is off — no DB, no provider IO', async () => {
    useSettingsStore.getState().setSettings(
      settings({
        webdav: { ...settings().webdav!, syncStats: false },
      }),
    );

    const result = await runFileStatsSyncForBackend(envConfig, 'webdav', {
      provider: provider(),
      deviceId: 'device-a',
    });

    expect(result).toEqual({
      pulledChunks: 0,
      pulledEvents: 0,
      pushedChunks: 0,
      pushedEvents: 0,
    });
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.pull).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  test('silent full mode pulls then pushes, using the current target identity', async () => {
    const call = { provider: provider('/'), deviceId: 'device-a' };
    const result = await runFileStatsSyncForBackend(envConfig, 'webdav', call);

    expect(mocks.pull.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.push.mock.invocationCallOrder[0]!,
    );
    expect(mocks.pull).toHaveBeenCalledWith(
      expect.objectContaining({
        stats: expect.anything(),
        provider: call.provider,
        targetId: statsFileTargetId('webdav', settings(), '/'),
        writerId: 'device-a',
        shouldContinue: expect.any(Function),
      }),
    );
    expect(result).toEqual({
      pulledChunks: 2,
      pulledEvents: 10,
      pushedChunks: 1,
      pushedEvents: 4,
    });
  });

  test('send-only strategy pushes without pulling', async () => {
    useSettingsStore
      .getState()
      .setSettings(settings({ webdav: { ...settings().webdav!, strategy: 'send' } }));

    await runFileStatsSyncForBackend(envConfig, 'webdav', {
      provider: provider(),
      deviceId: 'device-a',
    });

    expect(mocks.pull).not.toHaveBeenCalled();
    expect(mocks.push).toHaveBeenCalledTimes(1);
  });

  test('receive-only strategy pulls without pushing', async () => {
    useSettingsStore
      .getState()
      .setSettings(settings({ webdav: { ...settings().webdav!, strategy: 'receive' } }));

    await runFileStatsSyncForBackend(envConfig, 'webdav', {
      provider: provider(),
      deviceId: 'device-a',
    });

    expect(mocks.pull).toHaveBeenCalledTimes(1);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  test('shouldContinue follows live eligibility, target and strategy', async () => {
    let continuation!: () => boolean;
    mocks.pull.mockImplementation(async (deps: { shouldContinue: () => boolean }) => {
      continuation = deps.shouldContinue;
      expect(continuation()).toBe(true);
      return pullResult();
    });
    await runFileStatsSyncForBackend(envConfig, 'webdav', {
      provider: provider('/'),
      deviceId: 'device-a',
    });

    // prompt is normalised to silent at capture time, so it is still the same
    // policy and must not interrupt.
    useSettingsStore
      .getState()
      .setSettings(settings({ webdav: { ...settings().webdav!, strategy: 'prompt' } }));
    expect(continuation()).toBe(true);

    useSettingsStore
      .getState()
      .setSettings(settings({ webdav: { ...settings().webdav!, rootPath: '/Moved' } }));
    expect(continuation()).toBe(false);

    useSettingsStore
      .getState()
      .setSettings(settings({ webdav: { ...settings().webdav!, syncStats: false } }));
    expect(continuation()).toBe(false);

    useSettingsStore
      .getState()
      .setSettings(settings({ webdav: { ...settings().webdav!, strategy: 'receive' } }));
    expect(continuation()).toBe(false);
  });

  test('invalid remote chunks surface as an error after healthy chunks were merged', async () => {
    mocks.pull.mockResolvedValue(pullResult(2));

    await expect(
      runFileStatsSyncForBackend(envConfig, 'webdav', {
        provider: provider(),
        deviceId: 'device-a',
      }),
    ).rejects.toThrow(/2 remote chunk/);
  });

  test('serializes concurrent passes for the same backend', async () => {
    let finishFirst!: () => void;
    mocks.pull.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = () => resolve(pullResult());
        }),
    );

    const first = runFileStatsSyncForBackend(envConfig, 'webdav', {
      provider: provider(),
      deviceId: 'device-a',
    });
    const second = runFileStatsSyncForBackend(envConfig, 'webdav', {
      provider: provider(),
      deviceId: 'device-a',
    });

    try {
      await vi.waitFor(() => expect(mocks.pull).toHaveBeenCalledTimes(1));
    } finally {
      finishFirst();
    }

    await Promise.all([first, second]);
    expect(mocks.pull).toHaveBeenCalledTimes(2);
  });

  test('drops a queued pass when the target changes while it waits', async () => {
    let finishFirst!: () => void;
    mocks.pull.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = () => resolve(pullResult());
        }),
    );
    const call = { provider: provider('/'), deviceId: 'device-a' };

    const first = runFileStatsSyncForBackend(envConfig, 'webdav', call);
    await vi.waitFor(() => expect(mocks.pull).toHaveBeenCalledTimes(1));
    const second = runFileStatsSyncForBackend(envConfig, 'webdav', call);
    // The second pass captured the old target before queuing. Re-point the
    // backend (same provider object, stale root) while it waits.
    useSettingsStore
      .getState()
      .setSettings(settings({ webdav: { ...settings().webdav!, rootPath: '/Moved Root' } }));

    finishFirst();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.pulledChunks).toBe(2);
    expect(secondResult).toEqual({
      pulledChunks: 0,
      pulledEvents: 0,
      pushedChunks: 0,
      pushedEvents: 0,
    });
    // The stale pass never opened the DB or touched the provider again.
    expect(mocks.open).toHaveBeenCalledTimes(1);
    expect(mocks.pull).toHaveBeenCalledTimes(1);
    expect(mocks.push).toHaveBeenCalledTimes(1);
  });

  test('drops a provider whose captured settings no longer match the live target', async () => {
    const oldSettings = settings();
    useSettingsStore
      .getState()
      .setSettings(settings({ webdav: { ...oldSettings.webdav!, rootPath: '/Moved Root' } }));

    const result = await runFileStatsSyncForBackend(envConfig, 'webdav', {
      provider: provider('/'),
      deviceId: 'device-a',
      settings: oldSettings,
    });

    expect(result).toEqual({
      pulledChunks: 0,
      pulledEvents: 0,
      pushedChunks: 0,
      pushedEvents: 0,
    });
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.pull).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  test('pushFileStatsForBackend never pulls', async () => {
    await pushFileStatsForBackend(envConfig, 'webdav', {
      provider: provider(),
      deviceId: 'device-a',
    });

    expect(mocks.pull).not.toHaveBeenCalled();
    expect(mocks.push).toHaveBeenCalledTimes(1);
  });
});

describe('runFileStatsSyncForAllBackends', () => {
  test('does not even open the database or build a provider when all backends opt out', async () => {
    useSettingsStore
      .getState()
      .setSettings(settings({ webdav: { ...settings().webdav!, syncStats: false } }));

    await runFileStatsSyncForAllBackends(envConfig, { mode: 'full' });

    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.createProvider).not.toHaveBeenCalled();
    expect(envConfig.getAppService).not.toHaveBeenCalled();
  });

  test('push mode never pulls', async () => {
    await runFileStatsSyncForAllBackends(envConfig, { mode: 'push' });

    expect(mocks.createProvider).toHaveBeenCalledWith('webdav', expect.anything());
    expect(mocks.pull).not.toHaveBeenCalled();
    expect(mocks.push).toHaveBeenCalledTimes(1);
  });

  test('isolates one backend failure and continues with the next', async () => {
    const webdav = provider('/', 'webdav');
    const s3 = provider('/', 's3');
    useSettingsStore.getState().setSettings(
      settings({
        s3: {
          ...settings().s3!,
          enabled: true,
          syncStats: true,
          deviceId: 'device-b',
        },
      }),
    );
    mocks.createProvider.mockImplementation(async (kind: string) =>
      kind === 'webdav' ? webdav : s3,
    );
    mocks.pull.mockImplementation(async (deps: { provider: FileSyncProvider }) => {
      if (deps.provider === webdav) throw new Error('webdav offline');
      return pullResult();
    });

    await runFileStatsSyncForAllBackends(envConfig, { mode: 'full' });

    expect(mocks.createProvider).toHaveBeenCalledTimes(2);
    expect(mocks.push).toHaveBeenCalledTimes(1);
    expect(useFileSyncStore.getState().lastErrorByKind.webdav).toBe('webdav offline');
    expect(useFileSyncStore.getState().lastErrorByKind.s3).toBeUndefined();
  });

  test('a clean stats-only pass does not clear an unrelated library failure', async () => {
    useFileSyncStore.getState().setLastError('webdav', 'library index upload failed');

    await runFileStatsSyncForAllBackends(envConfig, { mode: 'push' });

    expect(mocks.push).toHaveBeenCalledTimes(1);
    expect(useFileSyncStore.getState().lastErrorByKind.webdav).toBe('library index upload failed');
  });

  test('drops a provider whose target moved while it was being built', async () => {
    let finishProvider!: (value: FileSyncProvider) => void;
    mocks.createProvider.mockReturnValueOnce(
      new Promise<FileSyncProvider>((resolve) => {
        finishProvider = resolve;
      }),
    );

    const running = runFileStatsSyncForAllBackends(envConfig, { mode: 'full' });
    await vi.waitFor(() => expect(mocks.createProvider).toHaveBeenCalledTimes(1));
    useSettingsStore
      .getState()
      .setSettings(settings({ webdav: { ...settings().webdav!, rootPath: '/Moved Root' } }));
    finishProvider(provider('/'));

    await running;

    // The provider was built from the pre-change settings/root; using it for
    // the new target would write to the wrong place and acknowledge the wrong
    // target's history.
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.pull).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  test('records a generic backend failure instead of silently succeeding', async () => {
    mocks.createProvider.mockResolvedValueOnce(null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runFileStatsSyncForAllBackends(envConfig, { mode: 'full' });

    expect(useFileSyncStore.getState().lastErrorByKind.webdav).toMatch(/not available/);
    expect(warn).toHaveBeenCalled();
  });

  test('generates and persists a missing deviceId once, even under concurrent passes', async () => {
    useSettingsStore
      .getState()
      .setSettings(settings({ webdav: { ...settings().webdav!, deviceId: undefined } }));

    await Promise.all([
      runFileStatsSyncForAllBackends(envConfig, { mode: 'push' }),
      runFileStatsSyncForAllBackends(envConfig, { mode: 'push' }),
    ]);

    expect(mocks.saveSettings).toHaveBeenCalledTimes(1);
    const saved = mocks.saveSettings.mock.calls[0]![0] as SystemSettings;
    expect(saved.webdav?.deviceId).toMatch(/^[0-9a-f-]{36}$/);
    const writerIds = mocks.push.mock.calls.map(
      (call) => (call[0] as { writerId: string }).writerId,
    );
    expect(new Set(writerIds)).toEqual(new Set([saved.webdav!.deviceId]));
  });
});
