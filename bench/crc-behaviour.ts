/** What each reader does with a CRC-corrupt archive. */
import { unzipSync } from "fflate";
import { unzip, zip } from "../src/index.ts";

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;

function find(archive: Uint8Array, signature: number): number {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  for (let i = 0; i + 4 <= archive.length; i++) {
    if (view.getUint32(i, true) === signature) return i;
  }
  throw new Error("not found");
}

function payloadStart(archive: Uint8Array): number {
  const local = find(archive, SIG_LOCAL);
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  return local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
}

const ORIGINAL = "hello world, this is the payload we expect to get back intact";

const cases: [string, () => Promise<Uint8Array>][] = [
  [
    "stored entry, one payload byte flipped",
    async () => {
      const a = (await zip({ "a.txt": { data: ORIGINAL, compression: "store" } })).slice();
      const at = payloadStart(a);
      a[at + 5] = a[at + 5]! ^ 0xff;
      return a;
    },
  ],
  [
    "deflated entry, one payload byte flipped",
    async () => {
      const a = (await zip({ "a.txt": { data: ORIGINAL.repeat(50), compression: "deflate" } })).slice();
      const at = payloadStart(a);
      a[at + 10] = a[at + 10]! ^ 0xff;
      return a;
    },
  ],
  [
    "data intact, header CRC replaced with garbage",
    async () => {
      const a = (await zip({ "a.txt": ORIGINAL })).slice();
      const view = new DataView(a.buffer);
      view.setUint32(find(a, SIG_CENTRAL) + 16, 0xdeadbeef, true);
      view.setUint32(find(a, SIG_LOCAL) + 14, 0xdeadbeef, true);
      return a;
    },
  ],
];

for (const [label, build] of cases) {
  const archive = await build();
  console.log(`\n## ${label}`);

  try {
    const files = unzipSync(archive);
    const text = new TextDecoder().decode(files["a.txt"]!);
    const intact = text.startsWith(ORIGINAL.slice(0, 20));
    console.log(`  fflate      returned ${text.length} bytes, data ${intact ? "intact" : "CORRUPT"}`);
  } catch (e) {
    console.log(`  fflate      threw ${(e as Error).constructor.name}: ${(e as Error).message.slice(0, 50)}`);
  }

  try {
    const files = await unzip(archive);
    const text = new TextDecoder().decode(files.get("a.txt")!);
    console.log(`  bun-zipper  returned ${text.length} bytes (no error)`);
  } catch (e) {
    console.log(`  bun-zipper  threw ${(e as Error).constructor.name}: ${(e as Error).message.slice(0, 50)}`);
  }
}
