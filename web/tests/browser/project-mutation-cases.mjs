import { test, expect, openSettingsDialog } from "./fixture.mjs";
import { collaborativeLibrary } from "./collaboration-cases.mjs";

async function projects(page, url, body) {
  const response = await page.request.post(new URL("/api/projects", url).href, { data: body });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test("partial settings saves preserve project patches and retry preferences without rewriting sharing", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { participants: 1, source: true, sharing: "private" });
  try {
    const [page] = library.pages;
    await openSettingsDialog(page, { section: "library" });
    await projects(page, library.url, { action: "share", id: "default", shared: "read" });
    const sent = [];
    page.on("request", request => {
      if (new URL(request.url()).pathname === "/api/projects" && request.method() === "POST") sent.push(request.postDataJSON());
    });
    const rejected = route => route.request().method() === "PUT"
      ? route.fulfill({ status: 503, json: { error: "Preferences save unavailable." } }) : route.continue();
    await page.route("**/api/preferences", rejected);
    await page.locator("#settings-image-directory").fill("media/partial-save");
    await page.locator("#settings-save").click();
    await expect(page.locator("#settings-error")).toContainText("project image directory was saved");
    await page.screenshot({ path: test.info().outputPath("partial-settings-save.png"), animations: "disabled" });
    const response = await page.request.get(new URL("/api/projects", library.url).href);
    const current = (await response.json()).find(project => project.id === "default");
    expect(current.imageDirectory).toBe("media/partial-save");
    expect(current.shared).toBe("read");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ action: "share", id: "default", imageDirectory: "media/partial-save" });
    await page.unroute("**/api/preferences", rejected);
    await page.locator("#settings-save").click();
    await expect(page.locator("#settings-dialog")).toBeHidden();
    expect(sent).toHaveLength(1);
  } finally { await library.close(); }
});

test("settings saves preserve input typed after submission and keep the newer edit pending", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { participants: 1, source: true });
  let release;
  try {
    const [page] = library.pages;
    await openSettingsDialog(page, { section: "appearance" });
    let started;
    const requested = new Promise(resolve => { started = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    let first = true;
    const sent = [];
    await page.route("**/api/preferences", async route => {
      if (route.request().method() !== "PUT") return route.continue();
      sent.push(route.request().postDataJSON());
      if (first) { first = false; started(); await held; }
      await route.continue();
    });
    await page.locator("#settings-latin-font").fill("serif");
    await page.locator("#settings-save").click();
    await requested;
    await page.locator("#settings-latin-font").fill("monospace");
    release();
    await expect(page.locator("#settings-error")).toContainText("Newer edits remain unsaved");
    await expect(page.locator("#settings-latin-font")).toHaveValue("monospace");
    expect(sent[0].appearance.latinFont).toBe("serif");
    await page.locator("#settings-save").click();
    await expect(page.locator("#settings-dialog")).toBeHidden();
    expect(sent[1].appearance.latinFont).toBe("monospace");
  } finally { release?.(); await library.close(); }
});

test("late settings patches update their original project without replacing a subsequently selected project", async ({ browser }) => {
  const library = await collaborativeLibrary(browser, { participants: 1, source: true });
  let release;
  try {
    const [page] = library.pages;
    const next = await projects(page, library.url, { action: "create", name: "Selected later", kind: "new" });
    await page.locator("#projects-open").click();
    await expect(page.locator(`.project-open[data-project="${next.id}"]`)).toBeVisible();
    await page.locator("#projects-close").click();
    await openSettingsDialog(page, { section: "library" });
    let started;
    const requested = new Promise(resolve => { started = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    await page.route("**/api/projects", async route => {
      if (route.request().method() !== "POST") return route.continue();
      const body = route.request().postDataJSON();
      if (body.action !== "share" || body.id !== "default") return route.continue();
      const response = await route.fetch();
      started();
      await held;
      await route.fulfill({ response });
    });
    await page.locator("#settings-image-directory").fill("media/original-project");
    await page.locator("#settings-save").click();
    await requested;
    await page.evaluate(id => {
      const url = new URL(location.href);
      url.searchParams.set("project", id);
      url.searchParams.delete("document");
      history.pushState(null, "", url);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, next.id);
    await expect(page.locator("#projects-open")).toHaveText("Selected later");
    release();
    await expect(page.locator("#settings-error")).toContainText("original project");
    await expect(page.locator("#projects-open")).toHaveText("Selected later");
    expect(new URL(page.url()).searchParams.get("project")).toBe(next.id);
    const catalog = await (await page.request.get(new URL("/api/projects", library.url).href)).json();
    expect(catalog.find(project => project.id === "default").imageDirectory).toBe("media/original-project");
    expect(catalog.find(project => project.id === next.id).imageDirectory).toBe(next.imageDirectory);
  } finally { release?.(); await library.close(); }
});
