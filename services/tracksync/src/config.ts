export interface Config {
  port: number;
  host: string;
  dbPath: string;
  allowRegistration: boolean;
  corsOrigins: string[] | '*';
  internalToken: string | null;
  trackerUrl: string | null;
  legacyApiUrl: string;
  publicUrl: string | null;
  trustProxy: boolean;
}

const bool = (v: string | undefined, d: boolean) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

export function loadConfig(env = process.env): Config {
  const cors = env.CORS_ORIGINS?.trim();
  return {
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? '0.0.0.0',
    dbPath: env.DB_PATH ?? './data/tracksync.db',
    allowRegistration: bool(env.ALLOW_REGISTRATION, true),
    corsOrigins: !cors ? [] : cors === '*' ? '*' : cors.split(',').map((s) => s.trim()).filter(Boolean),
    internalToken: env.INTERNAL_TOKEN?.trim() || null,
    trackerUrl: env.TRACKER_URL?.trim().replace(/\/+$/, '') || null,
    legacyApiUrl: env.LEGACY_API_URL?.trim() || 'https://wenchy.net/ao3track/api',
    publicUrl: env.PUBLIC_URL?.trim().replace(/\/+$/, '') || null,
    trustProxy: bool(env.TRUST_PROXY, false),
  };
}
