import type { SystemSettings } from '@/types/settings';
import type { FileSyncBackendKind } from '@/services/sync/file/providerRegistry';
import { normalizeRoot } from '@/services/sync/file/layout';

/**
 * Stable identity of one statistics sync target.
 *
 * The offset/confirmation tables are keyed by this string, so changing the
 * account, server, bucket or root directory must look like a brand-new target
 * and re-backfill history rather than reusing another target's acknowledgements.
 * Secrets are deliberately absent: passwords, S3 access keys and OAuth tokens
 * never enter this id (or any remote file).
 */
export type StatsFileTargetSettings = Pick<
  SystemSettings,
  'webdav' | 'googleDrive' | 's3' | 'onedrive' | 'icloud'
>;

/**
 * URL pathname normalisation only trims the trailing slash. Repeated slashes
 * and backslashes are part of the actual remote path (the layout helpers keep
 * them), so folding them would alias two different locations onto one target.
 */
const normalizeUrlPath = (pathname: string): string => {
  let value = pathname || '/';
  if (!value.startsWith('/')) value = `/${value}`;
  if (value.length > 1) value = value.replace(/\/+$/, '');
  return value || '/';
};

/**
 * Origin + path only. Userinfo (a password embedded in the URL), query and
 * fragment are dropped, and host casing / default ports are normalised by URL.
 * An unparseable value contributes NOTHING rather than its raw text: a
 * half-typed URL carrying embedded credentials must never be persisted into
 * the target id (or a log/backup that carries it). Such a backend cannot sync
 * anyway until its URL is valid.
 */
const normalizeServerUrl = (raw: string | undefined): string => {
  const value = (raw ?? '').trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${normalizeUrlPath(url.pathname)}`;
  } catch {
    return '';
  }
};

/**
 * Account labels are compared case-insensitively (emails / UPNs are), while
 * WebDAV usernames and path segments keep their exact case: `/Books` and
 * `/books`, like `Reader` and `reader`, may be different accounts or roots.
 */
const label = (value: string | undefined): string => (value ?? '').trim().toLowerCase();
const exact = (value: string | undefined): string => (value ?? '').trim();

/**
 * `providerRootPath` is the provider's normalised root (always '/' for the
 * cloud APIs, configurable for WebDAV). It is appended even when settings
 * already carry a root path: a provider-level change that alters where files
 * land must invalidate the target's acknowledgements.
 */
export const statsFileTargetId = (
  kind: FileSyncBackendKind,
  settings: StatsFileTargetSettings,
  providerRootPath: string = '/',
): string => {
  // Exactly the path normalisation the file-sync layout uses. Do not collapse
  // `//` or convert `\`: those address different remote locations.
  const providerRoot = normalizeRoot(providerRootPath);
  // A JSON tuple, not a delimiter-joined string: usernames and root paths may
  // legitimately contain '|', and two different pairs must never collapse into
  // the same target (which would share acknowledgement cursors).
  switch (kind) {
    case 'webdav': {
      const webdav = settings.webdav;
      return JSON.stringify([
        'webdav',
        normalizeServerUrl(webdav?.serverUrl),
        exact(webdav?.username),
        normalizeRoot(webdav?.rootPath),
        providerRoot,
      ]);
    }
    case 's3': {
      const s3 = settings.s3;
      // Keys are intentionally left out: rotating credentials must not orphan a
      // target that still points at the same endpoint, region and bucket.
      return JSON.stringify([
        's3',
        normalizeServerUrl(s3?.endpoint),
        label(s3?.region),
        exact(s3?.bucket),
        providerRoot,
      ]);
    }
    case 'gdrive':
      return JSON.stringify(['gdrive', label(settings.googleDrive?.accountLabel), providerRoot]);
    case 'onedrive':
      return JSON.stringify(['onedrive', label(settings.onedrive?.accountLabel), providerRoot]);
    case 'icloud':
      // The ubiquity container is fixed per app; there is no account or URL in
      // settings to distinguish, but a changed provider root still must.
      return JSON.stringify(['icloud', providerRoot]);
  }
};
