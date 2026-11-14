import { formatSyncFailure } from './syncResult';

import type { Book } from '@/types/book';
import { recordFlow } from '@/services/sync/dataFlow/log';
import type { FlowDirection, FlowKind } from '@/services/sync/dataFlow/types';
import type { EnvConfigType } from '@/services/environment';
import type { ProgressHandler } from '@/utils/transfer';
import type { TranslationFunc } from '@/hooks/useTranslation';
import type { SystemSettings } from '@/types/settings';
import { useSettingsStore } from '@/store/settingsStore';
import { useLibraryStore } from '@/store/libraryStore';
import { useFileSyncStore } from '@/store/fileSyncStore';
import {
  getActiveFileSyncBackends,
  settingsKeyForBackend,
} from '@/services/sync/cloudSyncProvider';
import {
  createFileSyncProvider,
  type FileSyncBackendKind,
} from '@/services/sync/file/providerRegistry';
import type { FileSyncProvider } from '@/services/sync/file/provider';
import { createAppLocalStore } from '@/services/sync/file/appLocalStore';
import { FileSyncEngine, type SyncLibraryResult } from '@/services/sync/file/engine';
import { ensureFileSyncDeviceId } from '@/services/statistics/deviceId';
import { runFileStatsSyncForBackend } from '@/services/statistics/statsFileSyncRunner';
import { canBackendRun } from './backendReadiness';

// Re-exported for the hooks/forms that historically imported the readiness
// gates from this module. The definitions moved out so the statistics runner
// can gate on them without importing this file and creating a static cycle.
export { canBackendRun, getReadyFileSyncBackends } from './backendReadiness';

/**
 * Build one backend's engine + the provider it was built on. Returning both
 * lets the library pass hand the very same provider to the statistics pass
 * (one shared cache entry, one connection) instead of rebuilding it.
 */
const buildEngine = async (
  envConfig: EnvConfigType,
  kind: FileSyncBackendKind,
  parentTransferId?: string,
): Promise<{
  engine: FileSyncEngine;
  provider: FileSyncProvider;
  settings: SystemSettings;
} | null> => {
  if (!canBackendRun(kind)) return null;
  const settings = useSettingsStore.getState().settings;
  const appService = await envConfig.getAppService();
  const provider = await createFileSyncProvider(kind, settings, parentTransferId);
  if (!provider) return null;
  const store = createAppLocalStore({ appService, settings, envConfig });
  return { engine: new FileSyncEngine(provider, store), provider, settings };
};

const bookFile = (connector: FileSyncBackendKind, direction: FlowDirection) =>
  ({ connector, direction, kind: 'books' }) as const;

export const recordLibraryPass = (connector: FileSyncBackendKind, result: SyncLibraryResult) => {
  const add = (direction: FlowDirection, kind: FlowKind, count: number) =>
    recordFlow({ connector, direction, kind, count });
  add('push', 'progress', result.configsUploaded ?? 0);
  add('pull', 'progress', result.configsDownloaded ?? 0);
  add('push', 'books', result.filesUploaded ?? 0);
  // booksAdded are shelf rows: their files download on demand.
  add('pull', 'books', 0);
  for (const { title, hash, reason, phase } of result.failedBooks) {
    const direction = phase === 'download' ? 'pull' : 'push';
    recordFlow({ ...bookFile(connector, direction), bookTitle: title || hash, error: reason });
  }
  if (result.indexPushFailed)
    recordFlow({ ...bookFile(connector, 'push'), error: 'Failed to upload the library index' });
};

/** A pass that stopped partway doesn't say which side broke, so both are flagged. */
export const recordLibraryPassFailure = (connector: FileSyncBackendKind, error: string) => {
  recordFlow({ ...bookFile(connector, 'pull'), error });
  recordFlow({ ...bookFile(connector, 'push'), error });
};

interface LibraryBackendOutcome {
  result: SyncLibraryResult;
  provider: FileSyncProvider;
  deviceId: string;
  settings: SystemSettings;
}

/** One backend's library sync. Throws; the caller isolates the failure. */
const syncOneBackend = async (
  envConfig: EnvConfigType,
  kind: FileSyncBackendKind,
  _: TranslationFunc,
): Promise<LibraryBackendOutcome | null> => {
  const current = useSettingsStore.getState().settings;
  const built = await buildEngine(envConfig, kind);
  if (!built) return null;
  const { engine, provider, settings } = built;

  const key = settingsKeyForBackend(kind);
  const ps = current[key];
  const deviceId = await ensureFileSyncDeviceId(envConfig, kind);

  const strategy = ps?.strategy ?? 'silent';
  const result = await engine.syncLibrary(useLibraryStore.getState().library, {
    strategy: strategy === 'prompt' ? 'silent' : strategy,
    syncBooks: ps?.syncBooks ?? false,
    fullSync: false,
    concurrency: 6,
    deviceId,
    onProgress: ({ index, total, action }) => {
      const label = action === 'downloading' ? _('Downloading') : _('Uploading');
      useFileSyncStore
        .getState()
        .updateProgress(
          kind,
          _('{{action}} {{n}} / {{total}}', { action: label, n: index + 1, total }),
        );
    },
  });

  recordLibraryPass(kind, result);
  return { result, provider, deviceId, settings };
};

/** Stamp the backend's durable "last successful end-to-end sync" time. */
const stampLastSyncedAt = async (envConfig: EnvConfigType, kind: FileSyncBackendKind) => {
  const appService = await envConfig.getAppService();
  const key = settingsKeyForBackend(kind);
  const latest = useSettingsStore.getState().settings;
  const next = { ...latest, [key]: { ...latest[key], lastSyncedAt: Date.now() } };
  useSettingsStore.getState().setSettings(next);
  await appService.saveSettings(next);
};

/**
 * Run one library-wide sync PASS across every enabled third-party backend
 * (#5062) — the shared execution owner for surfaces outside the auto-sync hooks
 * (the SettingsMenu sync row, pull to refresh).
 *
 * The backends run one after another, in a fixed order, against the SAME local
 * library — which is the merge point, so backend N sees everything backends
 * 1..N-1 pulled in. The last-to-first edge lands on the next pass; a pull that
 * changed the library re-triggers the debounced auto-sync, so it converges
 * without extra machinery.
 *
 * The mutex is held for the WHOLE pass, not per backend: releasing between
 * backends would let an auto-sync start a second reconcile of the same library.
 *
 * Failure is isolated per backend. An expired Drive token throws a terminal
 * AUTH_FAILED, and the pass records it and moves on — redundancy is worthless
 * if a dead mirror takes the live one down with it. Returns the summed result
 * of the backends that succeeded, or null when none did.
 */
export const runFileLibrarySyncPass = async (
  envConfig: EnvConfigType,
  _: TranslationFunc,
): Promise<SyncLibraryResult | null> => {
  // Paused means paused (#4959): a downgraded account's still-enabled backends
  // must not sync, and must not fall back to Readest Cloud either.
  const backends = getActiveFileSyncBackends(useSettingsStore.getState().settings);
  if (backends.length === 0) return null;

  // NEVER sync a library that is not loaded from disk: pushing an empty index
  // would clobber the remote.
  if (!useLibraryStore.getState().libraryLoaded) return null;

  if (!useFileSyncStore.getState().beginSync(backends[0]!, _('Syncing…'))) return null;

  let merged: SyncLibraryResult | null = null;
  try {
    for (let i = 0; i < backends.length; i++) {
      const kind = backends[i]!;
      if (i > 0) useFileSyncStore.getState().switchSync(kind, _('Syncing…'));
      try {
        const outcome = await syncOneBackend(envConfig, kind, _);
        if (outcome) {
          const { result, provider, deviceId, settings: providerSettings } = outcome;
          // Statistics are an independent opt-in channel riding on the same
          // provider. A failure must not rewrite the library's counted result
          // or be recorded as a library failure — but it does fail this
          // backend's run, so lastSyncedAt must not claim a clean end-to-end
          // pass and lastError must keep saying what actually broke.
          let statsError: string | null = null;
          const live = useSettingsStore.getState().settings;
          if (live[settingsKeyForBackend(kind)]?.syncStats) {
            try {
              await runFileStatsSyncForBackend(envConfig, kind, {
                provider,
                deviceId,
                // Pin the stats target to what this provider was built for,
                // so a settings edit during the (long) library pass cannot
                // acknowledge the new target through the old connection.
                settings: providerSettings,
              });
            } catch (e) {
              statsError = e instanceof Error ? e.message : String(e);
              console.warn('[cloudSync] statistics file sync failed', kind, e);
            }
          }
          const libraryError = formatSyncFailure(result, _);
          useFileSyncStore
            .getState()
            .setLastError(kind, [libraryError, statsError].filter(Boolean).join('\n') || null);
          if (!statsError && !result.failures && !result.indexPushFailed) {
            await stampLastSyncedAt(envConfig, kind);
          }
          // Spread the latest counters, but ACCUMULATE everything that reports
          // trouble — a plain spread let a healthy second mirror erase the
          // first one's failures and its unwritten index (#5900).
          merged = merged
            ? {
                ...result,
                booksSynced: merged.booksSynced + result.booksSynced,
                failures: merged.failures + result.failures,
                failedBooks: [...merged.failedBooks, ...result.failedBooks],
                indexPushFailed: merged.indexPushFailed || result.indexPushFailed,
              }
            : result;
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        useFileSyncStore.getState().setLastError(kind, message);
        recordLibraryPassFailure(kind, message);
        console.warn('[cloudSync] library file sync failed', kind, e);
      }
    }
  } finally {
    const held = useFileSyncStore.getState().activeKind;
    useFileSyncStore.getState().endSync(held ?? backends[0]!);
  }
  return merged;
};

/**
 * Explicit per-book Upload, mirrored to EVERY enabled backend — the Book Details
 * / bookshelf cloud buttons call this alongside (or instead of) the Readest
 * Cloud transfer queue. Pushes the binary (HEAD short-circuited; an
 * already-mirrored file counts as success) plus the cover, best-effort per
 * backend. Succeeds when at least one backend took the book. Toasts are the
 * caller's job.
 */
export const runFileBookUpload = async (envConfig: EnvConfigType, book: Book): Promise<boolean> => {
  const backends = getActiveFileSyncBackends(useSettingsStore.getState().settings);
  let anyUploaded = false;
  for (const kind of backends) {
    try {
      const built = await buildEngine(envConfig, kind);
      if (!built) continue;
      const { engine } = built;
      const result = await engine.pushBookFile(book);
      if (result.uploaded) recordFlow({ ...bookFile(kind, 'push'), bookTitle: book.title });
      if (!result.uploaded && result.reason !== 'remote-matches') continue;
      anyUploaded = true;
      try {
        await engine.pushBookCover(book);
      } catch (e) {
        console.warn('[cloudSync] book cover upload failed', kind, book.hash, e);
      }
    } catch (e) {
      console.warn('[cloudSync] book upload failed', kind, book.hash, e);
      recordFlow({
        ...bookFile(kind, 'push'),
        bookTitle: book.title,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return anyUploaded;
};

/**
 * Explicit per-book Download (also reached when opening a book whose file is not
 * local). Tries the enabled backends in order and stops at the first one holding
 * the file — the mirrors are equivalent, so there is nothing to gain from asking
 * the rest. Stamps downloadedAt/coverDownloadedAt like the native download path;
 * persisting the book row (updateBook) and toasts are the caller's job.
 */
export const runFileBookDownload = async (
  envConfig: EnvConfigType,
  book: Book,
  onProgress?: ProgressHandler,
  parentTransferId?: string,
): Promise<boolean> => {
  const backends = getActiveFileSyncBackends(useSettingsStore.getState().settings);
  for (const kind of backends) {
    try {
      const built = await buildEngine(envConfig, kind, parentTransferId);
      if (!built) continue;
      const { engine } = built;
      if (!(await engine.downloadBookFile(book, onProgress))) continue;
      recordFlow({ ...bookFile(kind, 'pull'), bookTitle: book.title });
      book.downloadedAt = Date.now();
      if (!book.coverDownloadedAt) book.coverDownloadedAt = Date.now();
      return true;
    } catch (e) {
      console.warn('[cloudSync] book download failed', kind, book.hash, e);
      recordFlow({
        ...bookFile(kind, 'pull'),
        bookTitle: book.title,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return false;
};
