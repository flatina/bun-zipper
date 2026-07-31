import { mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { ZipSecurityError } from "./errors.ts";
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

    if (entry.isDirectory) {
      await mkdir(target, { recursive: true });
      continue;
    }
    if (!options.overwrite && (await Bun.file(target).exists())) {
      throw new ZipSecurityError(`refusing to overwrite ${relative}`, { entry: entry.name });
    }

    // Creating the parent ourselves lets us resolve it before writing: a symlink
    // planted under the destination (by an earlier entry, or already on disk)
    // would otherwise redirect the write outside it.
    const parent = dirname(target);
    await mkdir(parent, { recursive: true });
    const realParent = await realpath(parent);
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
