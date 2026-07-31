import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzip, ZipReader, ZipWriter } from "../src/index.ts";

const uv = Bun.which("uv");
const sevenZip = Bun.which("7z");
if (!uv) console.warn("[zip64] SKIPPING python-generated Zip64 checks: uv not found");
if (!sevenZip) console.warn("[zip64] SKIPPING 7z verification of our Zip64 output");

let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "bun-zipper-zip64-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function run(cmd: string[]) {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

describe("Zip64 end of central directory (written by us)", () => {
  // The 16-bit entry count in the classic EOCD overflows past 65535, which is
  // the only Zip64 trigger reachable without writing multi-gigabyte files.
  const COUNT = 65_536;
  let archive = "";

  beforeAll(async () => {
    archive = join(dir, "many.zip");
    const writer = new ZipWriter(Bun.file(archive).writer());
    for (let i = 0; i < COUNT; i++) {
      await writer.add(`e${i}.txt`, "", { compression: "store" });
    }
    await writer.close();
  }, 120_000);

  test("we read all entries back", async () => {
    const reader = await ZipReader.open(Bun.file(archive));
    expect(reader.entries).toHaveLength(COUNT);
    expect(reader.entries[COUNT - 1]!.name).toBe(`e${COUNT - 1}.txt`);
  }, 60_000);

  test("the classic EOCD carries the 0xFFFF sentinel", async () => {
    const bytes = new Uint8Array(await Bun.file(archive).arrayBuffer());
    const view = new DataView(bytes.buffer);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= 0; i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    expect(eocd).toBeGreaterThan(-1);
    expect(view.getUint16(eocd + 10, true)).toBe(0xffff);
    // The Zip64 locator sits immediately before it.
    expect(view.getUint32(eocd - 20, true)).toBe(0x07064b50);
  }, 60_000);

  test.if(!!sevenZip)(
    "7z accepts our Zip64 archive",
    async () => {
      const { code, stdout } = await run(["7z", "t", archive]);
      expect(stdout).toContain("Everything is Ok");
      expect(code).toBe(0);
    },
    120_000,
  );

  test.if(!!uv)(
    "python accepts our Zip64 archive",
    async () => {
      const { code, stdout, stderr } = await run([
        "uv",
        "run",
        "--no-project",
        "python",
        "-c",
        [
          "import zipfile",
          `z = zipfile.ZipFile(r"${archive}")`,
          `assert len(z.infolist()) == ${COUNT}, len(z.infolist())`,
          'print("OK")',
        ].join("\n"),
      ]);
      expect(stderr + stdout).toContain("OK");
      expect(code).toBe(0);
    },
    120_000,
  );
});

describe("Zip64 records written by python", () => {
  test.if(!!uv)("per-entry Zip64 extra field is honored", async () => {
    const archive = join(dir, "py64.zip");
    const script = [
      "import zipfile",
      `z = zipfile.ZipFile(r"${archive}", "w", zipfile.ZIP_DEFLATED, allowZip64=True)`,
      // force_zip64 makes the entry carry a Zip64 extra field despite being small.
      'with z.open("한글.txt", "w", force_zip64=True) as f:',
      '    f.write("안녕하세요 세계".encode())',
      "z.close()",
    ].join("\n");
    const { code, stderr } = await run(["uv", "run", "--no-project", "python", "-c", script]);
    expect(stderr).toBe("");
    expect(code).toBe(0);

    const files = await unzip(Bun.file(archive));
    expect(new TextDecoder().decode(files.get("한글.txt")!)).toBe("안녕하세요 세계");
  });
});
