import { useState, useCallback, useEffect, useMemo } from 'react';
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
import { ACCOUNTLESS_BUILD, isCustomTranslatorAllowed } from '@/utils/access';
import { eventDispatcher } from '@/utils/event';
import { getLocale } from '@/utils/misc';
import { useEnv } from '@/context/EnvContext';
import {
  ensureCustomTranslatorsLoaded,
  useCustomTranslatorStore,
} from '@/store/customTranslatorStore';
import { isCustomTranslatorName } from '@/services/translators/custom';
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
const resolveAvailableProvider = (
  name: string | undefined,
  hasToken: boolean,
  hasPremium: boolean,
): TranslatorName => {
  const available = getTranslators()
    // FORK (ACCOUNTLESS_BUILD): a provider whose `authRequired` is set is served
    // by Readest's backend against a signed-in account, so it can never run in
    // this build — not even as a fallback.
    .filter((t) => !ACCOUNTLESS_BUILD || !t.authRequired)
    .filter((t) => isTranslatorAvailable(t, hasToken, hasPremium));
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
  promptId,
  bookTitle,
  bookAuthor,
}: UseTranslatorOptions = {}) {
  const _ = useTranslation();
  const { token } = useAuth();
  const { envConfig } = useEnv();
  const [loading, setLoading] = useState(false);
  const customTranslators = useCustomTranslatorStore((s) => s.translators);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const translators = useMemo(() => getTranslators(), [customTranslators]);
  // Seeded from the resolver, so the very first `translate()` call already hits
  // a provider this build can run.
  const [selectedProvider, setSelectedProvider] = useState(() =>
    resolveAvailableProvider(provider, !!token, isCustomTranslatorAllowed(token)),
  );
  const [translator, setTransltor] = useState(() =>
    getTranslator(resolveAvailableProvider(provider, !!token, isCustomTranslatorAllowed(token))),
  );

  useEffect(() => {
    ensureCustomTranslatorsLoaded(envConfig);
  }, [envConfig]);

  useEffect(() => {
    setLoading(false);
  }, [provider, sourceLang, targetLang]);

  useEffect(() => {
    const hasPremium = isCustomTranslatorAllowed(token);
    const selectedProviderName = resolveAvailableProvider(provider, !!token, hasPremium);
    setTransltor(getTranslator(selectedProviderName));
    setSelectedProvider(selectedProviderName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, translators, token]);

  const translate = useCallback(
    async (
      input: string[],
      options?: { source?: string; target?: string; useCache?: boolean },
    ): Promise<string[]> => {
      const sourceLanguage = options?.source || sourceLang;
      const targetLanguage = options?.target || targetLang || getLocale();
      const useCache = options?.useCache ?? false;
      const context = { promptId, bookTitle, bookAuthor };
      const activeTranslator = translators.find((t) => t.name === selectedProvider);
      const cacheProvider =
        activeTranslator?.getCacheKey?.(sourceLanguage, targetLanguage, context) ??
        selectedProvider;
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
            cacheProvider,
          );
          if (cachedTranslation) return;

          textsNeedingTranslation.push(text);
          indicesNeedingTranslation.push(index);
        }),
      );

      if (textsNeedingTranslation.length === 0) {
        const results = await Promise.all(
          textsToTranslate.map((text) =>
            getFromCache(text, sourceLanguage, targetLanguage, cacheProvider).then(
              (cached) => cached || text,
            ),
          ),
        );

        return enablePolishing ? polish(results, targetLanguage) : results;
      }

      setLoading(true);

      try {
        if (!activeTranslator) {
          throw new Error(`No translator found for provider: ${selectedProvider}`);
        }
        const translatedTexts = await activeTranslator.translate(
          textsNeedingTranslation,
          sourceLanguage,
          targetLanguage,
          token,
          useCache,
          undefined,
          context,
        );

        await Promise.all(
          textsNeedingTranslation.map(async (text, index) => {
            return storeInCache(
              text,
              translatedTexts[index] || '',
              sourceLanguage,
              targetLanguage,
              cacheProvider,
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
                cacheProvider,
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
        if (
          err instanceof Error &&
          err.message === ErrorCodes.UNAUTHORIZED &&
          isCustomTranslatorName(selectedProvider)
        ) {
          eventDispatcher.dispatch('toast', {
            timeout: 5000,
            message: _('Check the API key for {{name}}', { name: activeTranslator?.label }),
            type: 'error',
          });
        }
        setLoading(false);
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedProvider, sourceLang, targetLang, translators, token, promptId, bookTitle, bookAuthor],
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
