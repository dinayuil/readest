import { describe, expect, test } from 'vitest';
import {
  isSafeStatsPathSegment,
  statsFileChunkPath,
  statsFileRootPath,
  statsFileWriterPath,
} from '@/services/statistics/statsFileLayout';

describe('statistics file layout', () => {
  test('root lives under <root>/Readest/stats/v1', () => {
    expect(statsFileRootPath('/')).toBe('/Readest/stats/v1');
    expect(statsFileRootPath('/MyDav')).toBe('/MyDav/Readest/stats/v1');
    expect(statsFileRootPath('/MyDav/')).toBe('/MyDav/Readest/stats/v1');
  });

  test('writer and chunk paths are immutable-file addresses', () => {
    expect(statsFileWriterPath('/', 'device-a')).toBe('/Readest/stats/v1/device-a');
    expect(statsFileChunkPath('/', 'device-a', 'chunk-1')).toBe(
      '/Readest/stats/v1/device-a/chunk-1.json',
    );
    expect(statsFileChunkPath('/MyDav', 'device-a', 'chunk-1')).toBe(
      '/MyDav/Readest/stats/v1/device-a/chunk-1.json',
    );
  });

  test('rejects traversal, separators, and empty segments', () => {
    for (const bad of ['', '.', '..', '../x', 'a/b', 'a\\b', '\u0000x', 'nul\u0000']) {
      expect(isSafeStatsPathSegment(bad)).toBe(false);
      expect(() => statsFileWriterPath('/', bad)).toThrow();
      expect(() => statsFileChunkPath('/', 'device-a', bad)).toThrow();
    }
    expect(isSafeStatsPathSegment('device-a')).toBe(true);
    expect(isSafeStatsPathSegment('a b.json')).toBe(true);
  });
});
