// No independent release-evidence authority is configured. Authentication, report
// JSON and runtime flags cannot grant permission to publish model forecasts.
export function requireHostedForecastRelease() {
  throw Object.assign(new Error('RELEASE_GATE_BLOCKED'), { code: 'RELEASE_GATE_BLOCKED', status: 409 });
}
