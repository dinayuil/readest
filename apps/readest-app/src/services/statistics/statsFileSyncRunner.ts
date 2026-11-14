import type { EnvConfigType } from '@/services/environment';
import type { FileSyncProvider } from '@/services/sync/file/provider';
import type { FileSyncBackendKind } from '@/services/sync/file/providerRegistry';
import { createFileSyncProvider } from '@/services/sync/file/providerRegistry';
import type { SyncStrategy } from '@/services/sync/file/engine';
import { getReadyFileSyncBackends } from '@/services/sync/file/backendReadiness';
import { settingsKeyForBackend } from '@/services/sync/cloudSyncProvider';
import { useFileSyncStore } from '@/store/fileSyncStore';
import { useSettingsStore } from '@/store/settingsStore';
import type { SystemSettings } from '@/types/settings';
import { StatisticsDb } from './statisticsDb';
import { ensureFileSyncDeviceId } from './deviceId';
import { pullStatsFileChunks, pushStatsFileChunks } from './statsFileChannel';
import { statsFileTargetId } from './statsFileTarget';

/** What one manual/unattended statistics pass moved. */
export interface FileStatsSyncResult {
  pulledChunks: number;
  pulledEvents: number;
  pushedChunks: number;
  pushedEvents: number;
}

export interface StatsFileSyncCall {
  provider: FileSyncProvider;
  deviceId: string;
  /**
   * The settings snapshot the provider was built from, when the caller has it
   * (the library pass does). Without it the runner captures settings at call
   * time, which already protects queued passes; supplying it also rejects a
   * provider that predates a settings change while an earlier operation ran.
   */
  settings?: SystemSettings;
}

export type FileStatsSyncMode = 'full' | 'push';

const EMPTY_RESULT = (): FileStatsSyncResult => ({
  pulledChunks: 0,
  pulledEvents: 0,
  pushedChunks: 0,
  pushedEvents: 0,
});

const settingsOf = (): SystemSettings => useSettingsStore.getState().settings;

/** The exact target identity a provider was built for, captured before queuing. */
interface CapturedTarget {
  targetId: string;
  strategy: SyncStrategy;
}

const normalizedStrategy = (kind: FileSyncBackendKind, settings: SystemSettings): SyncStrategy => {
  const strategy = settings[settingsKeyForBackend(kind)]?.strategy ?? 'silent';
  return strategy === 'prompt' ? 'silent' : strategy;
};

const captureTarget = (
  kind: FileSyncBackendKind,
  settings: SystemSettings,
  provider: FileSyncProvider,
): CapturedTarget => ({
  targetId: statsFileTargetId(kind, settings, provider.rootPath),
  strategy: normalizedStrategy(kind, settings),
});

const hasStatsOptIn = (kind: FileSyncBackendKind, settings: SystemSettings): boolean =>
  settings[settingsKeyForBackend(kind)]?.syncStats === true;

/**
 * Both gates, in the order the plan states them: the backend must be enabled,
 * active on this plan and transport-ready, AND this device opted into stats for
 * it. Absent `syncStats` is off, so every pre-existing configuration keeps the
 * old library-only behaviour.
 */
const isEligible = (kind: FileSyncBackendKind, settings: SystemSettings): boolean =>
  hasStatsOptIn(kind, settings) && getReadyFileSyncBackends(settings).includes(kind);

const statsBackends = (settings: SystemSettings): FileSyncBackendKind[] =>
  getReadyFileSyncBackends(settings).filter((kind) => hasStatsOptIn(kind, settings));

/**
 * One queue per backend. Full/manual/push passes all mutate the same local
 * statistics database and acknowledgement rows, so they must not interleave;
 * different backends stay independent (and `runFileStatsSyncForAllBackends`
 * runs them one after another anyway).
 */
const queues = new Map<FileSyncBackendKind, Promise<unknown>>();

const serialized = <T>(kind: FileSyncBackendKind, task: () => Promise<T>): Promise<T> => {
  const previous = queues.get(kind) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  queues.set(kind, run);
  void run
    .finally(() => {
      if (queues.get(kind) === run) queues.delete(kind);
    })
    .catch(() => {
      // The caller receives `run`; this side branch only cleans the map.
    });
  return run;
};

/**
 * The actual pass. Re-checks the gate after queuing: settings may have changed
 * while this backend waited behind an in-flight run. With the opt-in off we
 * return before opening the statistics DB or touching the provider.
 */
const runBackendNow = async (
  envConfig: EnvConfigType,
  kind: FileSyncBackendKind,
  call: StatsFileSyncCall,
  mode: FileStatsSyncMode,
  captured: CapturedTarget,
): Promise<FileStatsSyncResult> => {
  const result = EMPTY_RESULT();
  const settings = settingsOf();
  if (!isEligible(kind, settings)) return result;

  // The provider was built from an earlier settings snapshot, possibly before
  // this pass waited behind another. If the account/root/server changed
  // meanwhile, this provider still points at the OLD backend: using it with the
  // NEW target id would acknowledge another target's history or upload to a
  // former account. Reject the stale pair before opening the DB or touching the
  // provider.
  if (statsFileTargetId(kind, settings, call.provider.rootPath) !== captured.targetId) {
    return result;
  }

  const strategy = captured.strategy;
  const canPull = mode === 'full' && strategy !== 'send';
  const canPush = strategy !== 'receive';
  if (!canPull && !canPush) return result;

  // The channel asks this before every read/apply/batch/PUT. A mid-pass switch
  // off, plan pause, or target/strategy change must stop the very next remote
  // operation instead of finishing the old policy against stale state.
  const shouldContinue = (): boolean => {
    const live = settingsOf();
    if (!isEligible(kind, live)) return false;
    if (statsFileTargetId(kind, live, call.provider.rootPath) !== captured.targetId) {
      return false;
    }
    return normalizedStrategy(kind, live) === captured.strategy;
  };

  const appService = await envConfig.getAppService();
  // StatisticsDb.open is a per-tab singleton; opening here shares the reader's
  // connection rather than contending for statistics.db's single OPFS handle.
  const stats = await StatisticsDb.open(appService);
  const deps = {
    stats,
    provider: call.provider,
    targetId: captured.targetId,
    writerId: call.deviceId,
    shouldContinue,
  };

  let failedChunks = 0;
  if (canPull) {
    const pulled = await pullStatsFileChunks(deps);
    result.pulledChunks = pulled.chunks;
    result.pulledEvents = pulled.events;
    failedChunks = pulled.failedChunks ?? 0;
  }
  if (canPush) {
    const pushed = await pushStatsFileChunks(deps);
    result.pushedChunks = pushed.chunks;
    result.pushedEvents = pushed.events;
  }

  // Healthy chunks were merged (and acknowledged) before this point. Invalid
  // chunks are never acknowledged by the channel, so they retry later — but the
  // pass must not be reported as a clean success while remote data was skipped.
  if (failedChunks > 0) {
    throw new Error(
      `Statistics sync could not read ${failedChunks} remote chunk(s); valid data was merged and will retry.`,
    );
  }
  return result;
};

const runBackend = (
  envConfig: EnvConfigType,
  kind: FileSyncBackendKind,
  call: StatsFileSyncCall,
  mode: FileStatsSyncMode,
  captured: CapturedTarget,
): Promise<FileStatsSyncResult> =>
  serialized(kind, () => runBackendNow(envConfig, kind, call, mode, captured));

const runPrepared = (
  envConfig: EnvConfigType,
  kind: FileSyncBackendKind,
  call: StatsFileSyncCall,
  mode: FileStatsSyncMode,
): Promise<FileStatsSyncResult> => {
  const settings = call.settings ?? settingsOf();
  if (!isEligible(kind, settings)) return Promise.resolve(EMPTY_RESULT());
  return runBackend(envConfig, kind, call, mode, captureTarget(kind, settings, call.provider));
};

/**
 * Manual/settings and library-pass entry point. The provider is already built
 * by that surface (the form reuses the library pass's provider); `deviceId` is
 * the one the form just persisted. The target identity is captured HERE, before
 * the pass may wait in the per-backend queue, so a settings change while it
 * waits invalidates the stale provider instead of mixing target identities.
 */
export const runFileStatsSyncForBackend = (
  envConfig: EnvConfigType,
  kind: FileSyncBackendKind,
  call: StatsFileSyncCall,
): Promise<FileStatsSyncResult> => runPrepared(envConfig, kind, call, 'full');

/** Explicit push-only pass for a backend that already has a provider. */
export const pushFileStatsForBackend = (
  envConfig: EnvConfigType,
  kind: FileSyncBackendKind,
  call: StatsFileSyncCall,
): Promise<FileStatsSyncResult> => runPrepared(envConfig, kind, call, 'push');

/**
 * Unattended entry point shared by the reader open, the tracker/TTS push and
 * the stats dialog. Every enabled+opted-in backend is processed independently:
 * one dead mirror must not stop the others. Failures are recorded in the
 * file-sync store (the same last-error surface as library sync) and logged;
 * they are never reported as success.
 */
export const runFileStatsSyncForAllBackends = async (
  envConfig: EnvConfigType,
  opts: { mode?: FileStatsSyncMode } = {},
): Promise<void> => {
  const mode = opts.mode ?? 'full';
  const initial = settingsOf();
  const backends = statsBackends(initial);
  // The all-off path is deliberately free of DB and provider IO.
  if (backends.length === 0) return;

  for (const kind of backends) {
    try {
      const settings = settingsOf();
      if (!isEligible(kind, settings)) continue;
      // Capture the settings the provider is ACTUALLY built from. Provider
      // creation is async and the pass may queue behind another; runBackendNow
      // compares this snapshot with live settings and drops the pass if the
      // account/root moved in between.
      const provider = await createFileSyncProvider(kind, settings);
      if (!provider) throw new Error('Sync backend is not available on this device');
      const captured = captureTarget(kind, settings, provider);
      const deviceId = await ensureFileSyncDeviceId(envConfig, kind);
      await runBackend(envConfig, kind, { provider, deviceId }, mode, captured);
      // Deliberately do not clear lastError here. This is the background/
      // stats-only entry point; a clean statistics push must not make an
      // unrelated failed book/library pass look healthy. The comprehensive
      // manual/library pass owns clearing that shared state.
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      useFileSyncStore.getState().setLastError(kind, message);
      console.warn('[stats] statistics file sync failed', kind, e);
    }
  }
};
