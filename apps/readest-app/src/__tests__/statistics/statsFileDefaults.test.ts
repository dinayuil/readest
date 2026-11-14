import { describe, expect, test } from 'vitest';
import {
  DEFAULT_GOOGLE_DRIVE_SETTINGS,
  DEFAULT_ICLOUD_SETTINGS,
  DEFAULT_ONEDRIVE_SETTINGS,
  DEFAULT_S3_SETTINGS,
  DEFAULT_WEBDAV_SETTINGS,
} from '@/services/constants';

describe('file-sync statistics defaults', () => {
  test('every third-party backend opts out of statistics sync by default', () => {
    for (const settings of [
      DEFAULT_WEBDAV_SETTINGS,
      DEFAULT_GOOGLE_DRIVE_SETTINGS,
      DEFAULT_S3_SETTINGS,
      DEFAULT_ONEDRIVE_SETTINGS,
      DEFAULT_ICLOUD_SETTINGS,
    ]) {
      expect(settings.syncStats).toBe(false);
    }
  });
});
