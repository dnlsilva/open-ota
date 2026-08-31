/**
 * Deterministic bundle archive.
 *
 * The same export must always produce the same bytes, because the sha256 of
 * this zip is what the server signs and the device verifies — a timestamp
 * leaking in would make every republish look like new content. So: entries
 * sorted by path, one fixed mtime, one fixed mode, no directory entries.
 *
 * `new Date(0)` is below yazl's DOS floor, so it clamps to 1980-01-01 00:00
 * local, whose DOS fields are identical in every timezone, while the extended
 * (unix) timestamp field gets a plain 0.
 */

import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import yazl from "yazl";

import { sha256Hex } from "@open-ota/shared";

const FIXED_MTIME = new Date(0);
const FIXED_MODE = 0o100644;

export interface ZipEntry {
  /** Posix-style path inside the archive. */
  path: string;
  data: Buffer;
}

export interface BundleArchive {
  bytes: Buffer;
  sha256: string;
  entryCount: number;
}

export async function collectEntries(dir: string): Promise<ZipEntry[]> {
  const dirents = await readdir(dir, { withFileTypes: true, recursive: true });
  const files = dirents.filter((dirent) => dirent.isFile());

  const entries = await Promise.all(
    files.map(async (dirent) => {
      const absolute = join(dirent.parentPath, dirent.name);
      return {
        path: relative(dir, absolute).split(sep).join("/"),
        data: await readFile(absolute),
      };
    }),
  );

  return sortEntries(entries);
}

/** Byte order, not locale order — `localeCompare` would vary by machine. */
export function sortEntries(entries: ZipEntry[]): ZipEntry[] {
  return [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function buildZip(entries: ZipEntry[]): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const zip = new yazl.ZipFile();
    const chunks: Buffer[] = [];

    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("error", rejectPromise);
    zip.outputStream.on("end", () => resolvePromise(Buffer.concat(chunks)));
    zip.on("error", rejectPromise);

    for (const entry of sortEntries(entries)) {
      zip.addBuffer(entry.data, entry.path, { mtime: FIXED_MTIME, mode: FIXED_MODE, compress: true });
    }
    zip.end();
  });
}

export async function zipDirectory(dir: string): Promise<BundleArchive> {
  const entries = await collectEntries(dir);
  if (entries.length === 0) throw new Error(`No files to publish in ${dir}`);
  return archiveOf(entries);
}

export async function archiveOf(entries: ZipEntry[]): Promise<BundleArchive> {
  const bytes = await buildZip(entries);
  return { bytes, sha256: await sha256Hex(bytes), entryCount: entries.length };
}
