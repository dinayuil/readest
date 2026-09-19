import { useState, useCallback, useEffect } from 'react';
import { useAuth } from '@/context/AuthContext';
import {
  ErrorCodes,
  getTranslator,
  getTranslators,
  isTranslatorAvailable,
  TranslatorName,
} from '@/services/translators';
import { getFromCache, storeInCache, UseTranslatorOptions } from '@/services/translators';
import { polish, preprocess } from '@/services/translators';
import { ACCOUNTLESS_BUILD } from '@/utils/access';
import { eventDispatcher } from '@/utils/event';
import { getLocale } from '@/utils/misc';
import { useTranslation } from './useTranslation';

/**
 * The provider that will actually serve the next call: the requested one when it
 * can run here, else the first available fallback.
 *
 * Resolved SYNCHRONOUSLY, not in an effect. `translate` reads the resolved
 * provider from state, so a deferred resolution left a one-render window where a
 * caller that fires on mount — the annotator popup, translate-in-range — sent
 * its first request to the *requested* provider before the fallback landed.
 * With a persisted `deepl` (changing the default does not rewrite settings a
 * user already has) that window was a hard throw on the first paragraph of
 * every book: "Authentication token is required for DeepL translation".
 */
const resolveAvailableProvider = (name: string | undefined, hasToken: boolean): TranslatorName => {
  const available = getTranslators()
    // FORK (ACCOUNTLESS_BUILD): a provider whose `authRequired` is set is served
    // by Readest's backend against a signed-in account, so it can never run in
    // this build — not even as a fallback.
    .filter((t) => !ACCOUNTLESS_BUILD || !t.authRequired)
    .filter((t) => isTranslatorAvailable(t, hasToken));
  const selected = available.find((t) => t.name === name) ?? available[0];
  // Nothing available at all: keep the request as-is so the provider itself
  // reports why (quota reached, relay down) instead of silently switching.
  return (selected?.name ?? name ?? 'deepl') as TranslatorName;
};

export function useTranslator({
  provider = 'deepl',
  sourceLang = 'AUTO',
  targetLang = 'EN',
  enablePolishing = true,
  enablePreprocessing = true,
}: UseTranslatorOptions = {}) {
  const _ = useTranslation();
  const { token } = useAuth();
  const [loading, setLoading] = useState(false);
  // Seeded from the resolver, so the very first `translate()` call already hits
  // a provider this build can run.
  const [selectedProvider, setSelectedProvider] = useState(() =>
    resolveAvailableProvider(provider, !!token),
  );
  const [translator, setTransltor] = useState(() =>
    getTranslator(resolveAvailableProvider(provider, !!token)),
  );
  const [translators] = useState(() => getTranslators());

  useEffect(() => {
    setLoading(false);
  }, [provider, sourceLang, targetLang]);

  useEffect(() => {
    const selectedProviderName = resolveAvailableProvider(provider, !!token);
    setTransltor(getTranslator(selectedProviderName));
    setSelectedProvider(selectedProviderName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  const translate = useCallback(
    async (
      input: string[],
      options?: { source?: string; target?: string; useCache?: boolean },
    ): Promise<string[]> => {
      const sourceLanguage = options?.source || sourceLang;
      const targetLanguage = options?.target || targetLang || getLocale();
      const useCache = options?.useCache ?? false;
      const textsToTranslate = enablePreprocessing ? preprocess(input) : input;

      if (textsToTranslate.length === 0 || textsToTranslate.every((t) => !t?.trim())) {
        return textsToTranslate;
      }

      const textsNeedingTranslation: string[] = [];
      const indicesNeedingTranslation: number[] = [];

      await Promise.all(
        textsToTranslate.map(async (text, index) => {
          if (!text?.trim()) return;

          const cachedTranslation = await getFromCache(
            text,
            sourceLanguage,
            targetLanguage,
            selectedProvider,
          );
          if (cachedTranslation) return;

          textsNeedingTranslation.push(text);
          indicesNeedingTranslation.push(index);
        }),
      );

      if (textsNeedingTranslation.length === 0) {
        const results = await Promise.all(
          textsToTranslate.map((text) =>
            getFromCache(text, sourceLanguage, targetLanguage, selectedProvider).then(
              (cached) => cached || text,
            ),
          ),
        );

        return enablePolishing ? polish(results, targetLanguage) : results;
      }

      setLoading(true);

      try {
        const translator = translators.find((t) => t.name === selectedProvider);
        if (!translator) {
          throw new Error(`No translator found for provider: ${selectedProvider}`);
        }
        const translatedTexts = await translator.translate(
          textsNeedingTranslation,
          sourceLanguage,
          targetLanguage,
          token,
          useCache,
        );

        await Promise.all(
          textsNeedingTranslation.map(async (text, index) => {
            return storeInCache(
              text,
              translatedTexts[index] || '',
              sourceLanguage,
              targetLanguage,
              selectedProvider,
            );
          }),
        );

        const results = [...textsToTranslate];
        indicesNeedingTranslation.forEach((originalIndex, translationIndex) => {
          results[originalIndex] = translatedTexts[translationIndex] || '';
        });

        await Promise.all(
          results.map(async (_, index) => {
            if (!indicesNeedingTranslation.includes(index)) {
              const originalText = textsToTranslate[index];
              if (!originalText?.trim()) return;

              const cachedTranslation = await getFromCache(
                originalText,
                sourceLanguage,
                targetLanguage,
                selectedProvider,
              );

              if (cachedTranslation) {
                results[index] = cachedTranslation;
              }
            }
          }),
        );

        setLoading(false);
        return enablePolishing ? polish(results, targetLanguage) : results;
      } catch (err) {
        if (err instanceof Error && err.message.includes(ErrorCodes.DAILY_QUOTA_EXCEEDED)) {
          eventDispatcher.dispatch('toast', {
            timeout: 5000,
            message: _(
              'Daily translation quota reached. Upgrade your plan to continue using AI translations.',
            ),
            type: 'error',
          });
          setSelectedProvider('azure');
        }
        setLoading(false);
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedProvider, sourceLang, targetLang, translator, token],
  );

  return {
    translate,
    translator,
    translators,
    loading,
    /**
     * The provider the next call will actually use, after the availability
     * fallback — NOT necessarily the requested one. Surfaces that render a
     * provider picker must show this, or they display a provider that is not in
     * their own option list (a persisted `deepl` on an accountless build).
     */
    selectedProvider,
  };
}
