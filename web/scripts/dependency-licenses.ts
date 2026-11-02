import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/** Locate the package owning a bundled module, including nested scoped packages. */
function dependencyDirectory(input: string) {
  const parts = path.resolve(input).split(path.sep);
  const index = parts.lastIndexOf("node_modules");
  if (index < 0 || !parts[index + 1]) return null;
  const end = index + (parts[index + 1].startsWith("@") ? 3 : 2);
  return parts.slice(0, end).join(path.sep);
}

/** Collect notices for actual bundled dependencies and fail on missing licenses. */
export async function dependencyNotices(
  inputs: Iterable<string>,
  header: string,
  fallbackLicenses: Readonly<Record<string, string>> = {},
) {
  const packages = new Set([...inputs].map(dependencyDirectory).filter((directory) => directory !== null));
  const notices = [header];
  for (const directory of [...packages].sort()) {
    const pkg: unknown = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
    if (
      !pkg ||
      typeof pkg !== "object" ||
      !("name" in pkg) ||
      typeof pkg.name !== "string" ||
      !("version" in pkg) ||
      typeof pkg.version !== "string"
    ) {
      throw new Error(`Invalid bundled package manifest: ${directory}`);
    }
    notices.push(
      `\n${"=".repeat(72)}\n${pkg.name} ${pkg.version}\nLicense: ${"license" in pkg ? pkg.license : "See below"}\n`,
    );
    const licenses = (await readdir(directory, { withFileTypes: true })).filter(
      (entry) => entry.isFile() && /^(?:licen[sc]e|copying|notice)(?:[.-]|$)/i.test(entry.name),
    );
    if (!licenses.length) {
      const fallback = fallbackLicenses[`${pkg.name}@${pkg.version}`];
      if (!fallback) throw new Error(`Missing license file for bundled package ${pkg.name}`);
      notices.push(await readFile(fallback, "utf8"));
    }
    for (const license of licenses) {
      notices.push(`${license.name}\n${await readFile(path.join(directory, license.name), "utf8")}`);
    }
  }
  return notices.join("\n");
}
