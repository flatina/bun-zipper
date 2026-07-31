import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { ZipError, ZipSecurityError } from "./errors.ts";
import { sanitizeEntryPath } from "./path.ts";
import {
  TotalSizeBudget,
  type ZipEntry,
  type ZipInput,
  ZipReader,
  type ZipReaderOptions,
} from "./reader.ts";

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

export interface ExtractOptions extends ZipReaderOptions {
  /** Off by default, so extraction cannot clobber. */
  overwrite?: boolean;
  /** Return false to skip an entry. */
  filter?: (entry: ZipEntry) => boolean;
}

/**
 * Writes every entry under `destination`, refusing anything that would land
 * outside it. Symlink entries are refused outright rather than followed.
 */
export async function extractZip(
  input: ZipInput,
  destination: string,
  options: ExtractOptions = {},
): Promise<string[]> {
  const reader = await ZipReader.open(input, options);
  await mkdir(destination, { recursive: true });

  // Resolve the root once so a symlinked destination compares correctly.
  const root = await realpath(resolve(destination));
  const written: string[] = [];
  const budget = new TotalSizeBudget(reader.limits.maxTotalUncompressedSize);

  for (const entry of reader.entries) {
    if (options.filter && !options.filter(entry)) continue;

    if (entry.unixMode !== undefined && (entry.unixMode & S_IFMT) === S_IFLNK) {
      throw new ZipSecurityError("archive contains a symbolic link", { entry: entry.name });
    }

    const relative = sanitizeEntryPath(entry.name);
    const target = join(root, relative);
    // Defence in depth: sanitizeEntryPath already rejected traversal, but the
    // join result is what actually gets written.
    if (target !== root && !target.startsWith(root + sep)) {
      throw new ZipSecurityError("entry would be written outside the destination", {
        entry: entry.name,
      });
    }

    const parts = relative.split("/");
    if (entry.isDirectory) {
      await mkdirInside(root, parts, entry.name);
      continue;
    }
    await mkdirInside(root, parts.slice(0, -1), entry.name);

    // A symlink here would be followed by the write, landing the bytes wherever
    // it points. `exists()` cannot see a dangling one, so lstat is what decides.
    const existing = await lstat(target).catch(() => undefined);
    if (existing?.isSymbolicLink()) {
      throw new ZipSecurityError("destination path is a symbolic link", { entry: entry.name });
    }
    if (existing !== undefined && existing.nlink > 1) {
      // Writing through a hard link edits every other name for the same file,
      // and lstat gives no way to tell whether one of them is outside the root.
      throw new ZipSecurityError("destination path has other hard links", { entry: entry.name });
    }
    if (existing?.isDirectory()) {
      throw new ZipError(`${relative} exists as a directory`, { entry: entry.name });
    }
    if (!options.overwrite && existing !== undefined) {
      throw new ZipSecurityError(`refusing to overwrite ${relative}`, { entry: entry.name });
    }

    // Last line of defence: mkdirInside refuses symlinked components, but the
    // check and the write are not atomic.
    const realParent = await realpath(dirname(target));
    if (realParent !== root && !realParent.startsWith(root + sep)) {
      throw new ZipSecurityError("entry's parent directory resolves outside the destination", {
        entry: entry.name,
      });
    }

    const bytes = await entry.bytes();
    budget.spend(bytes.length, entry.name);
    await Bun.write(join(realParent, basename(target)), bytes);
    written.push(target);
  }
  return written;
}

/**
 * Creates the path one component at a time. `mkdir -p` follows a symlink already
 * on disk and creates directories outside the root, and checking afterwards is
 * too late — they exist by then. The root itself is exempt: it was resolved once
 * by the caller, so reaching it through a symlink (macOS `/tmp`) stays legal.
 */
async function mkdirInside(root: string, parts: string[], entry: string): Promise<void> {
  let at = root;
  for (const part of parts) {
    at = join(at, part);
    const info = await lstat(at).catch(() => undefined);
    if (info === undefined) {
      await mkdir(at);
      continue;
    }
    if (info.isSymbolicLink()) {
      throw new ZipSecurityError(`${part} is a symbolic link in the destination`, { entry });
    }
    if (!info.isDirectory()) {
      // A collision, not an attack: an archive can name a file and a directory
      // the same thing, and a trailing backslash makes one look like the other.
      throw new ZipError(`${part} exists and is not a directory`, { entry });
    }
  }
}
