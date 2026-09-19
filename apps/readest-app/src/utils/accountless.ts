import { ACCOUNTLESS_BUILD } from '@/utils/access';
import { eventDispatcher } from '@/utils/event';
import { stubTranslation as _ } from '@/utils/misc';

/**
 * FORK (see {@link ACCOUNTLESS_BUILD}): the one user-facing prompt this build
 * needs where stock Readest would route to the sign-in page or the upgrade
 * page — "there is nothing to sync with yet, and here is where to fix that".
 *
 * The sync surfaces call it whenever a gesture cannot do anything: the
 * library's pull-to-refresh and the reader's sync row. Both used to send a
 * signed-out user to `/auth`, which this build hides entirely, so without a
 * prompt the gesture would dead-end in silence.
 */
export const promptMissingSyncProvider = (): void => {
  if (!ACCOUNTLESS_BUILD) return;
  eventDispatcher.dispatch('toast', {
    type: 'info',
    timeout: 5000,
    message: _('Enable a cloud storage provider in Settings → Integrations to sync'),
  });
};
