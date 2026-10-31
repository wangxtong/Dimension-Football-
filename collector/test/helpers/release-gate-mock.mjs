// Offline unit-test dependency, never imported by any production entrypoint.
export async function requireGreenForecastDelivery() {
  return { release:'MOCK_ONLY_NOT_PRODUCTION_AUTHORIZATION' };
}
