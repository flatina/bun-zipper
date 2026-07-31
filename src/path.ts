import { ZipSecurityError } from "./errors.ts";

/**
 * Reject anything that could resolve outside the extraction root.
 * ZIP names are supposed to use `/`, but archivers emit `\` and Windows treats
 * both as separators, so backslash is normalized before the checks rather than
 * after — otherwise `a\..\..\b` slips past a `/`-only traversal check.
 */
export function sanitizeEntryPath(name: string): string {
  if (name.includes("\0")) {
    throw new ZipSecurityError("entry name contains a NUL byte", { entry: name });
  }

  const normalized = name.replace(/\\/g, "/");

  // UNC first: it also starts with "/", so the absolute check would shadow it.
  if (normalized.startsWith("//")) {
    throw new ZipSecurityError("entry name is a UNC path", { entry: name });
  }
  if (normalized.startsWith("/")) {
    throw new ZipSecurityError("entry name is an absolute path", { entry: name });
  }
  if (/^[a-zA-Z]:/.test(normalized)) {
    throw new ZipSecurityError("entry name has a drive letter", { entry: name });
  }

  const parts: string[] = [];
  for (const part of normalized.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      throw new ZipSecurityError("entry name escapes the extraction root", { entry: name });
    }
    checkWindowsHazards(part, name);
    parts.push(part);
  }
  if (parts.length === 0) {
    throw new ZipSecurityError("entry name is empty after normalization", { entry: name });
  }
  return parts.join("/");
}

/** Device names Windows resolves anywhere in the tree, with or without a suffix. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * Names that are harmless on POSIX but alias to something else on Windows.
 * These are rejected everywhere so an archive cannot behave differently
 * depending on where it is unpacked.
 */
function checkWindowsHazards(part: string, name: string): void {
  if (part.includes(":")) {
    // "file.txt:stream" writes an alternate data stream onto file.txt, which
    // slips past an existence check made against the plain name.
    throw new ZipSecurityError("entry name contains a colon", { entry: name });
  }
  if (WINDOWS_RESERVED.test(part)) {
    throw new ZipSecurityError(`entry name uses the reserved device name ${part}`, { entry: name });
  }
  if (/[.\s]$/.test(part)) {
    // Windows silently strips these, so "a. " and "a" become the same file.
    throw new ZipSecurityError("entry name ends with a dot or space", { entry: name });
  }
  // Control characters and the shell-glob wildcards Windows treats specially.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
  if (/[\x00-\x1f<>"|?*]/.test(part)) {
    throw new ZipSecurityError("entry name contains a reserved character", { entry: name });
  }
}

/** Directory entries are identified solely by a trailing slash (APPNOTE §4.4.17.1). */
export function isDirectoryName(name: string): boolean {
  return name.endsWith("/");
}
