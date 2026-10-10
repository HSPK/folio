import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = path.join(root, "docs", "assets");
const build = path.join(root, "build");
const executable = process.env.FOLIO_CAPTURE_EXE
  ?? path.join(build, "rust", "debug", process.platform === "win32" ? "folio-core.exe" : "folio-core");
const content = `---
title: A place for your next idea
tags: [writing, knowledge]
---

# A place for your next idea

Good ideas deserve a little room. **Write freely**, connect what you learn,
and keep your notes as files you can take anywhere.

## Make space for the work

- [x] Start with a folder of Markdown files
- [x] Keep a daily note, a reading list, and a few questions
- [ ] Turn the next small idea into something worth keeping

## Give your ideas a home

| A note for... | A place to start |
| --- | --- |
| Something you learned | One clear explanation |
| A project in progress | Decisions and next steps |
| An unfinished thought | A question worth exploring |

## Connect the dots

Link to your [reading notes](Research/Reading.md), build a small personal wiki,
and come back when a new idea fits. No perfect system required.

> Your workspace should make writing easier, not become another thing to maintain.
`;
const samples = {
  "Welcome.md": content,
  "Daily/Today.md": "---\ntitle: Today\n---\n\n# Today\n\n- [ ] Write one useful paragraph\n- [ ] Take a walk\n",
  "Daily/Weekly-review.md": "---\ntitle: Weekly review\n---\n\n# Weekly review\n\n## What worked\n\n## Next week\n",
  "Projects/Quiet-tools.md": "---\ntitle: Quiet tools\n---\n\n# Quiet tools\n\nBuild tools that leave room for the work.\n",
  "Research/Reading.md": "---\ntitle: Reading notes\n---\n\n# Reading notes\n\n## Questions to keep\n\nWhat would make this idea useful?\n",
  "Research/Questions.md": "---\ntitle: Open questions\n---\n\n# Open questions\n\nOne good question can start a notebook.\n",
};

await mkdir(build, { recursive: true });
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(build, "product-capture-"));
const notes = path.join(directory, "notes");
const ready = path.join(directory, "ready.json");
const stop = path.join(directory, "stop");
let service;
let browser;
let launchError;
let diagnostics = "";
try {
  for (const [name, source] of Object.entries(samples)) {
    const file = path.join(notes, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, source);
  }
  service = spawn(executable, [
    "--serve", notes, "--port", "0", "--auth-file", path.join(directory, "users.json"),
    "--ready-file", ready, "--stop-file", stop,
  ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  service.on("error", error => { launchError = error; });
  service.stderr.on("data", data => { diagnostics += data; });
  let address;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (launchError) throw launchError;
    if (service.exitCode !== null) throw new Error(`Capture service exited: ${diagnostics}`);
    try {
      address = JSON.parse(await readFile(ready, "utf8")).url;
      break;
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(address, `Capture service did not start: ${diagnostics}`);
  browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : undefined,
    headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  async function api(method, endpoint, data) {
    const response = await context.request.fetch(new URL(endpoint, address).href, { method, data });
    assert.ok(response.ok(), `${endpoint}: ${await response.text()}`);
    return response.json();
  }
  await api("POST", "/api/auth/setup", {
    username: "demo", password: "synthetic capture password only",
  });
  await api("GET", "/api/projects");
  await api("POST", "/api/projects", {
    action: "share", id: "default", name: "Field notes", shared: "private",
  });
  const preferences = await api("GET", "/api/preferences");
  preferences.appearance = { theme: "light", latinFont: "sans-serif", cjkFont: "sans-serif" };
  Object.assign(preferences.web, {
    defaultView: "live", fontSizePx: 17, lineHeightPercent: 175, treeRefreshSeconds: 0, spellcheck: false,
  });
  await api("PUT", "/api/preferences", preferences);
  const resource = await api("POST", "/api/resources/resolve", { path: "Welcome.md", kind: "document" });
  const addressWithNote = new URL(address);
  addressWithNote.searchParams.set("project", "default");
  addressWithNote.searchParams.set("document", resource.id);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("folio.layout.pageWidth", "wide"));
  await page.goto(addressWithNote.href);
  await expect(page.locator("#projects-open")).toHaveText("Field notes");
  await expect(page.locator(".ProseMirror[contenteditable=true]")).toBeVisible();
  await expect(page.locator(".ProseMirror h1")).toHaveText("A place for your next idea");
  await expect(page.locator(".ProseMirror table")).toBeVisible();
  await expect(page.locator("#dirty-indicator")).toBeHidden();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(output, "live-light.png"), animations: "disabled" });

  preferences.appearance.theme = "dark";
  await api("PUT", "/api/preferences", preferences);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.locator("#view-menu > summary").click();
  await page.locator("#view-split").click();
  await expect(page.locator("#editor")).toBeVisible();
  await expect(page.locator("#preview")).toBeVisible();
  await expect(page.locator("#preview h1")).toHaveText("A place for your next idea");
  await page.screenshot({ path: path.join(output, "compare-dark.png"), animations: "disabled" });
  assert.deepEqual(pageErrors, [], "The screenshot session encountered application errors.");

  const svg = await readFile(path.join(output, "banner.svg"), "utf8");
  const graphic = await browser.newPage({ viewport: { width: 1280, height: 640 } });
  await graphic.setContent(`<html><body style="margin:0">${svg}</body></html>`);
  await graphic.screenshot({ path: path.join(output, "social-preview.png") });
  console.log("Captured docs/assets/live-light.png, compare-dark.png and social-preview.png.");
} finally {
  if (browser) await browser.close();
  if (service && !launchError && service.exitCode === null) {
    const exited = once(service, "exit");
    await writeFile(stop, "");
    const timer = setTimeout(() => service.kill(), 5000);
    const [code] = await exited;
    clearTimeout(timer);
    if (code !== 0) throw new Error(`Capture service did not stop cleanly: ${diagnostics}`);
  }
  await rm(directory, { recursive: true, force: true });
}
