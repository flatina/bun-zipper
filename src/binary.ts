import { ZipFormatError } from "./errors.ts";

/** Growable little-endian byte writer. */
export class ByteWriter {
  #buf: Uint8Array;
  #view: DataView;
  #len = 0;

  constructor(capacity = 256) {
    this.#buf = new Uint8Array(capacity);
    this.#view = new DataView(this.#buf.buffer);
  }

  get length(): number {
    return this.#len;
  }

  #reserve(n: number): number {
    const at = this.#len;
    if (at + n > this.#buf.length) {
      let cap = this.#buf.length * 2;
      while (cap < at + n) cap *= 2;
      const next = new Uint8Array(cap);
      next.set(this.#buf.subarray(0, at));
      this.#buf = next;
      this.#view = new DataView(next.buffer);
    }
    this.#len = at + n;
    return at;
  }

  u16(value: number): this {
    this.#view.setUint16(this.#reserve(2), value, true);
    return this;
  }

  u32(value: number): this {
    this.#view.setUint32(this.#reserve(4), value >>> 0, true);
    return this;
  }

  u64(value: bigint): this {
    this.#view.setBigUint64(this.#reserve(8), value, true);
    return this;
  }

  bytes(data: Uint8Array): this {
    // #reserve may replace #buf, and the member lookup happens before the
    // argument is evaluated — so the offset must be taken first.
    const at = this.#reserve(data.length);
    this.#buf.set(data, at);
    return this;
  }

  /** View over the written bytes. Invalidated by further writes. */
  subarray(): Uint8Array {
    return this.#buf.subarray(0, this.#len);
  }

  toBytes(): Uint8Array {
    return this.#buf.slice(0, this.#len);
  }
}

/** Bounds-checked little-endian reader over a fixed buffer. */
export class ByteReader {
  #view: DataView;
  /** Offset of byte 0 within the archive, for error reporting. */
  readonly base: number;
  pos = 0;

  constructor(
    readonly data: Uint8Array,
    base = 0,
  ) {
    this.#view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.base = base;
  }

  get remaining(): number {
    return this.data.length - this.pos;
  }

  #need(n: number, what: string): number {
    if (this.pos + n > this.data.length) {
      throw new ZipFormatError(`truncated while reading ${what}`, { offset: this.base + this.pos });
    }
    const at = this.pos;
    this.pos += n;
    return at;
  }

  u8(what = "u8"): number {
    return this.#view.getUint8(this.#need(1, what));
  }

  u16(what = "u16"): number {
    return this.#view.getUint16(this.#need(2, what), true);
  }

  u32(what = "u32"): number {
    return this.#view.getUint32(this.#need(4, what), true);
  }

  u64(what = "u64"): bigint {
    return this.#view.getBigUint64(this.#need(8, what), true);
  }

  bytes(n: number, what = "bytes"): Uint8Array {
    return this.data.subarray(this.#need(n, what), this.pos);
  }

  skip(n: number, what = "field"): void {
    this.#need(n, what);
  }
}

/**
 * ZIP sizes are 64-bit but array indexing is not. Convert only where the value
 * must address memory, and fail loudly instead of silently truncating.
 */
export function toSafeInt(value: bigint, what: string, offset?: number): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ZipFormatError(`${what} exceeds Number.MAX_SAFE_INTEGER (${value})`, { offset });
  }
  return Number(value);
}
