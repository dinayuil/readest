import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { SystemSettings } from '@/types/settings';
import { useSettingsStore } from '@/store/settingsStore';
import { ensureFileSyncDeviceId } from '@/services/statistics/deviceId';

const mocks = vi.hoisted(() => ({
  saveSettings: vi.fn(),
}));

const envConfig = {
  getAppService: vi.fn(async () => ({ saveSettings: mocks.saveSettings }) as never),
} as never;

const settings = (deviceId?: string) =>
  ({
    version: 1,
    webdav: {
      enabled: true,
      serverUrl: 'https://dav.example.com/dav',
      username: 'reader',
      password: 'pw',
      rootPath: '/',
      deviceId,
    },
  }) as unknown as SystemSettings;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.saveSettings.mockResolvedValue(undefined);
  useSettingsStore.getState().setSettings(settings());
});

describe('ensureFileSyncDeviceId', () => {
  test('returns an existing id without writing settings', async () => {
    useSettingsStore.getState().setSettings(settings('existing-device'));

    expect(await ensureFileSyncDeviceId(envConfig, 'webdav')).toBe('existing-device');
    expect(mocks.saveSettings).not.toHaveBeenCalled();
  });

  test('persists one id for concurrent first uses', async () => {
    const [first, second] = await Promise.all([
      ensureFileSyncDeviceId(envConfig, 'webdav'),
      ensureFileSyncDeviceId(envConfig, 'webdav'),
    ]);

    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toBe(first);
    expect(mocks.saveSettings).toHaveBeenCalledTimes(1);
    const saved = mocks.saveSettings.mock.calls[0]![0] as SystemSettings;
    expect(saved.webdav?.deviceId).toBe(first);
    expect(useSettingsStore.getState().settings.webdav?.deviceId).toBe(first);
  });

  test('keeps settings edited while appService is resolving', async () => {
    let resolveService!: (value: unknown) => void;
    const slowEnv = {
      getAppService: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveService = resolve;
          }),
      ),
    } as never;

    const pending = ensureFileSyncDeviceId(slowEnv, 'webdav');
    await vi.waitFor(() => expect(mocks.saveSettings).not.toHaveBeenCalled());
    useSettingsStore.getState().setSettings({
      ...settings(),
      keepLogin: true,
      webdav: { ...settings().webdav!, rootPath: '/Edited While Waiting' },
    } as SystemSettings);

    resolveService({ saveSettings: mocks.saveSettings });
    const id = await pending;

    const saved = mocks.saveSettings.mock.calls[0]![0] as SystemSettings;
    expect(saved.webdav?.rootPath).toBe('/Edited While Waiting');
    expect(saved.keepLogin).toBe(true);
    expect(saved.webdav?.deviceId).toBe(id);

    const live = useSettingsStore.getState().settings;
    expect(live.webdav?.rootPath).toBe('/Edited While Waiting');
    expect(live.keepLogin).toBe(true);
    expect(live.webdav?.deviceId).toBe(id);
  });

  test('a failed save leaves no fake id behind so a retry persists one', async () => {
    mocks.saveSettings.mockRejectedValueOnce(new Error('disk full'));

    await expect(ensureFileSyncDeviceId(envConfig, 'webdav')).rejects.toThrow('disk full');
    expect(useSettingsStore.getState().settings.webdav?.deviceId).toBeUndefined();

    const retried = await ensureFileSyncDeviceId(envConfig, 'webdav');
    expect(retried).toMatch(/^[0-9a-f-]{36}$/);
    expect(mocks.saveSettings).toHaveBeenCalledTimes(2);
  });
});
