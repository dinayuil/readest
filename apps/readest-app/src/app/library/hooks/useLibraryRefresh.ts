import type { RefObject } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useAppRouter } from '@/hooks/useAppRouter';
import { useABSSync } from '@/hooks/useABSSync';
import { useOPDSSubscriptions } from '@/hooks/useOPDSSubscriptions';
import { usePullToRefresh } from '@/hooks/usePullToRefresh';
import { useSettingsStore } from '@/store/settingsStore';
import { getActiveFileSyncBackends } from '@/services/sync/cloudSyncProvider';
import { ACCOUNTLESS_BUILD } from '@/utils/access';
import { promptMissingSyncProvider } from '@/utils/accountless';
import { navigateToLogin } from '@/utils/nav';

export function useLibraryRefresh(
  scrollRef: RefObject<HTMLDivElement | null>,
  pullLibrary: (fullRefresh?: boolean, verbose?: boolean) => Promise<void>,
) {
  const { user } = useAuth();
  const router = useAppRouter();
  const { checkOPDSSubscriptions } = useOPDSSubscriptions();
  const { checkABSServers } = useABSSync();

  const refresh = async (fullRefresh: boolean) => {
    const { settings } = useSettingsStore.getState();
    const hasExternalSources =
      getActiveFileSyncBackends(settings).length > 0 ||
      settings.opdsCatalogs?.some((c) => !c.disabled && !c.deletedAt) ||
      settings.absServers?.some((s) => !s.disabled && !s.deletedAt) ||
      settings.kosync?.enabled ||
      settings.bookorbit?.enabled;
    if (!user && !hasExternalSources) {
      // FORK (ACCOUNTLESS_BUILD): the pull gesture must not dead-end on a
      // sign-in page in a build that hides every account entry. With nothing
      // enabled there is nothing to sync, so point at the setting instead.
      if (ACCOUNTLESS_BUILD) {
        promptMissingSyncProvider();
      } else {
        navigateToLogin(router);
      }
      return;
    }
    await pullLibrary(fullRefresh, true);
    await checkOPDSSubscriptions(true);
    await checkABSServers();
  };

  usePullToRefresh(
    scrollRef,
    () => refresh(false),
    () => refresh(true),
  );
}
