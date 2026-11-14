import { v4 as uuidv4 } from 'uuid';
import type { EnvConfigType } from '@/services/environment';
import { settingsKeyForBackend } from '@/services/sync/cloudSyncProvider';
import type { FileSyncBackendKind } from '@/services/sync/file/providerRegistry';
import { useSettingsStore } from '@/store/settingsStore';

/**
 * One in-flight generation per backend. Two stats entries opening at once
 * (e.g. the reader and the library pass) must persist the same id instead of
 * racing two UUIDs into settings.json, where the last writer would orphan the
 * chunks the other device already wrote under the first id.
 */
const pending = new Map<FileSyncBackendKind, Promise<string>>();

const savedDeviceId = (kind: FileSyncBackendKind): string | undefined => {
  const settings = useSettingsStore.getState().settings;
  const id = settings[settingsKeyForBackend(kind)]?.deviceId;
  return id || undefined;
};

/**
 * Return this backend's stats/library device id, generating and persisting one
 * on first use. UI-free by design: the reader, tracker, TTS recorder and library
 * pass all reach this without an auth context. The manual settings form still
 * generates its own id first and passes it through; by then this is a read.
 */
export const ensureFileSyncDeviceId = async (
  envConfig: EnvConfigType,
  kind: FileSyncBackendKind,
): Promise<string> => {
  const existing = savedDeviceId(kind);
  if (existing) return existing;

  const inflight = pending.get(kind);
  if (inflight) return inflight;

  const task = (async () => {
    // Resolve the service FIRST: every settings read below must happen after
    // this await, or a slow app-service init would let us save a snapshot from
    // before the user's latest edits.
    const appService = await envConfig.getAppService();

    // Another surface may have persisted an id while this call waited.
    const current = savedDeviceId(kind);
    if (current) return current;

    const id = uuidv4();
    const key = settingsKeyForBackend(kind);
    // Read immediately before building and saving: keep every unrelated field
    // (and a just-edited root/account/opt-in) in the persisted snapshot.
    const settings = useSettingsStore.getState().settings;
    const next = { ...settings, [key]: { ...settings[key], deviceId: id } };
    // Write to disk BEFORE publishing to the store. If persistence fails, a
    // retry sees no id and generates again instead of trusting a value that
    // would vanish on restart.
    await appService.saveSettings(next);
    // Publish only the id into the CURRENT store state, not the whole `next`
    // snapshot: another settings write may have landed while saveSettings was
    // in flight, and spreading `next` here would roll it back in memory.
    const latest = useSettingsStore.getState().settings;
    useSettingsStore.getState().setSettings({ ...latest, [key]: { ...latest[key], deviceId: id } });
    return id;
  })().finally(() => {
    if (pending.get(kind) === task) pending.delete(kind);
  });

  pending.set(kind, task);
  return task;
};
