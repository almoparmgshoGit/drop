import type * as SentryNode from '@sentry/node';

/**
 * Error reporting to Sentry, only when SENTRY_DSN is set; without it every function here does nothing and
 * @sentry/node is never loaded. Events leave the server scrubbed: no auth headers, cookies, tokens, passwords,
 * phone numbers or identity numbers, and the user is known by account id only.
 */
let sentry: typeof SentryNode | null = null;

const SENSITIVE_KEY = /authorization|cookie|token|password|secret|otp|code|phone|mobile|whatsapp|email|idnumber|national|iqama|passport|iban|card/i;
const PHONE = /(?:\+?966|00966|\b0)5\d{8}\b|\+\d{9,14}\b/g;
const ID_NUMBER = /\b[12]\d{9}\b/g;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const TOKEN_PARAM = /([?&](?:token|code|otp|access_token)=)[^&\s]*/gi;
const MAX_DEPTH = 6;

export function scrubText(value: string) {
  return value.replace(BEARER, 'Bearer [redacted]').replace(TOKEN_PARAM, '$1[redacted]').replace(PHONE, '[phone]').replace(ID_NUMBER, '[id]');
}

export function scrubValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (!value || typeof value !== 'object' || depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? '[redacted]' : scrubValue(item, depth + 1)]));
}

function scrubEvent<T extends SentryNode.Event>(event: T): T {
  if (event.request) {
    const { headers, cookies: _cookies, data, query_string, url, ...rest } = event.request;
    event.request = {
      ...rest,
      url: url ? scrubText(url) : url,
      headers: headers ? (scrubValue(headers) as Record<string, string>) : undefined,
      data: data === undefined ? undefined : scrubValue(data),
      query_string: typeof query_string === 'string' ? scrubText(query_string) : query_string ? (scrubValue(query_string) as typeof query_string) : undefined,
    };
  }
  if (event.user) event.user = event.user.id ? { id: event.user.id } : undefined;
  if (event.message) event.message = scrubText(event.message);
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubText(exception.value);
  }
  if (event.extra) event.extra = scrubValue(event.extra) as typeof event.extra;
  if (event.contexts) event.contexts = scrubValue(event.contexts) as typeof event.contexts;
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((crumb) => ({ ...crumb, message: crumb.message ? scrubText(crumb.message) : crumb.message, data: crumb.data ? (scrubValue(crumb.data) as typeof crumb.data) : crumb.data }));
  }
  return event;
}

/** Called once, before the app is created. Returns whether reporting is on. */
export function initErrorReporting() {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn || sentry) return !!sentry;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const loaded: typeof SentryNode = require('@sentry/node');
  const tracesSampleRate = Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0);
  loaded.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    release: process.env.SENTRY_RELEASE || undefined,
    // Nothing about the person or their request is collected automatically; beforeSend scrubs what remains.
    dataCollection: { userInfo: false, cookies: false, httpHeaders: { request: { allow: ['user-agent', 'content-type'] }, response: false }, httpBodies: [], urlQueryParams: false },
    ...(tracesSampleRate > 0 && { tracesSampleRate }),
    beforeSend: (event) => scrubEvent(event),
    beforeSendTransaction: (event) => scrubEvent(event),
  });
  sentry = loaded;
  return true;
}

export const isErrorReportingEnabled = () => !!sentry;

type RequestLike = { method?: string; route?: { path?: string }; originalUrl?: string; url?: string; user?: { userId?: string; role?: string } };

/** Reports a server error (a 5xx or a failed background job). The request adds its route and the account id, nothing else. */
export function reportError(error: unknown, request?: RequestLike, extra?: Record<string, unknown>) {
  if (!sentry) return;
  try {
    sentry.withScope((scope) => {
      if (request) {
        const path = (request.originalUrl ?? request.url ?? '').split('?')[0];
        scope.setTag('route', request.route?.path ?? path);
        if (request.method) scope.setTag('method', request.method);
        scope.setContext('request', { method: request.method, path: scrubText(path) });
        if (request.user?.userId) scope.setUser({ id: request.user.userId });
        if (request.user?.role) scope.setTag('role', request.user.role);
      }
      if (extra) scope.setContext('extra', scrubValue(extra) as Record<string, unknown>);
      sentry!.captureException(error);
    });
  } catch {
    // Reporting must never turn into a second failure.
  }
}

/** An error the mobile app sent; it is reported as an event of its own, tagged with where it came from. */
export function reportClientError(report: { message: string; stack?: string; platform?: string; appVersion?: string; screen?: string; fatal?: boolean; userId?: string }) {
  if (!sentry) return false;
  try {
    sentry.withScope((scope) => {
      scope.setTag('source', 'mobile-app');
      if (report.platform) scope.setTag('platform', report.platform);
      if (report.appVersion) scope.setTag('app_version', report.appVersion);
      if (report.screen) scope.setTag('screen', report.screen);
      scope.setLevel(report.fatal ? 'fatal' : 'error');
      if (report.userId) scope.setUser({ id: report.userId });
      if (report.stack) scope.setContext('client', { stack: scrubText(report.stack) });
      sentry!.captureMessage(scrubText(report.message));
    });
    return true;
  } catch {
    return false;
  }
}

/** Waits for queued events to be sent, so a crash on startup still reaches Sentry. */
export async function flushErrorReports(timeoutMs = 2000) {
  if (!sentry) return;
  await sentry.flush(timeoutMs).catch(() => undefined);
}
