import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  db: {
    getQuarterHourDurations: vi.fn(async () => []),
    getReadingTotals: vi.fn(async () => ({ seconds: 0, books: 7, pages: 11 })),
  },
  open: vi.fn(),
  runAll: vi.fn(),
  env: {
    appService: {},
    envConfig: { getAppService: vi.fn(async () => ({})) },
  },
  pullStats: vi.fn(),
}));

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => mocks.env,
}));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (key: string) => key }));
vi.mock('@/services/statistics/statisticsDb', () => ({
  StatisticsDb: { open: mocks.open },
}));
vi.mock('@/services/statistics/statsFileSyncRunner', () => ({
  runFileStatsSyncForAllBackends: mocks.runAll,
}));
vi.mock('@/services/statistics/statsSync', () => ({ pullStats: mocks.pullStats }));
vi.mock('@/libs/sync', () => ({ SyncClient: class {} }));
vi.mock('@/services/sync/syncCategories', () => ({ isSyncCategoryEnabled: () => true }));

const openDialog = async () => {
  const { default: ReadingStatsDialog, setReadingStatsDialogVisible } = await import(
    '@/components/stats/ReadingStatsDialog'
  );
  render(<ReadingStatsDialog />);
  await act(async () => setReadingStatsDialogVisible(true));
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.open.mockResolvedValue(mocks.db);
  mocks.runAll.mockResolvedValue(undefined);
  mocks.db.getQuarterHourDurations.mockResolvedValue([]);
  mocks.db.getReadingTotals.mockResolvedValue({ seconds: 0, books: 7, pages: 11 });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ReadingStatsDialog file statistics channel', () => {
  test('renders local stats first, then runs a full file pass while signed out', async () => {
    await openDialog();

    expect(await screen.findByText('7')).toBeTruthy();
    await waitFor(() => {
      expect(mocks.runAll).toHaveBeenCalledWith(mocks.env.envConfig, { mode: 'full' });
    });
    expect(mocks.db.getReadingTotals.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runAll.mock.invocationCallOrder[0]!,
    );
    expect(mocks.pullStats).not.toHaveBeenCalled();
  });

  test('an offline file pass leaves the local panel visible instead of the failure state', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.runAll.mockRejectedValue(new Error('offline'));

    await openDialog();

    expect(await screen.findByText('7')).toBeTruthy();
    expect(screen.queryByText('Failed to load reading statistics')).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      'Failed to sync reading statistics files:',
      expect.any(Error),
    );
  });
});
