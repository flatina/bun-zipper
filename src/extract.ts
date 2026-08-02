import type { FileHandle } from "node:fs/promises";
import { link, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
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

/** Write granularity, matching the reader's own slice size. */
const WRITE_BLOCK = 1024 * 1024;

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
    if (existing?.isDirectory()) {
      throw new ZipError(`${relative} exists as a directory`, { entry: entry.name });
    }
    // Regular files only: POSIX counts "." and each subdirectory as links, so
    // every directory has an nlink above 1 and would look like a hard link.
    if (existing?.isFile() && existing.nlink > 1) {
      // Writing through one edits every other name for the same file, and lstat
      // gives no way to tell whether one of them is outside the root.
      throw new ZipSecurityError("destination path has other hard links", { entry: entry.name });
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

    await install(entry, realParent, basename(target), budget, options.overwrite === true);
    written.push(target);
  }
  return written;
}

/** Enough to make a guess useless; the name never derives from the entry. */
function tempName(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `.bz-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}.tmp`;
}

/**
 * Streams the entry into a temp file beside its target, then puts it in place.
 *
 * Writing the target directly would follow a symlink sitting there; neither
 * `link` nor `rename` follows one at the final component, so the install itself
 * is what keeps the bytes inside the destination. The temp is created `wx` so it
 * cannot be an attacker's file either, and the entry is verified — CRC and size —
 * before any of this is visible under its real name.
 */
async function install(
  entry: ZipEntry,
  parent: string,
  name: string,
  budget: TotalSizeBudget,
  overwrite: boolean,
): Promise<void> {
  let temp = "";
  let handle: FileHandle | undefined;
  for (;;) {
    temp = join(parent, tempName());
    try {
      handle = await open(temp, "wx");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  try {
    // Inflated data arrives in 16 KiB chunks, so writing each one would cost a
    // syscall per 16 KiB. Gathering them first trades a copy for 64x fewer
    // writes and holds the same peak the stored path already does.
    const block = new Uint8Array(WRITE_BLOCK);
    let filled = 0;
    const flush = async (): Promise<void> => {
      // A short write is permitted by the API even when it never happens in
      // practice, so the remainder is written rather than assumed.
      for (let at = 0; at < filled; ) {
        at += (await handle!.write(block, at, filled - at)).bytesWritten;
      }
      filled = 0;
    };

    // Entries that fit one block are read in a single inflate call, which is
    // several times faster than driving a decompression stream for them. The
    // peak is the same either way, so only the speed differs. The declared size
    // is untrusted, but it decides nothing here except which path runs — both
    // verify, and both are capped.
    const source =
      entry.uncompressedSize <= BigInt(WRITE_BLOCK)
        ? [await entry.bytes()]
        : ((await entry.stream()) as unknown as AsyncIterable<Uint8Array>);

    for await (const chunk of source) {
      // Spent per chunk: an entry whose real size outruns what it declared has
      // to stop here, not once the whole thing is on disk.
      budget.spend(chunk.length, entry.name);
      for (let at = 0; at < chunk.length; ) {
        if (filled === block.length) await flush();
        const take = Math.min(block.length - filled, chunk.length - at);
        block.set(chunk.subarray(at, at + take), filled);
        filled += take;
        at += take;
      }
    }
    await flush();
    await handle.close();
    handle = undefined;

    const target = join(parent, name);
    if (overwrite) {
      await rename(temp, target);
      temp = "";
    } else {
      // `link` refuses with EEXIST rather than replacing, which is the only way
      // this option is a guarantee instead of a check someone can race. The
      // earlier check reports the ordinary case; this catches the race.
      try {
        await link(temp, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        throw new ZipSecurityError(`refusing to overwrite ${name}`, { entry: entry.name });
      }
    }
  } finally {
    // Closing may throw; the temp still has to go, and neither failure may
    // replace the error that brought us here.
    await handle?.close().catch(() => {});
    if (temp !== "") await unlink(temp).catch(() => {});
  }
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
