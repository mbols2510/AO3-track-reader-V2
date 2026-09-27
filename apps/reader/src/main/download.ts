/**
 * Download an update installer and make sure it arrived intact before anything runs it.
 * A download damaged on the way (a proxy, a dropped connection, a file still being uploaded)
 * otherwise reaches Windows Installer, which only says "app.cab is corrupted".
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface Expected {
  /** Size in bytes, as GitHub reports it. */
  size?: number;
  /** Lower-case hex SHA-256, when GitHub provides one. */
  sha256?: string;
}

export class DamagedDownload extends Error {}

const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;

/** Write the response body to `file`; throws DamagedDownload (and removes the file) if it doesn't match. */
export async function downloadVerified(res: Response, file: string, expected: Expected): Promise<void> {
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const hash = createHash('sha256');
  let bytes = 0;
  const count = new Transform({
    transform(chunk: Buffer, _enc, done) { bytes += chunk.length; hash.update(chunk); done(null, chunk); },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), count, createWriteStream(file));
  } catch (e) {
    await unlink(file).catch(() => {});
    throw new DamagedDownload(`The download was interrupted after ${mb(bytes)} (${(e as Error).message}).`);
  }
  const problem =
    !bytes ? 'The downloaded file is empty.'
    : expected.size && bytes !== expected.size ? `Only ${mb(bytes)} of ${mb(expected.size)} arrived.`
    : expected.sha256 && hash.digest('hex') !== expected.sha256.toLowerCase() ? 'The file arrived damaged (its checksum does not match the release).'
    : null;
  if (problem) {
    await unlink(file).catch(() => {});
    throw new DamagedDownload(problem);
  }
}
