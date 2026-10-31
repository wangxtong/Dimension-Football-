// Only enumerated metadata may cross the adapter -> persistent health boundary.
export const FAILURE_CODES = new Set([
  'response_too_large', 'invalid_json', 'invalid_response', 'incomplete_response',
  'duplicate_fixture_id', 'too_many_fixtures', 'authorization_required', 'access_denied',
  'rate_limited', 'http_unavailable', 'stale_response', 'plan_restricted', 'quota_exceeded',
  'api_error', 'timeout', 'network_unavailable', 'fixture_limit_reached',
  'invalid_records', 'source_unavailable', 'subscription_required', 'not_configured',
  'invalid_credentials', 'request_limit', 'redirect_blocked', 'cancelled', 'budget_exhausted',
]);

// Never persist raw header text. Bound hostile values to one day.
export function retryAfterMs(value, now) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const delay = /^\d+$/.test(value.trim()) ? Number(value.trim()) * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) && delay > 0 ? Math.min(Math.ceil(delay), 86_400_000) : null;
}
