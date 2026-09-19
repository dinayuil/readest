import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

/**
 * Regression guard for a first-call provider bug: the annotator popup fires its
 * first translation on mount, and the resolved provider used to be computed in
 * an effect — one render too late. A caller whose persisted provider cannot run
 * here (DeepL always; Azure/Yandex on web) therefore hit the account-only
 * provider on the very first paragraph of every book and threw
 * "Authentication token is required for DeepL translation".
 */

const deeplTranslate = vi.fn(async () => {
  throw new Error('Authentication token is required for DeepL translation');
});
const googleTranslate = vi.fn(async (text: string[]) => text.map((line) => `[${line}]`));

const deepl = {
  name: 'deepl',
  label: 'DeepL',
  authRequired: true,
  translate: deeplTranslate,
};
const google = {
  name: 'google',
  label: 'Google Translate',
  translate: googleTranslate,
};

vi.mock('@/utils/access', () => ({ ACCOUNTLESS_BUILD: true }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ token: null, user: null }) }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (key: string) => key }));
vi.mock('@/utils/misc', () => ({ getLocale: () => 'en', stubTranslation: (key: string) => key }));
vi.mock('@/services/translators', () => ({
  ErrorCodes: { DAILY_QUOTA_EXCEEDED: 'DAILY_QUOTA_EXCEEDED' },
  getTranslators: () => [deepl, google],
  getTranslator: (name: string) => [deepl, google].find((t) => t.name === name),
  isTranslatorAvailable: (t: { authRequired?: boolean }, hasToken: boolean) =>
    !(t.authRequired && !hasToken),
  getFromCache: async () => null,
  storeInCache: async () => {},
  polish: (results: string[]) => results,
  preprocess: (text: string[]) => text,
}));

const { useTranslator } = await import('@/hooks/useTranslator');

describe('useTranslator — availability fallback', () => {
  it('never dispatches to a provider this build cannot run, not even on the first call', async () => {
    const { result } = renderHook(() => useTranslator({ provider: 'deepl', targetLang: 'fr' }));

    expect(result.current.selectedProvider).toBe('google');
    expect(result.current.translator?.name).toBe('google');

    await expect(result.current.translate(['Hello'])).resolves.toEqual(['[Hello]']);
    expect(deeplTranslate).not.toHaveBeenCalled();
    expect(googleTranslate).toHaveBeenCalled();
  });

  it('keeps an available provider as requested', async () => {
    const { result } = renderHook(() => useTranslator({ provider: 'google', targetLang: 'fr' }));

    expect(result.current.selectedProvider).toBe('google');
  });
});
