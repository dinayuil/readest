import posthog from 'posthog-js';
import { ACCOUNTLESS_BUILD } from '@/utils/access';

export const TELEMETRY_OPT_OUT_KEY = 'readest-telemetry-opt-out';
export const TELEMETRY_DECISION_KEY = 'readest-telemetry-decision';

export type TelemetryDecision = 'opt-in' | 'opt-out' | 'pending';

/** Fraction of new users shown the consent prompt; the rest are opted out silently. */
export const TELEMETRY_PROMPT_BUCKET_RATE = 0.1;

export const hasOptedOutTelemetry = () => {
  return localStorage.getItem(TELEMETRY_OPT_OUT_KEY) === 'true';
};

export const getTelemetryDecision = (): TelemetryDecision | null => {
  if (typeof window === 'undefined') return null;
  const value = localStorage.getItem(TELEMETRY_DECISION_KEY);
  if (value === 'opt-in' || value === 'opt-out' || value === 'pending') return value;
  return null;
};

export const setTelemetryDecision = (decision: TelemetryDecision) => {
  localStorage.setItem(TELEMETRY_DECISION_KEY, decision);
};

/** Returns true with probability TELEMETRY_PROMPT_BUCKET_RATE. */
export const rollIntoTelemetryPromptBucket = (rng: () => number = Math.random) => {
  return rng() < TELEMETRY_PROMPT_BUCKET_RATE;
};

export const captureEvent = (event: string, properties?: Record<string, unknown>) => {
  // Fork: nothing is handed to PostHog, which `PHContext` never initializes.
  // Belt-and-braces, and it keeps the "no telemetry here" intent greppable.
  if (ACCOUNTLESS_BUILD) return;
  if (!hasOptedOutTelemetry()) {
    posthog.capture(event, properties);
  }
};

export const optInTelemetry = () => {
  // Fork: the opt-in path is gone, so no surface (settings toggle, consent
  // dialog, command palette) can switch telemetry back on.
  if (ACCOUNTLESS_BUILD) return;
  localStorage.setItem(TELEMETRY_OPT_OUT_KEY, 'false');
  setTelemetryDecision('opt-in');
  posthog.opt_in_capturing();
};
export const optOutTelemetry = () => {
  localStorage.setItem(TELEMETRY_OPT_OUT_KEY, 'true');
  setTelemetryDecision('opt-out');
  posthog.opt_out_capturing();
};
