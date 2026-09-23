import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const app = await buildApp(config);
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, async () => { await app.close(); process.exit(0); });
await app.listen({ port: config.port, host: config.host });
