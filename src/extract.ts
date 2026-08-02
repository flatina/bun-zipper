import type { FileHandle } from "node:fs/promises";
import { link, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { worstCaseInflatedSize } from "./compress.ts";
import { ZipError, ZipSecurityError, ZipUnsupportedError } from "./errors.ts";
import { METHOD_STORE } from "./format.ts";
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

/** What a filesystem without hard links answers `link` with. */
const NO_HARD_LINKS = new Set(["EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EMLINK", "EXDEV"]);

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

  // Called once and its answer kept: it is the caller's function, and calling it
  // twice for one entry is something they can see.
  const selected = options.filter ? reader.entries.filter(options.filter) : [...reader.entries];

  const written: string[] = [];
  // Everything this call brought into being, directories included, in the order
  // it happened. Undoing a half-done extraction means walking it backwards.
  const created: string[] = [];
  const budget = new TotalSizeBudget(reader.limits.maxTotalUncompressedSize);

  try {
    const { anchor, tail, root } = await resolveRoot(destination);
    const planned = plan(selected, reader.limits);
    await inspectDestination(root, planned, options.overwrite === true);

    // Created only once every check above has passed, so a refusal leaves the
    // filesystem as it was — including the destination itself.
    await mkdirInside(anchor, tail, destination, created);
    await write(planned, root, written, created, budget, options.overwrite === true);
  } catch (error) {
    // Without atomic staging a failure partway leaves earlier entries in place,
    // and the caller cannot clean up what it was never told about. Filesystem
    // errors arrive as themselves, not as ZipError, and they are the ones most
    // likely to strike halfway.
    if (typeof error === "object" && error !== null) {
      (error as { installed?: readonly string[] }).installed = created;
    }
    throw error;
  }
  return written;
}

async function write(
  planned: readonly Planned[],
  root: string,
  written: string[],
  created: string[],
  budget: TotalSizeBudget,
  overwrite: boolean,
): Promise<void> {
  for (const { entry, relative, parts } of planned) {
    const target = join(root, relative);
    // Defence in depth: sanitizeEntryPath already rejected traversal, but the
    // join result is what actually gets written.
    if (target !== root && !target.startsWith(root + sep)) {
      throw new ZipSecurityError("entry would be written outside the destination", {
        entry: entry.name,
      });
    }

    if (entry.isDirectory) {
      await mkdirInside(root, parts, entry.name, created);
      continue;
    }
    await mkdirInside(root, parts.slice(0, -1), entry.name, created);

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
    if (!overwrite && existing !== undefined) {
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

    await install(entry, realParent, basename(target), budget, overwrite, () => {
      written.push(target);
      created.push(target);
    });
  }
}

interface Planned {
  entry: ZipEntry;
  relative: string;
  parts: string[];
}

/**
 * The destination need not exist yet, and every check below needs a resolved
 * root. Resolve the nearest ancestor that does exist and rebuild the rest on
 * top: components that do not exist cannot be symlinks, so the part that could
 * lie is exactly the part being resolved.
 */
async function resolveRoot(
  destination: string,
): Promise<{ anchor: string; tail: string[]; root: string }> {
  const wanted = resolve(destination);
  const tail: string[] = [];
  let at = wanted;
  let info = await lstat(at).catch(() => undefined);
  while (info === undefined) {
    const parent = dirname(at);
    if (parent === at) throw new ZipError(`no existing ancestor of ${destination}`);
    tail.unshift(basename(at));
    at = parent;
    info = await lstat(at).catch(() => undefined);
  }
  // Both of these otherwise surface far later and unrecognisably: a dangling
  // symlink as a raw ENOENT from realpath, a plain file as an ENOENT naming a
  // path underneath it once the first entry tries to open its temp.
  const anchor = await realpath(at).catch(() => {
    throw new ZipError(`${at} does not resolve to a real path`);
  });
  if (!(await lstat(anchor).catch(() => undefined))?.isDirectory()) {
    throw new ZipError(`${anchor} exists and is not a directory`);
  }
  return { anchor, tail, root: join(anchor, ...tail) };
}

/**
 * Case and normalization both collapse on the filesystems most callers have —
 * NTFS folds case, APFS folds case and normalizes — so an exact-string check
 * misses the collisions that actually happen, and misses them halfway through
 * an extraction.
 */
const collationKey = (path: string): string => path.normalize("NFC").toLowerCase();

/**
 * Everything knowable from the archive alone, checked before any of it is acted
 * on. What is left for the write loop is what only reading can discover: CRC,
 * real sizes, malformed local headers, and IO.
 */
function plan(entries: readonly ZipEntry[], limits: ZipReader["limits"]): Planned[] {
  const planned: Planned[] = [];
  const files = new Map<string, string>();
  const directories = new Map<string, string>();
  let declared = 0n;

  for (const entry of entries) {
    if (entry.unixMode !== undefined && (entry.unixMode & S_IFMT) === S_IFLNK) {
      throw new ZipSecurityError("archive contains a symbolic link", { entry: entry.name });
    }
    // Directory records are never read, so their declarations are not checked
    // either — several writers leave junk in them, and refusing here would turn
    // archives that extract today into failures.
    if (!entry.isDirectory) {
      if (entry.isEncrypted) {
        throw new ZipUnsupportedError("entry is encrypted; encryption is not supported", {
          entry: entry.name,
        });
      }
      if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
        throw new ZipUnsupportedError(
          `compression method ${entry.compressionMethod} is not supported (only store and deflate)`,
          { entry: entry.name },
        );
      }
      if (entry.uncompressedSize > limits.maxEntryUncompressedSize) {
        throw new ZipSecurityError(
          `entry is ${entry.uncompressedSize} bytes, over the ${limits.maxEntryUncompressedSize} limit`,
          { entry: entry.name },
        );
      }
      if (
        entry.compressedSize > 0n &&
        Number(entry.uncompressedSize) / Number(entry.compressedSize) > limits.maxCompressionRatio
      ) {
        throw new ZipSecurityError(
          `compression ratio exceeds the ${limits.maxCompressionRatio}:1 limit`,
          { entry: entry.name },
        );
      }
    }

    const relative = sanitizeEntryPath(entry.name);
    const parts = relative.split("/");

    // Every component above the entry is a directory, whether or not the archive
    // says so. A name used both ways cannot be extracted, and finding that out
    // after the file landed is the failure this exists to prevent.
    const leaf = entry.isDirectory ? parts.length : parts.length - 1;
    for (let i = 0; i < leaf; i++) {
      const path = parts.slice(0, i + 1).join("/");
      const key = collationKey(path);
      const clash = directories.get(key);
      // Two components that fold together are one directory on NTFS and APFS
      // and two on ext4 — the archive unpacking differently depending on where
      // is the thing this exists to stop.
      if (clash !== undefined && clash !== path) {
        throw new ZipError(`${path} and ${clash} extract to the same directory`, {
          entry: entry.name,
        });
      }
      directories.set(key, path);
    }
    if (!entry.isDirectory) {
      const key = collationKey(relative);
      const clash = files.get(key);
      if (clash !== undefined) {
        throw new ZipError(`${entry.name} and ${clash} extract to the same path`, {
          entry: entry.name,
        });
      }
      files.set(key, entry.name);
      declared += entry.uncompressedSize;
      planned.push({ entry, relative, parts });
    } else {
      planned.push({ entry, relative, parts });
    }
  }

  for (const [key, path] of files) {
    if (directories.has(key)) {
      throw new ZipError(`${path} is used as both a file and a directory`, { entry: path });
    }
  }
  // Known up front, so an archive that says outright it is too big never starts.
  if (declared > limits.maxTotalUncompressedSize) {
    throw new ZipSecurityError(
      `archive declares ${declared} bytes, over the ${limits.maxTotalUncompressedSize} limit`,
    );
  }
  return planned;
}

/**
 * The destination-side half, hoisted out of the write loop so a conflict at the
 * last entry does not leave the first ones installed. The loop still repeats
 * these: this narrows the window, it does not close it.
 */
async function inspectDestination(
  root: string,
  planned: readonly Planned[],
  overwrite: boolean,
): Promise<void> {
  const seen = new Set<string>();
  for (const { entry, relative, parts } of planned) {
    const depth = entry.isDirectory ? parts.length : parts.length - 1;
    let at = root;
    for (let i = 0; i < depth; i++) {
      at = join(at, parts[i]!);
      if (seen.has(at)) continue;
      seen.add(at);
      const info = await lstat(at).catch(() => undefined);
      if (info === undefined) continue;
      if (info.isSymbolicLink()) {
        throw new ZipSecurityError(`${parts[i]} is a symbolic link in the destination`, {
          entry: entry.name,
        });
      }
      if (!info.isDirectory()) {
        throw new ZipError(`${parts[i]} exists and is not a directory`, { entry: entry.name });
      }
    }
    if (entry.isDirectory) continue;

    const target = join(root, relative);
    const info = await lstat(target).catch(() => undefined);
    if (info === undefined) continue;
    if (info.isSymbolicLink()) {
      throw new ZipSecurityError("destination path is a symbolic link", { entry: entry.name });
    }
    if (info.isDirectory()) {
      throw new ZipError(`${relative} exists as a directory`, { entry: entry.name });
    }
    if (info.isFile() && info.nlink > 1) {
      throw new ZipSecurityError("destination path has other hard links", { entry: entry.name });
    }
    if (!overwrite) {
      throw new ZipSecurityError(`refusing to overwrite ${relative}`, { entry: entry.name });
    }
  }
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
  commit: () => void,
): Promise<void> {
  let temp = "";
  let handle: FileHandle | undefined;
  // 48 bits of name makes a real collision irrelevant; the cap is there so that
  // anything else answering EEXIST fails instead of spinning.
  for (let attempt = 0; ; attempt++) {
    temp = join(parent, tempName());
    try {
      handle = await open(temp, "wx");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 8) throw error;
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
      // practice, so the remainder is written rather than assumed. Zero is a
      // permitted short write too, and looping on it would never end.
      for (let at = 0; at < filled; ) {
        const { bytesWritten } = await handle!.write(block, at, filled - at);
        if (bytesWritten <= 0) throw new ZipError(`write to ${entry.name} made no progress`);
        at += bytesWritten;
      }
      filled = 0;
    };

    // Small entries are read in a single inflate call, which is several times
    // faster than driving a decompression stream for them.
    //
    // The test is what the *payload* can produce, never what the header claims.
    // `bytes()` bounds itself by `maxInflateBuffer` — 8 GiB by default — so
    // choosing it on a declared size hands the peak to whoever wrote the
    // archive: 255 KB declaring 100 bytes drove 342 MB through here. A stored
    // entry yields its compressed length exactly; deflate cannot beat 1032:1.
    const ceiling =
      entry.compressionMethod === METHOD_STORE
        ? entry.compressedSize
        : worstCaseInflatedSize(entry.compressedSize);
    const source =
      ceiling <= BigInt(WRITE_BLOCK)
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
      commit();
    } else {
      // `link` refuses with EEXIST rather than replacing, which is the only way
      // this option is a guarantee instead of a check someone can race. The
      // earlier check reports the ordinary case; this catches the race.
      try {
        await link(temp, target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST") {
          throw new ZipSecurityError(`refusing to overwrite ${name}`, { entry: entry.name });
        }
        // FAT, exFAT and many network filesystems have no hard links at all.
        // Falling back keeps them working; the option degrades there from a
        // guarantee to the check already made above, which is documented.
        if (!NO_HARD_LINKS.has(code ?? "")) throw error;
        await rename(temp, target);
        temp = "";
        commit();
        return;
      }
      // The entry exists under its real name from here, so it is reported before
      // the second name goes: a failure removing that one must not make a file
      // that is on disk look like one that never arrived. It is also not
      // suppressed — a leftover temp the caller never hears about is worse.
      commit();
      const stray = temp;
      temp = "";
      await unlink(stray);
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
async function mkdirInside(
  root: string,
  parts: string[],
  entry: string,
  created?: string[],
): Promise<void> {
  let at = root;
  for (const part of parts) {
    at = join(at, part);
    const info = await lstat(at).catch(() => undefined);
    if (info === undefined) {
      await mkdir(at);
      created?.push(at);
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
