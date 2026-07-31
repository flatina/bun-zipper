export class ZipError extends Error {
  /** Byte offset in the archive where the problem was detected, when known. */
  readonly offset?: number;
  /** Entry name the problem belongs to, when known. */
  readonly entry?: string;

  constructor(message: string, opts?: { offset?: number; entry?: string }) {
    super(message);
    this.name = new.target.name;
    if (opts?.offset !== undefined) this.offset = opts.offset;
    if (opts?.entry !== undefined) this.entry = opts.entry;
  }
}

/** Malformed container: bad signature, truncated header, field out of range. */
export class ZipFormatError extends ZipError {}

/** Well-formed but uses a feature this package deliberately does not implement. */
export class ZipUnsupportedError extends ZipError {}

/** Rejected to protect the caller: path escape, limit exceeded. */
export class ZipSecurityError extends ZipError {}

/** Decompressed bytes did not match the CRC-32 recorded in the archive. */
export class ZipCrcError extends ZipFormatError {}
