import { describe, expect, test } from 'vitest';
import {
  ACCOUNTLESS_BUILD,
  CLOUD_SYNC_REQUIRES_PREMIUM,
  isCloudSyncAllowed,
  isCloudSyncInPlan,
} from '@/utils/access';
import {
  getActiveFileSyncBackends,
  isReadestCloudEnabled,
} from '@/services/sync/cloudSyncProvider';
import type { SystemSettings } from '@/types/settings';

/**
 * The fork's contract in one place: with {@link ACCOUNTLESS_BUILD} on, a
 * signed-out device runs the WebDAV / S3 / Drive sync the user configured
 * themselves. The plan-shape rules keep their own coverage in
 * `components/settings/cloudSync.test.ts` and `services/sync/cloudSyncProvider.test.ts`;
 * this file pins only the fork behaviour and the derived default it leans on.
 */
describe('ACCOUNTLESS_BUILD', () => {
  test('takes third-party cloud sync off the plan entirely', () => {
    expect(ACCOUNTLESS_BUILD).toBe(true);
    // Derived, not hard-coded: flipping the fork token alone restores the
    // paywall, so the two can never drift apart.
    expect(CLOUD_SYNC_REQUIRES_PREMIUM).toBe(!ACCOUNTLESS_BUILD);
    for (const plan of ['free', 'plus', 'pro', 'purchase'] as const) {
      expect(isCloudSyncAllowed(plan, false)).toBe(true);
    }
  });

  test('leaves a signed-out device (plan `free`) with its backends running', () => {
    const settings = { webdav: { enabled: true } } as unknown as SystemSettings;
    // `free` is what every gate sees before an auth resolution — the exact
    // state that used to set `paused` and hand back an empty list, making the
    // user's own storage silently inert.
    expect(isCloudSyncInPlan('free', false)).toBe(false);
    expect(getActiveFileSyncBackends(settings, 'free')).toEqual(['webdav']);
  });

  test('lets Readest Cloud switch itself off through its derived default', () => {
    // Load-bearing for the fork, and the reason `isReadestCloudEnabled` is
    // left untouched: the official channels are not forced off in code, they
    // turn themselves off as soon as a third-party backend is enabled. Forcing
    // them off here instead would rewrite the derived-default contract that
    // ten upstream cases in cloudSyncProvider.test.ts assert.
    expect(isReadestCloudEnabled({ webdav: { enabled: true } } as SystemSettings)).toBe(false);
    expect(isReadestCloudEnabled({} as SystemSettings)).toBe(true);
    expect(isReadestCloudEnabled({ readestCloud: { enabled: false } } as SystemSettings)).toBe(
      false,
    );
  });
});
