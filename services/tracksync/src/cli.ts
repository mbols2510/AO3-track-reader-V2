// Admin commands, e.g. inside the container:
//   docker compose exec tracksync node dist/cli.js users
import { readFileSync, writeFileSync } from 'node:fs';
import { openDb } from './db.ts';
import { Auth, MIN_PW_SIZE } from './auth.ts';
import { SyncStore } from './sync.ts';
import { loadConfig } from './config.ts';
import { exportFromSyncServer } from '@ao3track/core/legacy';
import { exportFromLegacyDb } from '@ao3track/core/legacydb';

const HELP = `Usage: node dist/cli.js <command> [...args]

  users                                     List accounts with item counts
  create-user <username> <password>         Create an account (even if registration is closed)
  reset-password <username> <new-password>  Set a password and sign out all devices
  migrate <username> <old-user> <old-pass> [old-api-url]
                                            Copy data from the original cloud service into <username>
  import-legacy-db <username> <file.db3>    Import the old Windows app's Ao3TrackSQLite.db3
  import <username> <export.json>           Import an Ao3Track export/backup file
  export <username> [file.json]             Write an export file (stdout if no file)
`;

const [cmd, ...args] = process.argv.slice(2);
const config = loadConfig();
const db = openDb(config.dbPath);
const auth = new Auth(db);
const store = new SyncStore(db);

function user(name: string | undefined) {
  const u = name ? auth.findUser(name) : undefined;
  if (!u) { console.error(`No such user: ${name ?? '(missing)'}`); process.exit(1); }
  return u;
}
const need = (n: number) => { if (args.length < n) { console.error(HELP); process.exit(2); } };
const report = (r: object) => console.log(Object.entries(r).map(([k, v]) => `${k}: ${v}`).join('\n'));

switch (cmd) {
  case 'users': {
    const rows = db.prepare('SELECT id, username, email FROM users ORDER BY id').all() as Array<{ id: number; username: string; email: string | null }>;
    if (!rows.length) console.log('(no users)');
    for (const r of rows) {
      const c = store.counts(r.id);
      console.log(`${r.username.padEnd(24)} works=${c.works} readingList=${c.readingList} filters=${c.listFilters}${r.email ? `  <${r.email}>` : ''}`);
    }
    break;
  }
  case 'create-user': {
    need(2);
    if (auth.findUser(args[0])) { console.error('User exists'); process.exit(1); }
    if (args[1].length < MIN_PW_SIZE) { console.error(`Password must be at least ${MIN_PW_SIZE} characters`); process.exit(1); }
    auth.createUser(args[0], null, args[1]);
    console.log(`Created ${args[0]}`);
    break;
  }
  case 'reset-password': {
    need(2);
    const u = user(args[0]);
    if (args[1].length < MIN_PW_SIZE) { console.error(`Password must be at least ${MIN_PW_SIZE} characters`); process.exit(1); }
    auth.setPassword(u.id, args[1]);
    console.log(`Password changed for ${u.username}; all devices must sign in again.`);
    break;
  }
  case 'migrate': {
    need(3);
    const u = user(args[0]);
    const data = await exportFromSyncServer(args[1], args[2], { baseUrl: args[3] || config.legacyApiUrl });
    report(store.importAccount(u.id, data));
    break;
  }
  case 'import-legacy-db': {
    need(2);
    const u = user(args[0]);
    report(store.importAccount(u.id, exportFromLegacyDb(args[1])));
    break;
  }
  case 'import': {
    need(2);
    const u = user(args[0]);
    const data = JSON.parse(readFileSync(args[1], 'utf8'));
    if (data?.format !== 'ao3track-export') { console.error('Not an Ao3Track export file'); process.exit(1); }
    report(store.importAccount(u.id, data));
    break;
  }
  case 'export': {
    need(1);
    const u = user(args[0]);
    const out = JSON.stringify({
      format: 'ao3track-export', version: 1, source: 'tracksync', username: u.username, exportedAt: new Date().toISOString(),
      works: store.getWorks(u.id), readingList: store.readingList(u.id), listFilters: store.listFilters(u.id),
    }, null, 1);
    if (args[1]) { writeFileSync(args[1], out); console.error(`Wrote ${args[1]}`); } else console.log(out);
    break;
  }
  default:
    console.log(HELP);
    process.exit(cmd ? 2 : 0);
}
db.close();
