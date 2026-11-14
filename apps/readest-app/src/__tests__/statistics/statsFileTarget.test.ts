import { describe, expect, test } from 'vitest';
import {
  statsFileTargetId,
  type StatsFileTargetSettings,
} from '@/services/statistics/statsFileTarget';

const base = (): StatsFileTargetSettings => ({
  webdav: {
    enabled: true,
    serverUrl: 'https://dav.example.com/remote.php/dav/files/reader/',
    username: 'reader',
    password: 'pw-value',
    rootPath: '/Readest Mirror/',
  },
  googleDrive: { enabled: true, accountLabel: 'Reader@Example.com' },
  s3: {
    enabled: true,
    endpoint: 'https://account.r2.cloudflarestorage.com/',
    region: 'auto',
    bucket: 'readest-stats',
    accessKeyId: 'AKIA-ONE',
    secretAccessKey: 's3-secret-value',
  },
  onedrive: { enabled: true, accountLabel: 'reader@example.com' },
  icloud: { enabled: true },
});

describe('statsFileTargetId', () => {
  test('is stable across input ordering, URL trailing slashes and path doubling', () => {
    const a = statsFileTargetId('webdav', base(), '/');
    const b = base();
    b.webdav!.serverUrl = 'https://DAV.example.com/remote.php/dav/files/reader';
    b.webdav!.rootPath = 'Readest Mirror';
    expect(statsFileTargetId('webdav', b, '/')).toBe(a);
  });

  test('changes when the WebDAV server, username or root changes', () => {
    const baseId = statsFileTargetId('webdav', base(), '/');
    const server = base();
    server.webdav!.serverUrl = 'https://other.example.com/dav';
    const username = base();
    username.webdav!.username = 'someone-else';
    const root = base();
    root.webdav!.rootPath = '/Other Root';

    expect(statsFileTargetId('webdav', server, '/')).not.toBe(baseId);
    expect(statsFileTargetId('webdav', username, '/')).not.toBe(baseId);
    expect(statsFileTargetId('webdav', root, '/')).not.toBe(baseId);
  });

  test('never contains the WebDAV password or S3 secret keys', () => {
    const settings = base();
    settings.webdav!.serverUrl = 'https://reader:url-embedded-secret@dav.example.com/dav';
    const webdav = statsFileTargetId('webdav', settings, '/');
    expect(webdav).not.toContain('pw-value');
    expect(webdav).not.toContain('url-embedded-secret');
    expect(webdav).toContain('dav.example.com');

    const s3 = statsFileTargetId('s3', settings, '/');
    expect(s3).not.toContain('AKIA-ONE');
    expect(s3).not.toContain('s3-secret-value');
  });

  test('preserves WebDAV username and root case', () => {
    const lower = base();
    lower.webdav!.username = 'reader';
    const upper = base();
    upper.webdav!.username = 'Reader';
    expect(statsFileTargetId('webdav', lower, '/')).not.toBe(
      statsFileTargetId('webdav', upper, '/'),
    );

    const books = base();
    books.webdav!.rootPath = '/Books';
    const booksLower = base();
    booksLower.webdav!.rootPath = '/books';
    expect(statsFileTargetId('webdav', books, '/')).not.toBe(
      statsFileTargetId('webdav', booksLower, '/'),
    );
  });

  test('does not alias distinct roots that the real layout keeps distinct', () => {
    const repeated = base();
    repeated.webdav!.rootPath = '/A//B';
    const single = base();
    single.webdav!.rootPath = '/A/B';
    expect(statsFileTargetId('webdav', repeated, '/')).not.toBe(
      statsFileTargetId('webdav', single, '/'),
    );

    const backslash = base();
    backslash.webdav!.rootPath = '/A\\B';
    expect(statsFileTargetId('webdav', backslash, '/')).not.toBe(
      statsFileTargetId('webdav', single, '/'),
    );

    // The provider root is also a real storage location, not a pretty label.
    expect(statsFileTargetId('gdrive', base(), '/A//B')).not.toBe(
      statsFileTargetId('gdrive', base(), '/A/B'),
    );
    expect(statsFileTargetId('gdrive', base(), '/A\\B')).not.toBe(
      statsFileTargetId('gdrive', base(), '/A/B'),
    );
  });

  test('a delimiter in one field cannot collide with a different field split', () => {
    const a = base();
    a.webdav!.username = 'user|mirror';
    a.webdav!.rootPath = '/root';
    const b = base();
    b.webdav!.username = 'user';
    b.webdav!.rootPath = '/mirror|root';
    expect(statsFileTargetId('webdav', a, '/')).not.toBe(statsFileTargetId('webdav', b, '/'));
  });

  test('an unparseable server URL never leaks embedded credentials', () => {
    const settings = base();
    settings.webdav!.serverUrl = 'https://reader:bad-url-secret@dav example.com/dav';
    const id = statsFileTargetId('webdav', settings, '/');
    expect(id).not.toContain('dav example.com');
    expect(id).not.toContain('bad-url-secret');
  });

  test('S3 identity survives credential rotation but follows endpoint/bucket/region', () => {
    const first = statsFileTargetId('s3', base(), '/');
    const rotated = base();
    rotated.s3!.accessKeyId = 'AKIA-TWO';
    rotated.s3!.secretAccessKey = 'rotated-s3-secret';
    expect(statsFileTargetId('s3', rotated, '/')).toBe(first);

    const bucket = base();
    bucket.s3!.bucket = 'other-bucket';
    expect(statsFileTargetId('s3', bucket, '/')).not.toBe(first);

    const region = base();
    region.s3!.region = 'eu-central-1';
    expect(statsFileTargetId('s3', region, '/')).not.toBe(first);
  });

  test('account-scoped backends follow the account label and provider root', () => {
    const drive = statsFileTargetId('gdrive', base(), '/');
    const otherDrive = base();
    otherDrive.googleDrive!.accountLabel = 'other@example.com';
    expect(statsFileTargetId('gdrive', otherDrive, '/')).not.toBe(drive);
    expect(statsFileTargetId('gdrive', base(), '/Custom')).not.toBe(drive);

    const oneDrive = statsFileTargetId('onedrive', base(), '/');
    const otherOneDrive = base();
    otherOneDrive.onedrive!.accountLabel = 'other@example.com';
    expect(statsFileTargetId('onedrive', otherOneDrive, '/')).not.toBe(oneDrive);
  });

  test('iCloud is a fixed container identity with a provider-root suffix', () => {
    expect(statsFileTargetId('icloud', base(), '/')).toBe(statsFileTargetId('icloud', base(), '/'));
    expect(statsFileTargetId('icloud', base(), '/Custom')).not.toBe(
      statsFileTargetId('icloud', base(), '/'),
    );
  });

  test('keeps the five backends distinct even with identical root paths', () => {
    const ids = (['webdav', 'gdrive', 's3', 'onedrive', 'icloud'] as const).map((kind) =>
      statsFileTargetId(kind, base(), '/'),
    );
    expect(new Set(ids).size).toBe(5);
  });
});
