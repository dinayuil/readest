import type { SystemSettings } from '@/types/settings';
import type { UserPlan } from '@/types/quota';
import { isWebAppPlatform } from '@/services/environment';
import { hasValidWebDriveToken } from '@/services/sync/providers/gdrive/auth/webTokenStore';
import { isICloudSupportedPlatform } from '@/services/sync/providers/icloud/buildICloudProvider';
import { getActiveFileSyncBackends } from '@/services/sync/cloudSyncProvider';
import type { FileSyncBackendKind } from './providerRegistry';

/**
 * Whether a backend's transport can work at all right now. Web Google Drive
 * tokens are session-scoped with no refresh; once expired, every run aborts with
 * a terminal AUTH_FAILED on the index pull. Skipping is quieter than failing:
 * the Drive settings form already shows a Reconnect CTA, and a doomed request on
 * every library change would just spam the log and the row's error state.
 *
 * This lives in the runner layer, not the hooks, so the manual "Sync now", the
 * library auto-sync, the reader's per-book sync and the statistics runner all
 * honour it.
 *
 * iCloud is additionally platform-gated: its `enabled` flag can reach a
 * Windows/Android/web device via a settings backup restore, and only the
 * iOS/macOS Tauri apps can reach a ubiquity container.
 */
export const canBackendRun = (kind: FileSyncBackendKind): boolean => {
  if (kind === 'gdrive' && isWebAppPlatform() && !hasValidWebDriveToken()) return false;
  if (kind === 'icloud' && !isICloudSupportedPlatform()) return false;
  return true;
};

/**
 * The enabled backends that can ACTUALLY sync right now — {@link
 * getActiveFileSyncBackends} minus any that {@link canBackendRun} rules out
 * (web Google Drive with a gone/expired token). Display surfaces use this so a
 * provider that is enabled but silently skipped is not counted as active or
 * reported as synced.
 */
export const getReadyFileSyncBackends = (
  settings: SystemSettings | null | undefined,
  plan?: UserPlan,
): FileSyncBackendKind[] =>
  getActiveFileSyncBackends(settings, plan).filter((k) => canBackendRun(k));
