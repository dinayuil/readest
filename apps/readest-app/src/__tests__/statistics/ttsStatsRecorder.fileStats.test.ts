import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { TtsStatsSession } from '@/services/statistics/ttsStatsRecorder';

const mocks = vi.hoisted(() => ({
  environment: { getAppService: vi.fn(async () => ({})) },
  runAll: vi.fn(),
  pushStats: vi.fn(),
  syncEnabled: false,
  accessToken: null as string | null,
}));

vi.mock('@/services/environment', () => ({ default: mocks.environment }));
vi.mock('@/services/statistics/statisticsDb', () => ({
  StatisticsDb: { open: vi.fn() },
}));
vi.mock('@/services/statistics/statsSync', () => ({ pushStats: mocks.pushStats }));
vi.mock('@/services/statistics/statsFileSyncRunner', () => ({
  runFileStatsSyncForAllBackends: mocks.runAll,
}));
vi.mock('@/services/sync/syncCategories', () => ({
  isSyncCategoryEnabled: () => mocks.syncEnabled,
}));
vi.mock('@/libs/sync', () => ({ SyncClient: class {} }));
vi.mock('@/utils/access', () => ({ getAccessToken: async () => mocks.accessToken }));
vi.mock('@/store/readerProgressStore', () => ({ getBookProgress: () => null }));
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: {
    getState: () => ({
      getBookData: () => ({
        book: { hash: 'md5-1', title: 'Book', author: 'Author' },
      }),
      getConfig: () => null,
    }),
  },
}));

import { TtsStatsRecorder } from '@/services/statistics/ttsStatsRecorder';

const session = {
  bookHash: 'md5-1',
  bookKey: 'md5-1-view1',
  controller: {},
} as unknown as TtsStatsSession;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runAll.mockResolvedValue(undefined);
  mocks.pushStats.mockResolvedValue(undefined);
  mocks.syncEnabled = false;
  mocks.accessToken = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TtsStatsRecorder file statistics channel', () => {
  test('pushes file stats before the account token and category guards', async () => {
    const recorder = new TtsStatsRecorder(session);

    await recorder.stop();

    expect(mocks.runAll).toHaveBeenCalledWith(mocks.environment, { mode: 'push' });
    // Category off and no token, so the official channel must stay silent.
    expect(mocks.pushStats).not.toHaveBeenCalled();
  });

  test('a file-channel failure never escapes playback teardown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.runAll.mockRejectedValue(new Error('offline'));
    const recorder = new TtsStatsRecorder(session);

    await expect(recorder.stop()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      '[stats] failed to push TTS statistics to file backends:',
      expect.any(Error),
    );
  });
});
