import type { ConnectionOptions } from "node:tls";

/** How a Postgres connection authenticates the server (libpq vocabulary). */
export type PgTlsMode = "verify-ca" | "verify-full" | "unverified" | "disabled";

/** What decided the mode: the pinned CA, the call site's config, a DATABASE_URL ssl param, or a loopback exemption. */
export type PgTlsSource = "PG_CA_CERT" | "config" | "url" | "loopback";

export type PgSsl = ConnectionOptions | false | undefined;

export interface ResolvePgTlsOptions {
  /** Whether this call site asked for TLS before pinning existed. */
  legacyTls: boolean;
  /** What the call site passed when it did NOT want TLS (default `undefined`). */
  legacySslOff?: false | undefined;
  env?: Record<string, string | undefined>;
}

export interface PgTlsResolution {
  connectionString: string;
  ssl: PgSsl;
  mode: PgTlsMode;
  source: PgTlsSource;
  /** True when PG_CA_CERT is set (whether or not this particular connection used it). */
  pinned: boolean;
}

export function parseCaCert(raw: string): string;
export function parseVerifyHostname(raw: string | undefined): boolean;
export function isLocalSocketOrLoopback(connectionString: string): boolean;
export function resolvePgTls(connectionString: string, opts: ResolvePgTlsOptions): PgTlsResolution;
export function pgConnectionConfig(
  connectionString: string,
  opts: ResolvePgTlsOptions
): { connectionString: string; ssl: PgSsl };
export function shouldUseSsl(databaseUrl: string, env?: Record<string, string | undefined>): boolean;
