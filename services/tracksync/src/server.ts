import { openDb } from './db.ts';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const db = openDb(config.dbPath);
const app = await buildApp(db, config);

const shutdown = async () => {
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: config.port, host: config.host });
app.log.info(`TrackSync API at http://${config.host}:${config.port}/api  (db: ${config.dbPath})`);
