import { ZipUnsupportedError } from "./errors.ts";

// CP437 is the encoding APPNOTE mandates when the UTF-8 flag is clear, but it
// is not in the WHATWG encoding registry, so TextDecoder cannot provide it.
const HIGH =
  "ÇüéâäàåçêëèïîìÄÅ" +
  "ÉæÆôöòûùÿÖÜ¢£¥₧ƒ" +
  "áíóúñÑªº¿⌐¬½¼¡«»" +
  "░▒▓│┤╡╢╖╕╣║╗╝╜╛┐" +
  "└┴┬├─┼╞╟╚╔╩╦╠═╬╧" +
  "╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀" +
  "αßΓπΣσµτΦΘΩδ∞φε∩" +
  "≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

export function decodeCp437(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b < 0x80 ? String.fromCharCode(b) : HIGH[b - 0x80];
  return out;
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * CP437 maps every byte, so it can never report that it guessed wrong. Valid
 * multi-byte UTF-8 is unlikely to arise by chance in real CP437 text, which
 * makes "decodes as UTF-8" a reliable signal — macOS Archive Utility writes
 * UTF-8 names without ever setting the UTF-8 flag.
 */
function decodeUtf8IfPlausible(bytes: Uint8Array): string | undefined {
  if (bytes.every((b) => b < 0x80)) return undefined; // pure ASCII: both agree
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Windows archivers on CJK locales write locale-encoded names without setting
 * the UTF-8 flag, so CP437 would mojibake them. An explicit encoding always
 * wins; without one, well-formed UTF-8 is preferred over CP437.
 */
export function decodeName(bytes: Uint8Array, encoding?: string): string {
  if (!encoding) return decodeUtf8IfPlausible(bytes) ?? decodeCp437(bytes);
  if (encoding.toLowerCase() === "cp437") return decodeCp437(bytes);
  return decoderFor(encoding).decode(bytes);
}

const decoders = new Map<string, TextDecoder>();

/**
 * Cached, and validated as a ZipError: an unknown label would otherwise surface
 * as a bare RangeError from whichever entry happened to lack the UTF-8 flag.
 */
function decoderFor(encoding: string): TextDecoder {
  let decoder = decoders.get(encoding);
  if (!decoder) {
    try {
      decoder = new TextDecoder(encoding as ConstructorParameters<typeof TextDecoder>[0]);
    } catch {
      throw new ZipUnsupportedError(`unsupported filenameEncoding: ${encoding}`);
    }
    decoders.set(encoding, decoder);
  }
  return decoder;
}
