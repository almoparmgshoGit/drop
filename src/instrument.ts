// Imported first by main.ts, so error reporting is set up before anything else loads. Does nothing without SENTRY_DSN.
import { initErrorReporting } from './common/monitoring/error-reporter';

initErrorReporting();
