import { spawn } from "node:child_process";

import { test, expect, fs, path, buildRoot, executable, delay, primaryModifier, openSettingsDialog } from "./fixture.mjs";
import { collaborativeLibrary } from "./collaboration-cases.mjs";

async function reauthenticateAlice(page) {
  await page.locator("#auth-username").fill("alice");
  await page.locator("#auth-password").fill("alice test password long enough");
  await page.locator("#auth-submit").click();
  await expect(page.locator("#auth-screen")).toBeHidden();
  await expect(page.locator("#editor")).toHaveJSProperty("readOnly", false);
}

test("background login expiry prompts once and reauthenticates without replacing the local note", async ({ browser, browserName }) => {
  const library = await collaborativeLibrary(browser, { participants: 1, source: true, saveDelay: 10000 });
  try {
    const [page] = library.pages;
    await page.setViewportSize({ width: 1440, height: 960 });
    const cookie = (await page.context().cookies()).find(cookie => cookie.name.startsWith("folio_user_session_"));
    expect(cookie?.expires).toBeGreaterThan(Date.now() / 1000 + 365 * 24 * 60 * 60);
    const initial = await fs.readFile(path.join(library.notes, "Shared.md"), "utf8");
    const checked = page.waitForResponse(response => new URL(response.url()).pathname === "/api/collaboration/presence" && response.ok());
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await checked;
    const local = "# Local note must survive login\n\nUnsaved text from this tab.\n";
    await page.locator("#editor").fill(local);
    const url = page.url();
    let navigations = 0;
    page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations++; });
    const background = [];
    page.on("request", request => {
      const path = new URL(request.url()).pathname;
      if (["/api/collaboration/presence", "/api/appearance", "/api/workspace"].includes(path)) background.push(path);
    });
    await page.context().clearCookies();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.locator("#auth-screen")).toBeVisible({ timeout: 3000 });
    await expect(page.locator("#auth-error")).toContainText("Log in again");
    await expect(page.locator("#editor")).toHaveValue(local);
    await page.waitForTimeout(100);
    const requests = background.length;
    await page.evaluate(() => { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("focus")); });
    await page.waitForTimeout(2200);
    expect(background.length).toBe(requests);
    expect(await fs.readFile(path.join(library.notes, "Shared.md"), "utf8")).toBe(initial);
    if (browserName !== "webkit") {
      await page.screenshot({ path: test.info().outputPath("expired-login-desktop.png"), caret: "initial" });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: test.info().outputPath("expired-login-narrow.png"), caret: "initial" });
      await page.setViewportSize({ width: 1440, height: 960 });
    }
    await reauthenticateAlice(page);
    await expect(page.locator("#editor")).toHaveValue(local);
    await expect(page.locator("#draft-recovery-dialog")).toBeHidden();
    expect(page.url()).toBe(url);
    expect(navigations).toBe(0);
    await page.locator("#editor").focus();
    await page.keyboard.press(`${primaryModifier}+s`);
    await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    expect(await fs.readFile(path.join(library.notes, "Shared.md"), "utf8")).toBe(local);

    const newer = "# Another local draft\n\nDo not overwrite an external edit.\n";
    await page.locator("#editor").fill(newer);
    await page.context().clearCookies();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.locator("#auth-screen")).toBeVisible();
    await fs.writeFile(path.join(library.notes, "Shared.md"), "# Changed externally\n");
    await reauthenticateAlice(page);
    await expect(page.locator("#editor")).toHaveValue(newer);
    await page.locator("#editor").focus();
    await page.keyboard.press(`${primaryModifier}+s`);
    await expect(page.locator("#dirty-indicator")).toHaveAttribute("data-state", "conflict");
    expect(await fs.readFile(path.join(library.notes, "Shared.md"), "utf8")).toBe("# Changed externally\n");
  } finally { await library.close(); }
});

test("obsolete workspace requests are canceled without relocking a successfully renewed login", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { participants: 1, source: true, saveDelay: 10000 });
  let release;
  try {
    const [page] = library.pages;
    let arrived;
    const requested = new Promise(resolve => { arrived = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    let completed;
    const finished = new Promise(resolve => { completed = resolve; });
    let intercepted = false;
    let obsolete;
    await page.route("**/api/workspace", async route => {
      if (route.request().method() !== "GET" || intercepted) return route.continue();
      intercepted = true;
      obsolete = route.request();
      arrived();
      await held;
      await route.fulfill({ status: 401, json: { error: "Log in to continue." } });
      completed();
    });
    const canceled = page.waitForEvent("requestfailed", request => request === obsolete);
    const local = "# Kept through a late response\n";
    await page.locator("#editor").fill(local);
    await page.context().clearCookies();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await requested;
    await expect(page.locator("#auth-screen")).toBeVisible();
    expect((await canceled).failure()?.errorText).toMatch(/abort|cancel/i);
    await reauthenticateAlice(page);
    release();
    await finished;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    await expect(page.locator("#auth-screen")).toBeHidden();
    await expect(page.locator("#editor")).toHaveJSProperty("readOnly", false);
    await expect(page.locator("#editor")).toHaveValue(local);
    await expect(page.locator("#document-message")).not.toContainText("Log in to continue");
  } finally { release?.(); await library.close(); }
});

test("renewing a login keeps the Live document and its undo history", async ({ browser, browserName }) => {
  const library = await collaborativeLibrary(browser, { participants: 1, saveDelay: 10000 });
  try {
    const [page] = library.pages;
    const initial = await fs.readFile(path.join(library.notes, "Shared.md"), "utf8");
    await page.locator(".ProseMirror h1").click();
    await page.keyboard.press("End");
    await page.keyboard.insertText(" locally edited");
    const local = await page.locator("#editor").inputValue();
    await page.context().clearCookies();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.locator("#auth-screen")).toBeVisible();
    await reauthenticateAlice(page);
    await expect(page.locator(".ProseMirror[contenteditable=true] h1")).toHaveText("Shared locally edited");
    await expect(page.locator("#editor")).toHaveValue(local);
    await page.locator(".ProseMirror").focus();
    await page.keyboard.press(`${primaryModifier}+z`);
    await expect(page.locator("#editor")).toHaveValue(initial);
    await page.keyboard.press(`${primaryModifier}+Shift+z`);
    await expect(page.locator("#editor")).toHaveValue(local);
    if (browserName !== "webkit") await page.screenshot({
      path: test.info().outputPath("renewed-login-keeps-live-draft.png"), caret: "initial",
    });
  } finally { await library.close(); }
});

test("renewing a collaborative login merges retained drafts with edits made during authentication", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { source: true, saveDelay: 10000 });
  try {
    const [alice, bob] = library.pages;
    await alice.locator("#editor").evaluate(editor => {
      editor.focus();
      editor.setSelectionRange(editor.value.length, editor.value.length);
    });
    await alice.keyboard.insertText("\nAlice before expiry\n");
    await expect(bob.locator("#editor")).toHaveValue(/Alice before expiry/);
    await alice.context().clearCookies();
    await alice.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(alice.locator("#auth-screen")).toBeVisible();
    await bob.locator("#editor").evaluate(editor => {
      editor.focus();
      editor.setSelectionRange(editor.value.length, editor.value.length);
    });
    await bob.keyboard.insertText("\nBob during authentication\n");
    await reauthenticateAlice(alice);
    await expect(alice.locator("#collaboration-join")).toHaveAttribute("aria-pressed", "true");
    await expect(alice.locator("#draft-recovery-dialog")).toBeHidden();
    for (const page of [alice, bob]) {
      await expect(page.locator("#editor")).toHaveValue(/Alice before expiry[\s\S]*Bob during authentication/);
    }
    await alice.locator("#editor").focus();
    await alice.keyboard.press(`${primaryModifier}+s`);
    await expect(alice.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    expect(await fs.readFile(path.join(library.notes, "Shared.md"), "utf8"))
      .toContain("Bob during authentication");
  } finally { await library.close(); }
});

test("renewing a collaborative login resumes solo saving after the last peer and old lease have gone", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { source: true, saveDelay: 10000 });
  try {
    const [alice, bob] = library.pages;
    await alice.locator("#editor").evaluate(editor => {
      editor.focus();
      editor.setSelectionRange(editor.value.length, editor.value.length);
    });
    await alice.keyboard.insertText("\nAlice before expiry\n");
    await expect(bob.locator("#editor")).toHaveValue(/Alice before expiry/);
    const checked = alice.waitForResponse(response => new URL(response.url()).pathname === "/api/collaboration/presence" && response.ok());
    await alice.evaluate(() => window.dispatchEvent(new Event("focus")));
    const { participant } = await (await checked).json();
    const local = await alice.locator("#editor").inputValue();
    await bob.close();
    await expect(alice.locator(".collaboration-avatar")).toHaveCount(1);
    const left = await alice.request.post(new URL("/api/collaboration/presence", alice.url()).href, {
      data: { document: new URL(alice.url()).searchParams.get("document"), participant, leave: true },
    });
    expect(left.ok()).toBe(true);
    await alice.context().clearCookies();
    await alice.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(alice.locator("#auth-screen")).toBeVisible();
    await expect.poll(() => fs.readFile(path.join(library.notes, "Shared.md"), "utf8")).toBe(local);
    await reauthenticateAlice(alice);
    await expect(alice.locator("#collaboration-join")).toBeHidden();
    await expect(alice.locator("#editor")).toHaveValue(local);
    await alice.locator("#editor").fill(`${local}\nNow saving solo\n`);
    await alice.keyboard.press(`${primaryModifier}+s`);
    await expect(alice.locator("#dirty-indicator")).toHaveAttribute("data-state", "saved");
    expect(await fs.readFile(path.join(library.notes, "Shared.md"), "utf8")).toBe(`${local}\nNow saving solo\n`);
  } finally { await library.close(); }
});

test("switching accounts after expiry never exposes the previous account's local draft", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { participants: 1, source: true, saveDelay: 10000 });
  try {
    const [page] = library.pages;
    const initial = await fs.readFile(path.join(library.notes, "Shared.md"), "utf8");
    const local = "# Private unsaved text for the first account\n";
    await page.locator("#editor").fill(local);
    await page.context().clearCookies();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.locator("#auth-screen")).toBeVisible();
    await page.locator("#auth-username").fill("bob");
    await page.locator("#auth-password").fill("bob test password long enough");
    await page.locator("#auth-submit").click();
    await expect(page.locator("#auth-screen")).toBeHidden();
    await expect(page.locator("#logout")).toHaveText("Log out bob");
    await expect(page.locator("#editor")).not.toHaveValue(local);
    expect(await fs.readFile(path.join(library.notes, "Shared.md"), "utf8")).toBe(initial);
    await page.locator("#more-menu > summary").click();
    await page.locator("#logout").click();
    await expect(page.locator("#auth-screen")).toBeVisible();
    await reauthenticateAlice(page);
    await expect(page.locator("#draft-recovery-dialog")).toBeVisible();
    await expect(page.locator("#draft-recovery-source")).toHaveValue(local);
  } finally { await library.close(); }
});

test("Folio branding appears in the workspace, login screen and shared icon", async ({ page }) => {
  await expect(page.locator("#app-name")).toHaveText("Folio");
  await expect(page).toHaveTitle("README.md — Folio");
  const icon = await page.request.get(new URL("/icon.svg", page.url()).href);
  expect(icon.ok()).toBe(true);
  expect(await icon.text()).toContain("<title>Folio - Folded F</title>");

  await page.route("**/api/auth/status", route => route.fulfill({
    json: { mode: "users", authenticated: false, setupRequired: false },
  }));
  await page.reload();
  await expect(page.locator("#auth-screen")).toBeVisible();
  await expect(page.locator("#auth-title")).toHaveText("Log in to Folio");
  await expect(page.locator("#auth-description, #auth-hint")).toHaveCount(0);
  await expect(page).toHaveTitle("Folio");
  await expect.poll(() => page.locator("#auth-screen img").evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
});

test("login survives refresh and service restart, while logout requires login again", async ({ browser }) => {
  const fixture = await fs.mkdtemp(path.join(buildRoot, "auth-browser-"));
  const notes = path.join(fixture, "notes");
  const authFile = path.join(fixture, "users.json");
  const readyFile = path.join(fixture, "ready.json");
  const stopFile = path.join(fixture, "stop");
  const imported = await fs.mkdtemp(path.join(buildRoot, "auth-local-folder-"));
  await fs.mkdir(notes);
  await fs.writeFile(path.join(notes, "Shared.md"), "# Shared\n");
  await fs.writeFile(path.join(imported, "Imported.md"), "# Imported\n");
  let output = "";
  const launch = (port = "0") => {
    const service = spawn(executable, [
      "--serve", notes, "--port", port, "--ready-file", readyFile, "--stop-file", stopFile,
      "--auth-file", authFile,
    ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    service.stdout.on("data", (data) => { output += data; });
    service.stderr.on("data", (data) => { output += data; });
    return service;
  };
  let service = launch();
  const readyUrl = async () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (service.exitCode !== null) throw new Error(`Authenticated Folio exited: ${output}`);
      try {
        return JSON.parse(await fs.readFile(readyFile, "utf8")).url;
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      }
      await delay(100);
    }
    throw new Error(`Authenticated Folio did not initialize: ${output}`);
  };
  const context = await browser.newContext();
  try {
    const url = await readyUrl();
    const page = await context.newPage();
    await page.goto(url);
    await expect(page.locator("#auth-title")).toHaveText("Create the administrator");
    await expect(page.locator("#auth-description, #auth-hint")).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("setup-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({ path: test.info().outputPath("setup-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.locator("#auth-username").fill("Owner");
    await page.locator("#auth-password").fill("x");
    await page.locator("#auth-confirm").fill("x");
    await page.locator("#auth-submit").click();
    await expect(page.locator("#auth-screen")).toBeHidden();
    await expect(page.locator("#connection-label")).toHaveText("Local service");
    await expect(page.locator("#connection-label")).toBeHidden();
    await expect(page.locator('#file-list [data-path="Shared.md"]')).toBeVisible();
    await page.reload();
    await expect(page.locator("#auth-screen")).toBeHidden();
    await expect(page.locator('#file-list [data-path="Shared.md"]')).toBeVisible();

    await openSettingsDialog(page);
    await expect(page.locator("#settings-projects-open")).toBeVisible();
    await expect(page.locator("#hidden-patterns-hint")).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("library-settings.png"), fullPage: true });
    await page.locator("#settings-projects-open").click();
    await expect(page.locator("#settings-dialog")).not.toBeVisible();
    await expect(page.locator("#projects-dialog")).toBeVisible();
    await expect(page.locator("dialog[open]")).toHaveCount(1);
    await page.locator("#project-new").click();
    await page.locator("#project-name").fill("Local folder");
    await page.locator("#project-kind").selectOption("folder");
    await page.locator("#project-source").fill(imported);
    await page.locator("#project-create").click();
    await expect(page.locator("#projects-open")).toHaveText("Local folder");
    await expect(page.locator('#file-list [data-path="Imported.md"]')).toBeVisible();
    await page.locator("#projects-open").click();
    await page.locator('.project-open[data-project="default"]').click();
    await expect(page.locator('#file-list [data-path="Shared.md"]')).toBeVisible();

    const cookies = (await context.cookies()).filter((cookie) =>
      cookie.name.startsWith("folio_user_session_"));
    expect(cookies).toHaveLength(1);
    expect(cookies[0].httpOnly).toBe(true);
    expect(cookies[0].sameSite).toBe("Strict");
    expect(cookies[0].expires).toBeGreaterThan(Date.now() / 1000 + 365 * 24 * 60 * 60);
    await fs.writeFile(stopFile, "");
    await expect.poll(() => service.exitCode).toBe(0);
    await fs.rm(readyFile);
    await fs.rm(stopFile);
    service = launch(new URL(url).port);
    expect(await readyUrl()).toBe(url);
    await page.reload();
    await expect(page.locator("#auth-screen")).toBeHidden();
    await expect(page.locator('#file-list [data-path="Shared.md"]')).toBeVisible();

    await page.locator("#more-menu > summary").click();
    const loggedOut = page.waitForEvent("domcontentloaded");
    await page.locator("#logout").click();
    await loggedOut;
    await expect(page.locator("#auth-screen")).toBeVisible();
    await expect(page.locator("#auth-title")).toHaveText("Log in to Folio");
    await page.reload();
    await expect(page.locator("#auth-screen")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("login.png"), fullPage: true });
    await page.locator("#auth-username").fill("owner");
    await page.locator("#auth-password").fill("x");
    await page.locator("#auth-submit").click();
    await expect(page.locator("#auth-screen")).toBeHidden();
    await expect(page.locator("#connection-label")).toHaveText("Local service");
    await expect(page.locator("#connection-label")).toBeHidden();

    await openSettingsDialog(page);
    await page.locator('[data-settings-tab="users"]').click();
    await page.locator("#accounts-list").getByRole("button", { name: "Reset password" }).click();
    await expect(page.locator("dialog[open]")).toHaveCount(1);
    await expect(page.locator("#settings-dialog")).toBeHidden();
    await page.locator("#account-password-cancel").click();
    await expect(page.locator("#settings-dialog")).toBeVisible();
    await expect(page.locator("dialog[open]")).toHaveCount(1);
    await page.locator("#accounts-list").getByRole("button", { name: "Reset password" }).click();
    await expect(page.locator('label[for="account-password"]')).toHaveText("New password");
    await page.screenshot({ path: test.info().outputPath("password-reset.png"), fullPage: true });
    const password = "x".repeat(4096);
    await page.locator("#account-password").fill(password);
    const changedPassword = page.waitForEvent("domcontentloaded");
    await page.locator("#account-password-form .button-primary").click();
    await changedPassword;
    await expect(page.locator("#auth-screen")).toBeVisible();
    await page.locator("#auth-username").fill("owner");
    await page.locator("#auth-password").fill(password);
    await page.locator("#auth-submit").click();
    await expect(page.locator("#auth-screen")).toBeHidden();

    const stored = await fs.readFile(authFile, "utf8");
    expect(stored).toContain("argon2id");
    expect(stored).not.toContain(password);
  } finally {
    await context.close();
    await fs.writeFile(stopFile, "");
    for (let attempt = 0; attempt < 100 && service.exitCode === null; attempt += 1) {
      await delay(50);
    }
    if (service.exitCode === null) service.kill();
    await fs.rm(fixture, { recursive: true, force: true });
    await fs.rm(imported, { recursive: true, force: true });
  }
});
