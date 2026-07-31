// ZIP container constants. Field layouts: PKWARE APPNOTE.TXT §4.3.

export const SIG_LOCAL = 0x04034b50;
export const SIG_CENTRAL = 0x02014b50;
export const SIG_EOCD = 0x06054b50;
export const SIG_DATA_DESCRIPTOR = 0x08074b50;
export const SIG_ZIP64_EOCD = 0x06064b50;
export const SIG_ZIP64_LOCATOR = 0x07064b50;

export const LOCAL_HEADER_SIZE = 30;
export const CENTRAL_HEADER_SIZE = 46;
export const EOCD_SIZE = 22;
export const ZIP64_EOCD_SIZE = 56;
export const ZIP64_LOCATOR_SIZE = 20;

export const METHOD_STORE = 0;
export const METHOD_DEFLATE = 8;

export const FLAG_ENCRYPTED = 1 << 0;
export const FLAG_DATA_DESCRIPTOR = 1 << 3;
export const FLAG_UTF8 = 1 << 11;

/** Written into 32-bit size/offset fields when the real value lives in a Zip64 extra field. */
export const ZIP64_SENTINEL_32 = 0xffffffff;
export const ZIP64_SENTINEL_16 = 0xffff;

export const EXTRA_ZIP64 = 0x0001;
/** Info-ZIP "Unicode Path": carries the UTF-8 name when the UTF-8 flag is clear. */
export const EXTRA_UNICODE_PATH = 0x7075;

/** Archive comment is length-prefixed with 16 bits, so the EOCD can sit at most this far from EOF. */
export const MAX_COMMENT_SIZE = 0xffff;

const DOS_EPOCH_YEAR = 1980;

export function toDosTime(date: Date): { time: number; date: number } {
  const year = date.getFullYear();
  if (year < DOS_EPOCH_YEAR) return { time: 0, date: (1 << 5) | 1 };
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - DOS_EPOCH_YEAR) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export function fromDosTime(time: number, date: number): Date | undefined {
  if (date === 0 && time === 0) return undefined;
  return new Date(
    DOS_EPOCH_YEAR + ((date >> 9) & 0x7f),
    ((date >> 5) & 0x0f) - 1,
    date & 0x1f,
    (time >> 11) & 0x1f,
    (time >> 5) & 0x3f,
    (time & 0x1f) * 2,
  );
}
