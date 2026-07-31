import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzip, ZipReader, ZipWriter } from "../src/index.ts";

const decode = (b: Uint8Array) => new TextDecoder().decode(b);

/** Deliberately mixes scripts that break CP437/locale-codepage assumptions. */
const FILES: Record<string, string> = {
  "한글문서.txt": "안녕하세요 세계",
  "日本語テスト.txt": "こんにちは世界",
  "中文文件.txt": "你好世界",
  "ascii.txt": "plain ascii\n".repeat(200),
};

const TOOLS = {
  unzip: Bun.which("unzip"),
  "7z": Bun.which("7z"),
  uv: Bun.which("uv"),
  zip: Bun.which("zip"),
  ugrep: Bun.which("ugrep"),
};

const missing = Object.entries(TOOLS)
  .filter(([, path]) => !path)
  .map(([name]) => name);
if (missing.length > 0) {
  // Loud, not silent: a skipped interop check is not a passing one.
  console.warn(`[interop] SKIPPING checks for missing tools: ${missing.join(", ")}`);
}

let dir = "";

async function run(cmd: string[], cwd?: string) {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    // Python's stdout otherwise defaults to the console codepage and dies on emoji.
    env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

async function writeOurArchive(path: string): Promise<void> {
  const writer = new ZipWriter(Bun.file(path).writer());
  for (const [name, body] of Object.entries(FILES)) await writer.add(name, body);
  await writer.add("stored.bin", new Uint8Array([0, 1, 2, 253, 254, 255]), {
    compression: "store",
  });
  await writer.addDirectory("빈폴더/");
  await writer.close();
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "bun-zipper-"));
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("external tools read our archives", () => {
  let archive = "";

  beforeAll(async () => {
    archive = join(dir, "ours.zip");
    await writeOurArchive(archive);
  });

  test.if(!!TOOLS.unzip)("unzip -t reports no errors", async () => {
    const { code, stdout } = await run(["unzip", "-t", archive]);
    expect(code).toBe(0);
    // Only the verdict: how unzip renders non-ASCII names to a terminal depends
    // on the console codepage, which says nothing about the archive. Name
    // fidelity is asserted structurally through python's namelist() below.
    expect(stdout).toContain("No errors detected");
  });

  test.if(!!TOOLS["7z"])("7z t reports Everything is Ok", async () => {
    const { code, stdout } = await run(["7z", "t", archive]);
    expect(code).toBe(0);
    expect(stdout).toContain("Everything is Ok");
  });

  test.if(!!TOOLS.ugrep)("ugrep lists every entry inside the archive", async () => {
    const { code, stdout } = await run(["ugrep", "-z", "-l", "", archive]);
    expect(code).toBe(0);
    for (const name of Object.keys(FILES)) expect(stdout).toContain(name);
  });

  test.if(!!TOOLS.ugrep)(
    "ugrep matches multibyte content and reports the right entry",
    async () => {
      const { code, stdout } = await run(["ugrep", "-z", "안녕하세요", archive]);
      expect(code).toBe(0);
      expect(stdout).toContain("한글문서.txt");
      expect(stdout).toContain("안녕하세요 세계");
    },
  );

  test.if(!!TOOLS.ugrep)("ugrep finds nothing for an absent pattern", async () => {
    const { code, stdout } = await run(["ugrep", "-z", "존재하지않는문자열", archive]);
    expect(stdout).toBe("");
    expect(code).toBe(1);
  });

  test.if(!!TOOLS.uv)("python zipfile.testzip passes and sees UTF-8 names", async () => {
    const script = [
      "import zipfile",
      `z = zipfile.ZipFile(r"${archive}")`,
      'assert z.testzip() is None, "testzip found a bad entry"',
      "names = z.namelist()",
      ...Object.keys(FILES).map(
        (n) => `assert ${JSON.stringify(n)} in names, ${JSON.stringify(n)}`,
      ),
      // Bit 11 must be set, otherwise readers fall back to CP437 and mojibake these.
      'assert all(i.flag_bits & 0x800 for i in z.infolist()), "UTF-8 flag missing"',
      'assert z.read("한글문서.txt").decode() == "안녕하세요 세계"',
      'print("OK")',
    ].join("\n");
    const { code, stdout, stderr } = await run([
      "uv",
      "run",
      "--no-project",
      "python",
      "-c",
      script,
    ]);
    expect(stderr + stdout).toContain("OK");
    expect(code).toBe(0);
  });
});

describe("external tools read our streamed archives", () => {
  // Stream input means bit 3 and a trailing data descriptor, a shape some
  // readers handle worse than the buffered one.
  let archive = "";

  beforeAll(async () => {
    archive = join(dir, "streamed.zip");
    const writer = new ZipWriter(Bun.file(archive).writer());
    for (const [name, body] of Object.entries(FILES)) {
      const chunks = [...body];
      await writer.add(
        name,
        new ReadableStream<Uint8Array>({
          start(c) {
            for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
            c.close();
          },
        }),
      );
    }
    await writer.close();
  });

  test("we read our own data descriptors back", async () => {
    const files = await unzip(Bun.file(archive));
    for (const [name, body] of Object.entries(FILES)) {
      expect(decode(files.get(name)!)).toBe(body);
    }
  });

  test.if(!!TOOLS.unzip)("unzip -t accepts data descriptors", async () => {
    const { code, stdout } = await run(["unzip", "-t", archive]);
    expect(stdout).toContain("No errors detected");
    expect(code).toBe(0);
  });

  test.if(!!TOOLS["7z"])("7z accepts data descriptors", async () => {
    const { code, stdout } = await run(["7z", "t", archive]);
    expect(stdout).toContain("Everything is Ok");
    expect(code).toBe(0);
  });

  test.if(!!TOOLS.uv)("python accepts data descriptors", async () => {
    const script = [
      "import zipfile",
      `z = zipfile.ZipFile(r"${archive}")`,
      'assert z.testzip() is None, "testzip failed"',
      'assert z.read("한글문서.txt").decode() == "안녕하세요 세계"',
      'print("OK")',
    ].join("\n");
    const { code, stdout, stderr } = await run([
      "uv",
      "run",
      "--no-project",
      "python",
      "-c",
      script,
    ]);
    expect(stderr + stdout).toContain("OK");
    expect(code).toBe(0);
  });

  test.if(!!TOOLS.ugrep)("ugrep searches inside data-descriptor entries", async () => {
    const { code, stdout } = await run(["ugrep", "-z", "안녕하세요", archive]);
    expect(code).toBe(0);
    expect(stdout).toContain("한글문서.txt");
  });
});

describe("we read archives from external tools", () => {
  let sourceDir = "";

  beforeAll(async () => {
    sourceDir = join(dir, "src");
    await mkdir(sourceDir, { recursive: true });
    for (const [name, body] of Object.entries(FILES)) {
      await writeFile(join(sourceDir, name), body, "utf8");
    }
  });

  test.if(!!TOOLS["7z"])("7-Zip archive", async () => {
    const archive = join(dir, "7z.zip");
    const { code } = await run(["7z", "a", "-tzip", archive, "."], sourceDir);
    expect(code).toBe(0);

    const files = await unzip(Bun.file(archive));
    for (const [name, body] of Object.entries(FILES)) {
      expect(decode(files.get(name)!)).toBe(body);
    }
  });

  test.if(!!TOOLS.uv)("python zipfile archive, both deflate and store", async () => {
    const archive = join(dir, "py.zip");
    const script = [
      "import zipfile",
      `z = zipfile.ZipFile(r"${archive}", "w", zipfile.ZIP_DEFLATED)`,
      ...Object.entries(FILES).map(
        ([n, b]) => `z.writestr(${JSON.stringify(n)}, ${JSON.stringify(b)})`,
      ),
      'z.writestr(zipfile.ZipInfo("stored.txt"), "no compression", zipfile.ZIP_STORED)',
      "z.close()",
    ].join("\n");
    const { code, stderr } = await run(["uv", "run", "--no-project", "python", "-c", script]);
    expect(stderr).toBe("");
    expect(code).toBe(0);

    const reader = await ZipReader.open(Bun.file(archive));
    const files = await unzip(Bun.file(archive));
    for (const [name, body] of Object.entries(FILES)) {
      expect(decode(files.get(name)!)).toBe(body);
    }
    expect(decode(files.get("stored.txt")!)).toBe("no compression");
    expect(reader.get("stored.txt")!.compressionMethod).toBe(0);
  });

  test.if(!!TOOLS.zip)("Info-ZIP archive", async () => {
    const archive = join(dir, "infozip.zip");
    // No -UN=UTF8: Apple's zip rejects the flag outright. Whatever this platform's
    // zip does with non-ASCII names, we have to read it. The -UN=UTF8 output is
    // pinned separately by a committed fixture.
    const { code } = await run(["zip", "-r", archive, "."], sourceDir);
    expect(code).toBe(0);

    const files = await unzip(Bun.file(archive));
    for (const [name, body] of Object.entries(FILES)) {
      const key = [...files.keys()].find((k) => k.endsWith(name));
      expect(key).toBeDefined();
      expect(decode(files.get(key!)!)).toBe(body);
    }
  });
});
