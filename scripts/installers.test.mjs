import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "install.sh");

async function fixture({ system = "Linux", architecture = "x86_64", invalidChecksum = false, failDownload = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "folio-installer-test-"));
  const mock = path.join(directory, "mock");
  const assets = path.join(directory, "assets");
  const payload = path.join(directory, "payload");
  const home = path.join(directory, "home");
  const temporary = path.join(directory, "temporary");
  for (const dir of [mock, assets, payload, home, temporary]) await mkdir(dir);
  const platform = system === "Darwin" ? "macos" : "linux";
  const arch = architecture === "arm64" ? "arm64" : "x64";
  const asset = `folio-${platform}-${arch}.tar.gz`;
  let entry = "folio";
  if (system === "Darwin") {
    entry = "Folio.app";
    await mkdir(path.join(payload, entry, "Contents", "MacOS"), { recursive: true });
    await writeFile(path.join(payload, entry, "Contents", "Info.plist"), "<plist/>");
  }
  const executable = system === "Darwin" ? path.join(payload, entry, "Contents", "MacOS", "Folio") : path.join(payload, entry);
  await writeFile(executable, "#!/bin/sh\nprintf 'Folio 0.1.0\\n'\n", { mode: 0o755 });
  const packed = spawnSync("tar", ["-czf", path.join(assets, asset), "-C", payload, entry]);
  assert.equal(packed.status, 0, packed.stderr?.toString());
  const hash = createHash("sha256").update(await readFile(path.join(assets, asset))).digest("hex");
  await writeFile(path.join(assets, "SHA256SUMS"), `${invalidChecksum ? "0".repeat(64) : hash}  ${asset}\n`);
  await writeFile(path.join(mock, "uname"), `#!/bin/sh\ncase "$1" in -s) echo "${system}";; -m) echo "${architecture}";; esac\n`, { mode: 0o755 });
  await writeFile(path.join(mock, "curl"), `#!/bin/sh
set -eu
output=
effective=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output=$2; shift 2 ;;
    --write-out) effective=1; shift 2 ;;
    --proto|--tlsv1.2|--retry) shift 2 ;;
    --*) shift ;;
    *) url=$1; shift ;;
  esac
done
case "$url" in
  https://github.com/HSPK/folio/releases/latest) printf 'https://github.com/HSPK/folio/releases/tag/v0.1.0'; exit 0 ;;
  https://github.com/HSPK/folio/releases/download/v0.1.0/*) ;;
  *) echo "Unexpected URL: $url" >&2; exit 2 ;;
esac
${failDownload ? "exit 22" : 'cp "$FIXTURE_ASSETS/${url##*/}" "$output"'}
`, { mode: 0o755 });
  return {
    directory, home, temporary,
    run(extra = {}) {
      return spawnSync("sh", [script], {
        encoding: "utf8",
        env: { ...process.env, FOLIO_VERSION: "", FOLIO_INSTALL_DIR: "", HOME: home, TMPDIR: temporary,
          PATH: `${mock}:${process.env.PATH}`, FIXTURE_ASSETS: assets, ...extra },
      });
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test("Linux installs a verified executable and cleans downloads", { skip: process.platform === "win32" }, async () => {
  const f = await fixture();
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Installed Folio 0\.1\.0/);
    const binary = path.join(f.home, ".local", "bin", "folio");
    assert.equal(spawnSync(binary, ["--version"], { encoding: "utf8" }).stdout.trim(), "Folio 0.1.0");
    assert.deepEqual(await readdir(f.temporary), []);
  } finally { await f.cleanup(); }
});

test("ARM64 supports version pinning and a directory containing spaces", { skip: process.platform === "win32" }, async () => {
  const f = await fixture({ architecture: "arm64" });
  try {
    const destination = path.join(f.home, "custom bin");
    const result = f.run({ FOLIO_VERSION: "0.1.0", FOLIO_INSTALL_DIR: destination });
    assert.equal(result.status, 0, result.stderr);
    assert.match(await readFile(path.join(destination, "folio"), "utf8"), /Folio/);
  } finally { await f.cleanup(); }
});

test("macOS installs and safely upgrades an application bundle", { skip: process.platform === "win32" }, async () => {
  const f = await fixture({ system: "Darwin", architecture: "arm64" });
  try {
    const destination = path.join(f.home, "Applications", "Folio.app", "Contents", "MacOS", "Folio");
    assert.equal(f.run().status, 0);
    await writeFile(destination, "previous version");
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(await readFile(destination, "utf8"), /Folio 0\.1\.0/);
    assert.deepEqual(await readdir(f.temporary), []);
  } finally { await f.cleanup(); }
});

test("checksum or download failures preserve an existing installation", { skip: process.platform === "win32" }, async () => {
  for (const options of [{ invalidChecksum: true }, { failDownload: true }]) {
    const f = await fixture(options);
    try {
      const destination = path.join(f.home, ".local", "bin");
      await mkdir(destination, { recursive: true });
      await writeFile(path.join(destination, "folio"), "existing installation");
      const result = f.run();
      assert.notEqual(result.status, 0);
      assert.equal(await readFile(path.join(destination, "folio"), "utf8"), "existing installation");
      assert.deepEqual(await readdir(f.temporary), []);
    } finally { await f.cleanup(); }
  }
});

test("unsupported architectures and invalid versions fail before installation", { skip: process.platform === "win32" }, async () => {
  const f = await fixture({ architecture: "i686" });
  const valid = await fixture();
  try {
    assert.match(f.run().stderr, /Only x64 and ARM64/);
    assert.match(valid.run({ FOLIO_VERSION: "../bad" }).stderr, /Invalid release version/);
    assert.deepEqual(await readdir(valid.temporary), []);
  } finally { await f.cleanup(); await valid.cleanup(); }
});
