import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { SystemSettings } from '@/types/settings';
import { eventDispatcher } from '@/utils/event';
import { useFileSyncStore } from '@/store/fileSyncStore';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';
import { FileSyncError } from '@/services/sync/file/provider';

/**
 * Reading-statistics opt-in on the shared file-sync controls: the switch is off
 * by default, "Sync now" only runs the statistics pass when it is on, and a
 * failed statistics pass must not be recorded as a successful sync.
 */

const mocks = vi.hoisted(() => ({
  envConfig: { getAppService: vi.fn(async () => ({ loadLibraryBooks: async () => [] })) },
  provider: { name: 'fake-provider' },
  recordLibraryPassFailure: vi.fn(),
  runFileStatsSyncForBackend: vi.fn(),
}));

const syncLibrary = vi.fn();

vi.mock('@/services/statistics/statsFileSyncRunner', () => ({
  runFileStatsSyncForBackend: mocks.runFileStatsSyncForBackend,
}));

vi.mock('@/components/Dialog', () => ({
  default: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div role='dialog'>{children}</div> : null,
}));

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: mocks.envConfig, appService: null }),
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string) => key,
}));

vi.mock('@/services/sync/file/providerRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/sync/file/providerRegistry')>();
  return { ...actual, createFileSyncProvider: vi.fn(async () => mocks.provider) };
});

vi.mock('@/services/sync/file/appLocalStore', () => ({
  createAppLocalStore: vi.fn(() => ({}) as never),
}));

vi.mock('@/services/sync/file/runLibrarySync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/sync/file/runLibrarySync')>();
  return { ...actual, recordLibraryPassFailure: mocks.recordLibraryPassFailure };
});

vi.mock('@/services/sync/file/engine', () => ({
  FileSyncEngine: vi.fn(function (this: Record<string, unknown>) {
    this['syncLibrary'] = syncLibrary;
  }),
}));

import FileSyncForm, {
  type FileSyncFormSettings,
} from '@/components/settings/integrations/FileSyncForm';

const stored: FileSyncFormSettings = {
  enabled: true,
  deviceId: 'd1',
  strategy: 'silent',
  syncBooks: false,
};

const settingsSnapshot = { webdav: stored } as unknown as SystemSettings;

const renderForm = (
  slice: FileSyncFormSettings,
  persist: (patch: Partial<FileSyncFormSettings>) => Promise<void> = vi.fn(async () => {}),
) => render(<FileSyncForm kind='webdav' stored={slice} persist={persist} />);

beforeEach(() => {
  vi.clearAllMocks();
  syncLibrary.mockResolvedValue({ booksSynced: 1, failures: 0, totalBooks: 1, failedBooks: [] });
  mocks.runFileStatsSyncForBackend.mockResolvedValue(undefined);
  useSettingsStore.setState({
    settings: settingsSnapshot,
  } as never);
  useLibraryStore.setState({ library: [], libraryLoaded: true } as never);
  useFileSyncStore.setState({
    byKind: {},
    activeKind: null,
    lastErrorByKind: {},
  });
});

afterEach(() => {
  cleanup();
});

describe('FileSyncForm — reading statistics sync', () => {
  test('offers the reading-statistics switch off by default and persists the opt-in', () => {
    const persist = vi.fn(async () => {});
    renderForm({ ...stored, syncStats: undefined }, persist);

    const toggle = screen.getByRole('checkbox', { name: /Sync Reading Statistics/ });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    expect(
      screen.getByText('Sync reading and listening history to your storage as unencrypted files'),
    ).toBeTruthy();

    fireEvent.click(toggle);
    expect(persist).toHaveBeenCalledWith({ syncStats: true });
  });

  test('Sync now skips the statistics pass when the switch is off', async () => {
    const persist = vi.fn(async () => {});
    renderForm({ ...stored, syncStats: false }, persist);

    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));

    await waitFor(() => {
      expect(persist).toHaveBeenCalledWith({ lastSyncedAt: expect.any(Number) });
    });
    expect(mocks.runFileStatsSyncForBackend).not.toHaveBeenCalled();
  });

  test('Sync now runs the statistics pass after the library pass with the generated device id', async () => {
    let persistedDeviceId: string | undefined;
    const persist = vi.fn(async (patch: Partial<FileSyncFormSettings>) => {
      if (patch.deviceId) persistedDeviceId = patch.deviceId;
    });
    renderForm({ ...stored, deviceId: undefined, syncStats: true }, persist);

    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));

    await waitFor(() => {
      expect(mocks.runFileStatsSyncForBackend).toHaveBeenCalledTimes(1);
    });
    expect(syncLibrary.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runFileStatsSyncForBackend.mock.invocationCallOrder[0]!,
    );

    expect(persistedDeviceId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(mocks.runFileStatsSyncForBackend).toHaveBeenCalledWith(mocks.envConfig, 'webdav', {
      provider: mocks.provider,
      deviceId: persistedDeviceId,
      settings: settingsSnapshot,
    });
    // The runner must receive the exact snapshot the provider was built from,
    // so it can reject the provider if the target changed during the pass.
    expect(mocks.runFileStatsSyncForBackend.mock.calls[0]![2].settings).toBe(settingsSnapshot);

    await waitFor(() => {
      expect(persist).toHaveBeenCalledWith({ lastSyncedAt: expect.any(Number) });
    });
  });

  test('shows a reading-statistics progress label while the pass runs', async () => {
    let finishStats!: () => void;
    mocks.runFileStatsSyncForBackend.mockReturnValue(
      new Promise<void>((resolve) => {
        finishStats = () => resolve();
      }),
    );
    renderForm({ ...stored, syncStats: true });

    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));

    await waitFor(() => {
      expect(screen.getByText('Syncing reading statistics…')).toBeTruthy();
    });
    finishStats();
    await waitFor(() => {
      expect(useFileSyncStore.getState().byKind.webdav?.isSyncing ?? false).toBe(false);
    });
  });

  test('runs the statistics pass even when some books failed, without stamping success', async () => {
    const persist = vi.fn(async () => {});
    syncLibrary.mockResolvedValueOnce({
      booksSynced: 0,
      failures: 1,
      totalBooks: 1,
      failedBooks: [{ hash: 'a', title: 'Failed PDF', phase: 'upload-file', reason: 'HTTP 507' }],
    });
    renderForm({ ...stored, syncStats: true }, persist);

    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));

    await waitFor(() => {
      expect(mocks.runFileStatsSyncForBackend).toHaveBeenCalledTimes(1);
    });
    expect(persist).not.toHaveBeenCalledWith({ lastSyncedAt: expect.any(Number) });
  });

  test('a failed statistics pass shows the error toast and does not stamp success', async () => {
    const persist = vi.fn(async () => {});
    const toast = vi.spyOn(eventDispatcher, 'dispatch');
    mocks.runFileStatsSyncForBackend.mockRejectedValue(
      new FileSyncError('statistics upload failed', 'NETWORK'),
    );
    renderForm({ ...stored, syncStats: true }, persist);

    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));

    await waitFor(() => {
      expect(useFileSyncStore.getState().byKind.webdav?.isSyncing ?? false).toBe(false);
    });
    expect(toast).toHaveBeenCalledWith('toast', { type: 'error', message: 'Network error' });
    expect(persist).not.toHaveBeenCalledWith({ lastSyncedAt: expect.any(Number) });
    expect(useFileSyncStore.getState().lastErrorByKind.webdav).toBe('statistics upload failed');
    // The library pass succeeded, so its failure recorder must stay untouched.
    expect(mocks.recordLibraryPassFailure).not.toHaveBeenCalled();
  });

  test('a statistics failure preserves the library failure in lastError', async () => {
    const persist = vi.fn(async () => {});
    syncLibrary.mockResolvedValueOnce({
      booksSynced: 0,
      failures: 1,
      totalBooks: 1,
      failedBooks: [{ hash: 'a', title: 'Failed PDF', phase: 'upload-file', reason: 'HTTP 507' }],
    });
    mocks.runFileStatsSyncForBackend.mockRejectedValue(
      new FileSyncError('statistics upload failed', 'NETWORK'),
    );
    renderForm({ ...stored, syncStats: true }, persist);

    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));

    await waitFor(() => {
      expect(useFileSyncStore.getState().lastErrorByKind.webdav).toContain(
        'statistics upload failed',
      );
    });
    expect(useFileSyncStore.getState().lastErrorByKind.webdav).toBe(
      'Sync finished with {{failed}} failure(s). {{ok}} ok.\nFailed PDF: HTTP 507\nstatistics upload failed',
    );
    expect(mocks.recordLibraryPassFailure).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalledWith({ lastSyncedAt: expect.any(Number) });
  });

  test('a thrown library pass still records the library failure', async () => {
    const persist = vi.fn(async () => {});
    syncLibrary.mockRejectedValueOnce(new Error('library broke'));
    renderForm({ ...stored, syncStats: true }, persist);

    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));

    await waitFor(() => {
      expect(mocks.recordLibraryPassFailure).toHaveBeenCalledWith('webdav', 'library broke');
    });
    expect(mocks.runFileStatsSyncForBackend).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalledWith({ lastSyncedAt: expect.any(Number) });
  });
});
