import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadVerified, DamagedDownload } from '../apps/reader/src/main/download.ts';

const msi = Buffer.alloc(3 * 1024 * 1024, 7);
const sha256 = createHash('sha256').update(msi).digest('hex');
const file = join(tmpdir(), `update-${process.pid}.msi`);

test('a complete download is kept', async () => {
  await downloadVerified(new Response(msi), file, { size: msi.length, sha256 });
  assert.equal(readFileSync(file).length, msi.length);
});

test('a cut-off download is refused and removed, never run', async () => {
  await assert.rejects(downloadVerified(new Response(msi.subarray(0, 1024 * 1024)), file, { size: msi.length, sha256 }),
    (e: Error) => e instanceof DamagedDownload && /Only 1\.0 MB of 3\.0 MB/.test(e.message));
  assert.equal(existsSync(file), false);
});

test('a same-size but damaged download is caught by the checksum', async () => {
  const bad = Buffer.from(msi); bad[1234] ^= 0xff;
  await assert.rejects(downloadVerified(new Response(bad), file, { size: msi.length, sha256 }), (e: Error) => e instanceof DamagedDownload && /checksum/.test(e.message));
  assert.equal(existsSync(file), false);
});

test('without a checksum from GitHub, the size check still applies', async () => {
  await downloadVerified(new Response(msi), file, { size: msi.length });
  await assert.rejects(downloadVerified(new Response(msi.subarray(1)), file, { size: msi.length }), DamagedDownload);
});

test('a connection that drops mid-download is reported as damaged', async () => {
  let sent = false;
  const body = new ReadableStream({ pull(c) { if (!sent) { sent = true; c.enqueue(msi.subarray(0, 4096)); } else c.error(new Error('terminated')); } });
  await assert.rejects(downloadVerified(new Response(body), file, { size: msi.length }), (e: Error) => e instanceof DamagedDownload && /interrupted/.test(e.message));
  assert.equal(existsSync(file), false);
});
