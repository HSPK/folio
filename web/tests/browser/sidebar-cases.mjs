import { test, expect, fs, path, root, chooseView, confirmDialog, openFixture, openMoreAction, primaryModifier } from "./fixture.mjs";
import { summarizeTimings } from "./performance-helpers.mjs";

for (const width of [1440, 390]) {
  test(`sidebar refresh preserves the chosen open or closed state over shared defaults at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.locator("body")).toHaveAttribute("data-sidebar", width === 390 ? "closed" : "open");
    let defaultOpen = true;
    await page.route("**/api/preferences", async route => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      const preferences = await response.json();
      preferences.web.sidebarOpen = defaultOpen;
      await route.fulfill({ response, json: preferences });
    });
    for (const state of ["closed", "open", "closed"]) {
      if (await page.locator("body").getAttribute("data-sidebar") !== state) {
        await page.locator(state === "open" ? "#sidebar-toggle" : "#sidebar-hide").click();
      }
      defaultOpen = state !== "open";
      await page.reload();
      await expect(page.locator(".ProseMirror[contenteditable=true]")).toBeVisible();
      await expect(page.locator("body")).toHaveAttribute("data-sidebar", state);
      await expect(page.locator("#sidebar")).toHaveJSProperty("inert", state === "closed");
      if (state === "open") await expect(page.locator("#sidebar")).toBeVisible();
      else await expect(page.locator("#sidebar")).toBeHidden();
    }
    if (width === 390) {
      await page.locator("#sidebar-toggle").click();
      await page.locator('#file-list [data-path="Second.md"]').click();
      await expect(page.locator(".ProseMirror")).toHaveText("SecondAnother note.");
      await expect(page.locator("#sidebar")).toBeHidden();
      await page.reload();
      await expect(page.locator(".ProseMirror")).toHaveText("SecondAnother note.");
      await expect(page.locator("#sidebar")).toBeHidden();
    }
  });
}

test("keyboard sidebar choices survive refresh while distraction-free closure stays temporary", async ({ page }) => {
  for (const state of ["closed", "open"]) {
    await page.keyboard.press(`${primaryModifier}+Shift+l`);
    await expect(page.locator("body")).toHaveAttribute("data-sidebar", state);
    await page.reload();
    await expect(page.locator(".ProseMirror[contenteditable=true]")).toBeVisible();
    await expect(page.locator("body")).toHaveAttribute("data-sidebar", state);
  }
  await openMoreAction(page, "focus-mode");
  await expect(page.locator("#sidebar")).toBeHidden();
  await fs.writeFile(path.join(root, "README.md"), "# Sidebar focus reload\n\nKept.\n");
  await openMoreAction(page, "reload-document");
  await expect(page.locator(".ProseMirror")).toContainText("Sidebar focus reload");
  await expect(page.locator("#sidebar")).toBeHidden();
  await page.reload();
  await expect(page.locator(".ProseMirror[contenteditable=true]")).toBeVisible();
  await expect(page.locator("#sidebar")).toBeVisible();
});

test("mobile sidebar refresh also preserves state when restoring a file panel", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const name = "Sidebar-refresh.py";
  await fs.writeFile(path.join(root, name), 'print("kept")\n');
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.locator("#sidebar-toggle").click();
  await page.locator(`[data-panel-path="${name}"]`).click();
  await expect(page.locator("#panel-body")).toContainText('print("kept")');
  await expect(page.locator("#sidebar")).toBeHidden();
  for (const state of ["open", "closed"]) {
    await page.locator(state === "open" ? "#sidebar-toggle" : "#sidebar-hide").click();
    await page.reload();
    await expect(page.locator("#panel-body")).toContainText('print("kept")');
    await expect(page.locator("body")).toHaveAttribute("data-sidebar", state);
  }
});

test("folder add buttons do not stick after pointer toggles and remain usable from the keyboard", async ({ page }) => {
  const folder = "Folder actions";
  await fs.mkdir(path.join(root, folder));
  await fs.writeFile(path.join(root, folder, "Child.md"), "# Child\n");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const directory = page.locator(`details.directory[data-path="${folder}"]`);
  const summary = directory.locator(":scope > summary");
  const actions = summary.locator(".directory-actions");
  const add = summary.getByRole("button", { name: `Add in ${folder}`, exact: true });
  const opacity = () => actions.evaluate(node => getComputedStyle(node).opacity);
  await expect(directory).toHaveJSProperty("open", false);
  await summary.click();
  for (const open of [false, true]) {
    await summary.hover();
    await expect.poll(opacity).toBe("1");
    await summary.click();
    await expect.poll(() => directory.evaluate(node => node.open)).toBe(open);
    await page.mouse.move(1100, 100);
    await expect(summary).toBeFocused();
    await expect.poll(opacity).toBe("0");
    expect(await actions.evaluate(node => getComputedStyle(node).pointerEvents)).toBe("none");
    expect((await actions.boundingBox()).width).toBe(0);
  }
  await summary.click();
  await page.mouse.move(1100, 100);
  await page.keyboard.press("ArrowRight");
  await expect(summary).toBeFocused();
  await expect.poll(opacity).toBe("1");
  await page.keyboard.press("Tab");
  await expect(summary.locator(".tree-entry-icon")).toBeFocused();
  await expect.poll(opacity).toBe("1");
  await page.keyboard.press("Tab");
  await expect(add).toBeFocused();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: "File actions" });
  await expect(menu).toBeVisible();
  await expect(add).toHaveAttribute("aria-expanded", "true");
  await expect.poll(opacity).toBe("1");
  expect((await actions.boundingBox()).width).toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await expect(add).toBeFocused();
  await summary.click();
  await page.mouse.move(1100, 100);
  await expect.poll(opacity).toBe("0");
});

test("large tree interaction frame benchmark", async ({ page }) => {
  test.skip(!process.env.FOLIO_BENCH_TREE_INPUT, "Opt-in sidebar interaction timings.");
  await page.route("**/api/tree", async route => {
    const response = await route.fetch(), tree = await response.json();
    for (let d = 0; d < 100; d++) {
      const dir = `Bench-${String(d).padStart(3, "0")}`;
      tree.directories.push({ path: dir, name: dir });
      for (let f = 0; f < 20; f++) {
        const name = `Note-${d}-${String(f).padStart(2,"0")}.md`;
        tree.files.push({ path: `${dir}/${name}`, name });
      }
    }
    await route.fulfill({json: tree});
  });
  await page.reload();
  const group = page.locator('details[data-path="Bench-000"]');
  await expect(group.locator(".file-button")).toHaveCount(20);
  await group.scrollIntoViewIfNeeded();
  const times = await page.evaluate(async () => {
    const frames = {}, frame = () => new Promise(requestAnimationFrame);
    const measure = async (name, fn) => {
      await frame();
      const start = performance.now(); fn();
      (frames[name+"_handler"] ??= []).push(performance.now()-start);
      await frame(); (frames[name+"_frame"] ??= []).push(performance.now()-start);
    };
    const dir = document.querySelector('details[data-path="Bench-000"]'), summary = dir.firstElementChild;
    const [a,b] = dir.querySelectorAll(".file-button");
    for (let i = 0; i < 16; i++) {
      await measure("folder", () => summary.click());
      if (!dir.open) continue;
      a.focus();
      await measure("key", () => a.dispatchEvent(new KeyboardEvent("keydown", {key:"ArrowDown",bubbles:true,cancelable:true})));
      const transfer = new DataTransfer();
      const drag = (row,type,y) => row.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,clientY:y,dataTransfer:transfer}));
      const rect = b.getBoundingClientRect(), after = i % 4 < 2;
      drag(a,"dragstart",0);
      const y = after ? rect.bottom - 1 : rect.top + 1;
      drag(b,"dragover",y);
      await measure("drop",()=>drag(b,"drop",y));
      if ((a.closest("li").previousElementSibling === b.closest("li")) !== after) throw Error("Order not applied");
    }
    const nav = document.querySelector("#file-nav");
    nav.scrollTop = 0;
    for (let i=0;i<48;i++) await measure("scroll",()=>{nav.scrollTop += 180;});
    if (nav.scrollTop < 8000) throw Error("List did not scroll");
    return frames;
  });
  const resizer = page.locator("#sidebar-resizer"), rect = await resizer.boundingBox();
  const initialWidth = Number(await resizer.getAttribute("aria-valuenow"));
  const x = rect.x+rect.width/2, y = rect.y+120;
  await page.mouse.move(x,y);
  await page.evaluate(() => {
    window.resizeTimes = [];
    const collect = () => {
      const start = performance.now();
      requestAnimationFrame(() => setTimeout(() => window.resizeTimes.push(performance.now()-start),0));
    };
    document.querySelector("#sidebar-resizer").addEventListener("pointermove",collect,{capture:true});
  });
  await page.mouse.down();
  await page.mouse.move(x+100, y, {steps:24});
  await page.mouse.up();
  await expect(resizer).toHaveAttribute("aria-valuenow", String(initialWidth + 100));
  await page.waitForFunction(() => window.resizeTimes.length >= 24);
  times.resize = await page.evaluate(() => window.resizeTimes);
  console.log("TREE INPUT", process.env.FOLIO_BENCH_TREE_INPUT, JSON.stringify(summarizeTimings(times)));
});

test("arrow navigation crosses nested branches without entering collapsed folders", async ({ page }) => {
  const folder = "Key nav";
  await fs.mkdir(path.join(root, folder, "Inner"), {recursive:true});
  await fs.writeFile(path.join(root, folder, "Inner", "Inside.md"), "");
  await fs.writeFile(path.join(root, folder, "Outside.md"), "");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const row = suffix => page.locator(`[data-entry-path="${folder}${suffix}"]`);
  const inner = row("/Inner"), outside = row("/Outside.md");
  await row("").click();
  await inner.click();
  await inner.focus();
  for (const [key, next] of [
    ["ArrowLeft", inner], ["ArrowDown", outside], ["ArrowUp", inner], ["ArrowRight", inner],
    ["ArrowDown", row("/Inner/Inside.md")], ["ArrowDown", outside], ["ArrowUp", row("/Inner/Inside.md")],
    ["ArrowLeft", inner],
  ]) {
    await page.keyboard.press(key);
    await expect(next).toBeFocused();
  }
});

test("sidebar drag order mixes files and folders immediately and survives reload", async ({ page }) => {
  const folder = "Drag order";
  await fs.mkdir(path.join(root, folder, "Box"), { recursive: true });
  await Promise.all(["A.md", "B.md"].map(name => fs.writeFile(path.join(root, folder, name), "")));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const row = name => page.locator(`[data-entry-path="${folder}/${name}"]`);
  const siblings = () => page.locator(`details[data-path="${folder}"] > ul > li`)
    .evaluateAll(items => items.map(li => li.querySelector("[data-entry-path]").dataset.entryPath.split("/").pop()));
  const writes = [];
  page.on("request", req => { if (req.method() === "PATCH") writes.push(req.url()); });
  await expect.poll(siblings).toEqual(["Box", "A.md", "B.md"]);
  await page.locator(`[data-entry-path="${folder}"]`).click();

  await row("B.md").hover();
  await page.mouse.down();
  const edge = { position: { x: 24, y: 2 } };
  await row("Box").hover(edge);
  await row("Box").hover(edge);
  const indicator = row("Box").locator("xpath=ancestor::li[1]");
  await expect(indicator).toHaveAttribute("data-drop-target", "before");
  expect(await indicator.evaluate(li => getComputedStyle(li, "::after").height)).toBe("2px");
  await page.mouse.up();
  await expect.poll(siblings).toEqual(["B.md", "Box", "A.md"]);
  const bounds = await row("A.md").boundingBox();
  await row("Box").dragTo(row("A.md"), { targetPosition: { x: 24, y: bounds.height - 2 } });
  await expect.poll(siblings).toEqual(["B.md", "A.md", "Box"]);
  await page.reload();
  await expect.poll(siblings).toEqual(["B.md", "A.md", "Box"]);
  expect(writes).toEqual([]);
});

test("sidebar drag order moves into folders, beside nested files and back to root but rejects invalid drops", async ({ page }) => {
  const folder = "Drag moves";
  const box = `${folder}/Box`;
  const name = "Dragged note.md";
  await fs.mkdir(path.join(root, box), { recursive: true });
  await Promise.all([`${folder}/${name}`, `${box}/Z.md`, `${box}/Existing.md`, `${folder}/Existing.md`,
    ...Array.from({ length: 40 }, (_, index) => `${folder}/A drag filler ${index}.md`)]
    .map(filename => fs.writeFile(path.join(root, filename), "kept")));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const row = path => page.locator(`[data-entry-path="${path}"]`);
  const drag = async (source, target, position) => {
    await source.hover();
    await page.mouse.down();
    try {
      // Start the native drag before scrolling can replace the row under the down point.
      await source.hover({ position: { x: 12, y: 12 } });
      await expect(source).toHaveAttribute("data-dragging", "true");
      await target.hover({ position });
      await target.hover({ position });
    } finally {
      await page.mouse.up();
    }
  };
  await row(folder).click();
  await row(box).click();
  const writes = [];
  page.on("request", req => { if (req.method() === "PATCH") writes.push(req.postDataJSON().destination); });
  await drag(row(folder), row(box));
  await drag(row(`${folder}/Existing.md`), row(box));
  await drag(row(`${folder}/${name}`), row(box));
  await expect(row(`${box}/${name}`)).toBeVisible();
  await drag(row(`${box}/${name}`), page.locator(".library-heading"));
  await expect(row(name)).toBeVisible();
  await drag(row(name), row(`${box}/Z.md`), { x: 24, y: 2 });
  await expect(row(`${box}/${name}`)).toBeVisible();
  const names = () => page.locator(`details[data-path="${box}"] > ul > li > .file-button`)
    .evaluateAll(buttons => buttons.map(b => b.dataset.path.split("/").pop()));
  await expect.poll(names).toEqual(["Existing.md", name, "Z.md"]);
  await page.reload();
  await expect.poll(names).toEqual(["Existing.md", name, "Z.md"]);
  expect(writes).toEqual([`${box}/${name}`, name, `${box}/${name}`]);
  expect(await fs.readFile(path.join(root, box, name), "utf8")).toBe("kept");
});

test("a menu reopens cleanly after closing, however quickly it is clicked", async ({ page }) => {
  const trigger = page.locator("#more-menu > button");
  const panel = page.locator("#more-actions-panel");
  await trigger.click();
  await expect(panel).toBeVisible();
  await trigger.click();
  await expect(panel).toBeHidden();
  for (let round = 0; round < 3; round += 1) {
    await trigger.click();
    await expect(panel).toBeVisible();
    await expect(panel).not.toHaveAttribute("data-closed", "");
    await expect(panel).toHaveCSS("opacity", "1");
    await expect(panel).toHaveCSS("pointer-events", "auto");
    await trigger.click();
    await trigger.click();
    await expect(panel).toHaveCSS("opacity", "1");
    await trigger.click();
    await expect(panel).toBeHidden();
  }
});

test("one sidebar button creates notes and folders and every menu action has an icon", async ({ page }) => {
  await expect(page.locator("#refresh-files, #files-tab, #sidebar-workspace-open")).toHaveCount(0);
  const search = await page.locator(".sidebar-search").boundingBox();
  const create = await page.locator("#new-menu > button").boundingBox();
  expect(create.x).toBeGreaterThanOrEqual(search.x + search.width);
  expect(Math.abs(create.y + create.height / 2 - (search.y + search.height / 2))).toBeLessThan(2);
  await page.locator("#new-menu > button").click();
  await expect(page.locator("#new-note")).toBeVisible();
  await expect(page.locator("#new-folder")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator("#more-menu > button").click();
  const missing = await page.locator("#more-actions-panel").evaluate(panel =>
    [...panel.querySelectorAll("button, summary")]
      .filter(node => node.getClientRects().length && !node.matches("[data-page-width], [data-view], #collaboration-join") && !node.querySelector(":scope > svg.menu-icon"))
      .map(node => node.textContent.trim()));
  expect(missing).toEqual([]);
  await expect(page.locator("#compact-layout-menu")).toBeVisible();
  await expect(page.locator("#layout-menu")).toHaveCount(0);
  await expect(page.locator("#file-list .file-button[title]")).toHaveCount(0);
});

test("a chosen entry icon survives a reload and the command panel finds notes", async ({ page }) => {
  await openFixture(page, "Icon-target.md", "# Icon target\n");
  const row = page.locator('#file-list [data-path="Icon-target.md"]');
  await row.locator(".tree-entry-icon").click();
  await page.locator('#file-icon-choices [data-entry-icon="star"]').click();
  await expect(page.locator("#file-context-menu")).toBeHidden();
  await expect(row.locator('svg[data-icon="star"]')).toBeVisible();
  await page.reload();
  await expect(page.locator('#file-list [data-path="Icon-target.md"] svg[data-icon="star"]')).toBeVisible();
  await page.locator('#file-list [data-path="Icon-target.md"] .tree-entry-icon').click();
  await page.locator('#file-icon-choices [data-entry-icon=""]').click();
  await expect(page.locator('#file-list [data-path="Icon-target.md"] svg[data-icon="file"]')).toBeVisible();

  await page.locator(".ProseMirror").click();
  await page.keyboard.press(`${primaryModifier}+k`);
  await page.locator("#command-query").fill("icon-tar");
  await expect(page.locator("#command-list [role=option]")).toHaveText(/Icon-target/);
});

test("tree recycling restores a nested folder and deletes a non-active file without touching the open note", async ({ page }) => {
  const folder = "Recycling";
  const filename = `${folder}/nested/Draft.md`;
  await fs.mkdir(path.join(root, folder, "nested"), { recursive: true });
  await fs.writeFile(path.join(root, filename), "# Keep me\n");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const note = page.locator(`button[data-path="${filename}"]`);
  const summary = page.locator(`summary[data-entry-path="${folder}"]`);
  const revealNote = async () => {
    for (const entry of [folder, `${folder}/nested`]) {
      const directory = page.locator(`details.directory[data-path="${entry}"]`);
      if (!(await directory.evaluate(node => node.open))) await directory.locator(":scope > summary").click();
    }
  };
  const recycle = async row => {
    await row.click({ button: "right" });
    const menu = page.getByRole("menu", { name: "File actions" });
    await expect(menu).not.toContainText(path.basename(await row.getAttribute("data-entry-path")));
    await menu.getByRole("menuitem", { name: "Recycle", exact: true }).click();
    await confirmDialog(page);
    await expect(row).toHaveCount(0);
  };
  const restore = async name => {
    await openMoreAction(page, "trash-open");
    await page.getByRole("button", { name: `Restore ${name}`, exact: true }).click();
    await expect(page.getByRole("button", { name: `Restore ${name}`, exact: true })).toHaveCount(0);
    await page.locator("#trash-close").click();
  };
  await revealNote();
  await recycle(note);
  await expect(page.locator("#document-title")).toContainText("README");
  await restore(filename);
  await note.click();
  await expect(page.locator("#document-title")).toContainText("Draft");
  await recycle(summary);
  await expect(page.locator("#document-title")).toHaveText("Select a note");
  await expect(page.locator('#file-list [data-entry-path^="."]')).toHaveCount(0);
  await restore(folder);
  await revealNote();
  await expect(note).toBeVisible();
  expect(await fs.readFile(path.join(root, filename), "utf8")).toBe("# Keep me\n");
});

test("narrow sidebar keeps focus when creating files, and Escape keeps the default name", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#sidebar-toggle").click();
  const name = page.getByRole("textbox", { name: "File name" });
  const create = async () => {
    await page.locator("#new-menu > button").click();
    await page.locator("#new-note").click();
    await expect(name).toBeFocused();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
  };
  await create();
  const original = await name.inputValue();
  expect(original).toBe("Untitled");
  await name.fill("Cancelled");
  await name.press("Escape");
  await expect(page.locator("#sidebar")).toBeVisible();
  await expect(page.locator(`button[data-path="${original}.md"]`)).toBeVisible();
  expect(await fs.readFile(path.join(root, `${original}.md`), "utf8")).toBe("");
  await create();
  expect(await name.inputValue()).not.toBe(original);
  await name.fill("Saved on blur");
  await page.locator("#file-filter").click();
  await expect(page.locator('button[data-path="Saved on blur.md"]')).toBeVisible();
});

test("a new note accepts text before creation is acknowledged and keeps the caret on sync", async ({ page }) => {
  await chooseView(page, "editor");
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const paths = [];
  await page.route("**/api/document", async route => {
    if (route.request().method() === "POST") {
      paths.push(route.request().postDataJSON().path);
      await gate;
    }
    await route.continue();
  });
  try {
    await page.locator("#new-menu > button").click();
    await page.locator("#new-note").click();
    const name = page.getByRole("textbox", { name: "File name" });
    await expect(name).toBeFocused();
    await name.fill("Slow create");
    expect(paths).toEqual([]);
    await name.press("Enter");
    await page.getByRole("button", { name: "Slow create", exact: true }).click();
    const editor = page.locator("#editor");
    await expect(editor).toHaveValue("");
    await editor.fill("written while the server waits");
    await editor.press("Home");
    await editor.press("ArrowRight");
    release();
    await expect(page.locator('button[data-path="Slow create.md"]')).toBeVisible();
    await expect(editor).toBeFocused();
    expect(await editor.evaluate(node => node.selectionStart)).toBe(1);
    await expect.poll(() => fs.readFile(path.join(root, "Slow create.md"), "utf8")).toBe("written while the server waits");
    expect(paths).toEqual(["Slow create.md"]);
  } finally { release(); }
});

test("renaming a note does not revert edits typed before or during the move", async ({ page }) => {
  await openFixture(page, "Before rename.md", "Before\n");
  await chooseView(page, "editor");
  const editor = page.locator("#editor");
  await editor.fill("Local first");
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route("**/api/entry", async route => {
    if (route.request().method() === "PATCH") await gate;
    await route.continue();
  });
  try {
    const row = page.locator('button[data-path="Before rename.md"]');
    await row.click({ button: "right" });
    await page.locator("#file-rename").click();
    const input = page.getByRole("textbox", { name: "File name" });
    await input.fill("After rename");
    await input.press("Enter");
    await expect(row).toContainText("After rename");
    await editor.press("End");
    await editor.pressSequentially(", still typing.");
    release();
    await expect(page.locator('button[data-path="After rename.md"]')).toBeVisible();
    await expect(editor).toHaveValue("Local first, still typing.");
    await expect.poll(() => fs.readFile(path.join(root, "After rename.md"), "utf8")).toBe("Local first, still typing.");
  } finally { release(); }
});

test("Duplicate names a sibling copy in the tree without opening or overwriting either note", async ({ page }) => {
  const dir = "Templates", source = "bug 修复.markdown";
  const content = "---\ntitle: Bug template\n---\n\n![diagram](diagram.png)\n";
  await fs.mkdir(path.join(root, dir));
  await fs.writeFile(path.join(root, dir, source), content);
  await fs.writeFile(path.join(root, dir, "bug 修复 copy.markdown"), "Existing");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.locator(`details.directory[data-path="${dir}"] > summary`).click();
  const original = page.locator(`button[data-path="${dir}/${source}"]`);
  await original.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
  const name = page.locator("#file-list").getByRole("textbox", { name: "File name" });
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("bug 修复 copy 2");
  await name.press("Escape");
  await expect(original).toBeFocused();
  expect(await fs.readdir(path.join(root, dir))).not.toContain("bug 修复 copy 2.markdown");
  await original.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
  await name.press("Enter");
  const copy = "bug 修复 copy 2.markdown";
  await expect(page.locator(`button[data-path="${dir}/${copy}"]`)).toBeVisible();
  await expect(page.locator("#document-title")).toContainText("README");
  expect(await fs.readFile(path.join(root, dir, copy), "utf8")).toBe(content);
  expect(await fs.readFile(path.join(root, dir, "bug 修复 copy.markdown"), "utf8")).toBe("Existing");
  expect(await fs.readFile(path.join(root, dir, source), "utf8")).toBe(content);
});

test("a rejected inline rename retains the attempted name and can be retried", async ({ page }) => {
  const row = page.locator('[data-entry-path="Second.md"]');
  await row.click({ button: "right" });
  await page.locator("#file-rename").click();
  const input = page.locator("[data-rename-path]");
  await page.route("**/api/entry", route => route.fulfill({
    status: 409, json: { error: "A collaborator opened this note" },
  }), {times:1});
  await input.fill("Retried rename");
  await input.press("Enter");
  await expect(input).toHaveValue("Retried rename");
  await expect(page.locator(".tree-inline-rename [role=alert]")).toContainText("collaborator");
  await input.press("Enter");
  await expect(page.locator('[data-entry-path="Retried rename.md"]')).toBeVisible();
});

test("an offline new note keeps its text through reconnect and a creation conflict", async ({ page }) => {
  await chooseView(page, "editor");
  const posted = [];
  await page.route("**/api/document", async route => {
    if (route.request().method() === "POST") posted.push(route.request().postDataJSON().path);
    await route.continue();
  });
  await page.context().setOffline(true);
  try {
    await expect(page.locator("#connection-label")).toContainText("Disconnected");
    await page.locator("#new-menu > button").click();
    await page.locator("#new-note").click();
    const name = page.getByRole("textbox", { name: "File name" });
    await name.fill("Offline draft");
    await name.press("Enter");
    await page.getByRole("button", { name: "Offline draft", exact: true }).click();
    const editor = page.locator("#editor");
    await editor.fill("Typed while offline.");
    expect(posted).toEqual([]);
    await fs.writeFile(path.join(root, "Offline draft.md"), "Other writer", { flag: "wx" });
    await page.context().setOffline(false);
    await expect(page.getByText("Name already exists", { exact: true })).toBeVisible();
    await expect(editor).toHaveValue("Typed while offline.");
    await name.fill("Recovered draft");
    await name.press("Enter");
    await expect(page.locator('button[data-path="Recovered draft.md"]')).toBeVisible();
    await expect.poll(() => fs.readFile(path.join(root, "Recovered draft.md"), "utf8")).toBe("Typed while offline.");
    expect(await fs.readFile(path.join(root, "Offline draft.md"), "utf8")).toBe("Other writer");
    expect(posted).toEqual(["Offline draft.md", "Recovered draft.md"]);
  } finally { await page.context().setOffline(false); }
});
