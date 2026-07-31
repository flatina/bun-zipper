/**
 * Regenerates the fixtures produced by external tools.
 *
 *   bun run test/fixtures/generate.ts
 *
 * These are committed rather than built during the test run so the quirks they
 * capture stay pinned: a newer 7-Zip or Info-ZIP may stop emitting them, and a
 * regression test that silently starts passing is worse than one that fails.
 * Archives written by bun-zipper itself are never frozen here — tests generate
 * those, because a fixture produced by the code under test cannot judge it.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const here = import.meta.dir;
const staging = join(here, ".staging");

const FILES: Record<string, string> = {
  "한글문서.txt": "안녕하세요 세계",
  "日本語テスト.txt": "こんにちは世界",
  "ascii.txt": "plain ascii\n".repeat(20),
};

async function run(cmd: string[], cwd?: string) {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${cmd[0]} exited ${code}\n${stdout}${stderr}`);
}

function required(tool: string): string {
  const path = Bun.which(tool);
  if (!path) throw new Error(`${tool} is required to regenerate fixtures`);
  return path;
}

await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
for (const [name, body] of Object.entries(FILES)) {
  await writeFile(join(staging, name), body, "utf8");
}

// 7-Zip on Windows stores CJK names in the local codepage with the UTF-8 flag
// clear, putting the real name in an Info-ZIP Unicode Path field (0x7075).
required("7z");
const sevenZip = join(here, "7zip_unicode_path.zip");
await rm(sevenZip, { force: true });
await run(["7z", "a", "-tzip", sevenZip, "."], staging);

// Info-ZIP on Windows stores an NTFS security descriptor extra field (0x4453).
// With -UN=UTF8 it also under-reports the central directory size by 4 bytes per
// affected entry; 7-Zip and Python both reject the result, and only Info-ZIP's
// own unzip compensates. Without -UN=UTF8 the sizes come out consistent, so the
// flag is load-bearing here, not incidental.
required("zip");
const infoZip = join(here, "infozip_short_central_size.zip");
await rm(infoZip, { force: true });
await run(["zip", "-r", "-UN=UTF8", infoZip, "."], staging);

await rm(staging, { recursive: true, force: true });

for (const path of [sevenZip, infoZip]) {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  console.log(`${path}  ${bytes.length} bytes  sha256=${Bun.SHA256.hash(bytes, "hex")}`);
}
