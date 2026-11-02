import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const buildRoot = path.resolve(webRoot, "..", "build");
export const executable = process.env.FOLIO_TEST_EXE
  ?? path.join(buildRoot, "rust", "debug", process.platform === "win32" ? "folio-core.exe" : "folio-core");
export const initialText = "# Welcome\n\nA **local** notebook.\n\n"
  + "- [ ] A task\n\n| Name | Value |\n| --- | --- |\n| Folio | Local |\n\n"
  + "```rust\nfn main() {}\n```\n\n![Pixel](images/pixel.png)\n\n[Second](Second.md)\n";
const defaultPreferences = {
  appearance: { theme: "system", latinFont: "sans-serif", cjkFont: "sans-serif" },
  web: {
    autoSaveDelayMs: 1000,
    defaultView: "live",
    sourceLineWrap: true,
    spellcheck: true,
    fontSizePx: 17,
    lineHeightPercent: 175,
    density: "comfortable",
    defaultSidebar: "files",
    sidebarOpen: true,
    hiddenPatterns: [],
    treeRefreshSeconds: 0,
    largeDocumentThresholdKib: 768,
    previewDelayMs: 300,
    outlineDelayMs: 75,
    reducedMotion: false,
    highContrast: false,
    strongFocus: true,
  },
};
let directory;
export let root;
let ready;
let stop;
let child;
let launchUrl;
let diagnostics = "";

export const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
export const primaryModifier = process.platform === "darwin" ? "Meta" : "Control";
export async function confirmDialog(page, { accept = true } = {}) {
  const region = page.locator("[data-confirmation-region]:visible");
  await expect(region).toHaveCount(1);
  await expect(page.locator("dialog[open]")).toHaveCount(1);
  await region.locator(accept ? "[data-confirmation-proceed]" : "[data-confirmation-cancel]").click();
  await expect(region).toBeHidden();
}

export async function chooseView(page, id) {
  await page.locator("#view-menu > summary").click();
  await page.locator(`#view-${id}`).click();
}

/** Open the independent heading navigator without changing the sidebar section. */
export async function openOutline(page) {
  const trigger = page.locator("#outline-tab");
  if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click();
  await expect(page.locator("#outline-panel")).toBeVisible();
}

export async function openMoreAction(page, id) {
  const menu = page.locator("#more-menu");
  if (await menu.getAttribute("open") === null) await menu.locator(":scope > summary").click();
  const action = page.locator(`#${id}`);
  const disclosure = await action.evaluate(node => node.closest(".menu-disclosure")?.id ?? null);
  if (disclosure && await page.locator(`#${disclosure}`).getAttribute("open") === null) {
    await page.locator(`#${disclosure} > summary`).click();
  }
  await action.click();
}

export async function selectSettingsSection(page, section) {
  const picker = page.locator("#settings-section");
  if (await picker.isVisible()) await picker.selectOption(section);
  else await page.locator(`[data-settings-tab="${section}"]`).click();
  await expect(page.locator(`[data-settings-panel="${section}"]`)).toBeVisible();
}

export async function openSettingsDialog(page, { section } = {}) {
  await openMoreAction(page, "settings-open");
  await expect(page.locator("#settings-dialog")).toBeVisible();
  if (section) await selectSettingsSection(page, section);
}

export async function reloadDocument(page) {
  await openMoreAction(page, "reload-document");
}

export async function openImageOptions(page, { custom = false } = {}) {
  await page.locator(".folio-inline-image").first().hover();
  const panel = page.locator("#folio-image-options");
  if (!await panel.isVisible()) await page.getByRole("button", { name: "Image size and layout", exact: true }).click();
  await expect(panel).toBeVisible();
  if (custom && await panel.locator("details").getAttribute("open") === null) {
    await panel.locator("details > summary").click();
  }
  return panel;
}

export async function openTableTools(page, index = 0, axis = "column") {
  const tools = page.getByRole("menu", { name: "Table actions", exact: true });
  if (await tools.isVisible()) {
    await tools.press("Escape");
    await expect(tools).toBeHidden();
  }
  const table = page.locator(".folio-table-wrapper").nth(index);
  if (axis === "table") await table.hover();
  if (axis !== "table" && !await table.evaluate(node => node.classList.contains("is-active"))) await table.locator("th, td").first().click();
  await (axis === "table" ? page : table).getByRole("button", {
    name: axis === "row" ? "Row actions" : axis === "table" ? "Table actions" : "Column actions", exact: true,
  }).click();
  await expect(tools).toBeVisible();
  return tools;
}

export async function openBlockTools(page, block, label) {
  const opened = page.locator('.folio-node-toolbar[role="menu"]:not([inert]):visible');
  if (await opened.count()) await opened.press("Escape");
  await hoverBlockTools(page, block, label);
  await page.locator(".folio-block-grip").click();
  const menu = page.getByRole("menu", { name: label === "Table" ? "Table actions" : "Block actions", exact: true });
  await expect(menu).toBeVisible();
  return menu;
}

export async function hoverBlockTools(page, block, label) {
  await block.hover();
  const grip = page.locator(".folio-block-grip");
  await expect(grip).toHaveAttribute("aria-label", `${label} actions`);
  return page.getByRole("group", { name: "Block controls", exact: true });
}

export async function openLinkOptions(page, link = page.locator(".ProseMirror a").first()) {
  await link.click();
  const actions = page.getByRole("toolbar", { name: "Link actions" });
  await expect(actions).toBeVisible();
  await actions.getByRole("button", { name: /^(Edit link|Link details)$/ }).click();
  const dialog = page.getByRole("dialog", { name: "Link options" });
  await expect(dialog).toBeVisible();
  return dialog;
}

export async function openFixture(page, name, content, displayTitle = name) {
  await fs.writeFile(path.join(root, name), content);
  await page.goto(await fixtureDocumentUrl(name));
  await expect(page.locator("#document-title")).toHaveText(displayTitle);
  await expect(page.locator(".ProseMirror[contenteditable=true]")).toBeVisible();
}

async function fixtureDocumentUrl(path) {
  const url = new URL(launchUrl);
  const token = url.hash.match(/(?:^#|&)token=([a-f0-9]+)/i)?.[1];
  const response = await fetch(new URL("/api/resources/resolve", url), {
    method: "POST", headers: { Authorization: ["Bearer", token].join(" "), "Content-Type": "application/json" },
    body: JSON.stringify({path, kind: "document"}),
  });
  expect(response.ok, await response.clone().text()).toBe(true);
  url.searchParams.set("document", (await response.json()).id);
  return url.href;
}

export async function userResourceId(context, base, path, kind = "document", project = "default") {
  const response = await context.request.post(new URL("/api/resources/resolve", base).href, {
    headers: { "X-Folio-Project": project }, data: { path, kind },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).id;
}

export async function userDocumentUrl(context, base, path, project = "default") {
  const id = await userResourceId(context, base, path, "document", project);
  const url = new URL(base);
  url.searchParams.set("document", id);
  url.searchParams.set("project", project);
  return url.href;
}

export async function metadataField(page) {
  const panel = page.locator(".folio-metadata > details");
  await expect(panel).toBeVisible();
  if (await panel.getAttribute("open") === null) await panel.locator(":scope > summary").click();
  const advanced = panel.locator(".folio-metadata-advanced");
  if (await advanced.getAttribute("open") === null) await advanced.locator("summary").click();
  return panel.locator("textarea");
}

test.beforeAll(async () => {
  await fs.mkdir(buildRoot, { recursive: true });
  directory = await fs.mkdtemp(path.join(buildRoot, "browser-fixture-"));
  root = path.join(directory, "notes");
  ready = path.join(directory, "ready.json");
  stop = path.join(directory, "stop");
  await fs.mkdir(path.join(root, "images"), { recursive: true });
  await fs.writeFile(path.join(root, "images", "pixel.png"), Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  ));
  child = spawn(executable, [
    "--serve", root, "--port", "0", "--ready-file", ready, "--stop-file", stop,
    "--auth-mode", "token",
  ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let launchError;
  child.on("error", (error) => { launchError = error; });
  child.stdout.on("data", (data) => { diagnostics += data; });
  child.stderr.on("data", (data) => { diagnostics += data; });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw new Error(`Folio exited: ${diagnostics}`);
    try {
      launchUrl = JSON.parse(await fs.readFile(ready, "utf8")).url;
      break;
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await delay(100);
  }
  expect(launchUrl, `The native service did not initialize: ${diagnostics}`).toBeTruthy();
});

test.afterAll(async () => {
  if (child && child.exitCode === null) {
    await fs.writeFile(stop, "");
    for (let attempt = 0; attempt < 50 && child.exitCode === null; attempt += 1) await delay(100);
    if (child.exitCode === null) {
      child.kill();
      throw new Error("The native service failed to stop gracefully.");
    }
  }
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.notesDiagnostics = [];
    window.addEventListener("securitypolicyviolation", (event) => {
      window.notesDiagnostics.push(`CSP: ${event.violatedDirective}`);
    });
    window.addEventListener("error", (event) => {
      window.notesDiagnostics.push(event.message);
    });
    window.addEventListener("unhandledrejection", (event) => {
      window.notesDiagnostics.push(String(event.reason));
    });
  });
  await fs.writeFile(path.join(root, "README.md"), initialText);
  await fs.writeFile(path.join(root, "Second.md"), "# Second\n\nAnother note.\n");
  await fs.writeFile(path.join(root, "Unsupported.md"), "# Source\n\n<div>Keep this HTML</div>\n");
  const token = new URL(launchUrl).hash.match(/(?:^#|&)token=([a-f0-9]+)/i)?.[1];
  const settings = await fetch(new URL("/api/preferences", launchUrl), {
    method: "PUT",
    headers: {
      Authorization: ["Bearer", token].join(" "),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(defaultPreferences),
  });
  expect(settings.ok, await settings.text()).toBeTruthy();
  await page.goto(await fixtureDocumentUrl("README.md"));
  await expect(page.locator("#document-title")).toHaveText("README.md");
  await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
  await expect(page.locator("#dirty-indicator")).toBeHidden();
  await expect(page.locator("#document-modified")).toBeHidden();
});

test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) {
    expect(await page.evaluate(() => window.notesDiagnostics)).toEqual([]);
  }
});


export { test, expect, fs, path };
