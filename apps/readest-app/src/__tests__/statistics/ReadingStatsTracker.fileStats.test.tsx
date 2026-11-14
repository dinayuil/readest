import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  runAll: vi.fn(),
  envConfig: { getAppService: vi.fn(async () => ({})) },
  progress: null as unknown,
  db: {
    upsertBook: vi.fn(async () => 1),
    insertPageEvent: vi.fn(async () => {}),
    recomputeBookTotals: vi.fn(async () => {}),
  },
}));

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ appService: {}, envConfig: mocks.envConfig }),
}));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@/store/readerProgressStore', () => ({
  useBookProgress: () => mocks.progress,
  getBookProgress: () => mocks.progress,
}));
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: () => () => ({
    book: { hash: 'md5-1', title: 'Book', author: 'Author' },
  }),
}));
vi.mock('@/services/statistics/statisticsDb', () => ({
  StatisticsDb: { open: mocks.open },
}));
vi.mock('@/services/statistics/statsSync', () => ({
  pushStats: vi.fn(),
  pullStats: vi.fn(),
}));
vi.mock('@/services/sync/syncCategories', () => ({ isSyncCategoryEnabled: () => false }));
vi.mock('@/libs/sync', () => ({ SyncClient: class {} }));
vi.mock('@/services/tts/TTSSessionManager', () => ({
  ttsSessionManager: {
    getPlaybackState: () => null,
    getActiveSession: () => null,
  },
  getBookHashFromKey: (key: string) => key.split('-')[0],
}));
vi.mock('@/services/statistics/statsFileSyncRunner', () => ({
  runFileStatsSyncForAllBackends: mocks.runAll,
}));

import ReadingStatsTracker from '@/app/reader/components/ReadingStatsTracker';
import { pushStats, pullStats } from '@/services/statistics/statsSync';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.open.mockResolvedValue(mocks.db);
  mocks.runAll.mockResolvedValue(undefined);
  mocks.progress = { pageinfo: { current: 0, next: 1, total: 100 } };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ReadingStatsTracker third-party statistics channel', () => {
  test('opens a book with a full file pass even when signed out', async () => {
    render(<ReadingStatsTracker bookKey='md5-1-view1' />);

    await waitFor(() => {
      expect(mocks.runAll).toHaveBeenCalledWith(mocks.envConfig, { mode: 'full' });
    });
    // The official account channel stays behind its user/category guard.
    expect(pushStats).not.toHaveBeenCalled();
    expect(pullStats).not.toHaveBeenCalled();
  });

  test('pushes the file channel on book close without an account token', async () => {
    const { unmount } = render(<ReadingStatsTracker bookKey='md5-1-view1' />);
    await waitFor(() => {
      expect(mocks.runAll).toHaveBeenCalledWith(mocks.envConfig, { mode: 'full' });
    });

    unmount();

    await waitFor(() => {
      expect(mocks.runAll).toHaveBeenCalledWith(mocks.envConfig, { mode: 'push' });
    });
    expect(pushStats).not.toHaveBeenCalled();
  });
});
