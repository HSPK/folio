import { projectViewState as projectState } from "./view-state";
import { projectModel } from "../../state/projects";
import { createIcon } from "@folio/editor-runtime";
import type { Project } from "../../types/domain";
import { requireValue } from "../../types/elements";
import { setSidebar } from "../accounts/authentication";
import { appState } from "../core/bootstrap";
import { notice, setText } from "../core/dom";
import { confirmAction, hasDialogConfirmation, settleDialogConfirmation, showDialog } from "../dialogs/dialogs";
import { listen, onApplicationDispose } from "../lifecycle";
interface ProjectDialogActions {
  openSharing: (project: Project, path?: string | null, resource?: string | null) => Promise<void>;
  switchProject: (id: string | null) => Promise<boolean>;
}
let actions: ProjectDialogActions | null = null;

class ProjectDialogState {
  projectDialog!: HTMLDialogElement;
  projectViews!: HTMLElement[];
  projectView!: string;
  projectParent!: Project | null;
  projectSessionOrigin!: string;
  projectFormSnapshot!: string | null;
  sharingSaving!: boolean;
  projectAnchor!: { left: number; right: number; top: number; bottom: number; alignRight: boolean } | null;
  positionObserver!: ResizeObserver;
}
export const projectDialogState = new ProjectDialogState();
export function initializeProjectsDialog(ports: ProjectDialogActions): void {
  actions = ports;
  onApplicationDispose(() => {
    if (actions === ports) actions = null;
  });
  projectDialogState.projectDialog = appState.element("projects-dialog");
  projectDialogState.projectViews = [
    ...projectDialogState.projectDialog.querySelectorAll<HTMLElement>("[data-project-view]"),
  ];
  projectDialogState.projectView = "browse";
  projectDialogState.projectParent = null;
  projectDialogState.projectSessionOrigin = "browse";
  projectDialogState.projectFormSnapshot = null;
  projectDialogState.sharingSaving = false;
  projectDialogState.projectAnchor = null;
  listen(appState.element("projects-filter"), "input", renderProjects);
  listen(appState.element("projects-filter"), "keydown", (event) => {
    if (!(event.target instanceof Element)) return;

    if (event.key === "Escape" && appState.element("projects-filter").value) {
      event.preventDefault();
      event.stopPropagation();
      appState.element("projects-filter").value = "";
      renderProjects();
    } else if (event.key === "ArrowDown" || event.key === "Enter") {
      const first = appState.element("projects-list").querySelector<HTMLButtonElement>(".project-open");
      if (!first) return;
      event.preventDefault();
      if (event.key === "Enter") first.click();
      else first.focus();
    }
  });
  listen(appState.element("project-new"), "click", () => void openProjectCreation());
  listen(appState.element("project-back"), "click", () => void backProjectView());
  listen(appState.element("project-create-cancel"), "click", () => void backProjectView({ discard: true }));
  listen(appState.element("project-confirm-cancel"), "click", () =>
    settleDialogConfirmation(projectDialogState.projectDialog, false),
  );
  listen(appState.element("project-confirm-proceed"), "click", () =>
    settleDialogConfirmation(projectDialogState.projectDialog, true),
  );
  listen(projectDialogState.projectDialog, "confirmationchange", refreshProjectBusy);
  listen(appState.element("project-kind"), "change", syncProjectSource);
  listen(appState.element("projects-close"), "click", () => {
    if (!projectState.projectCreating && !projectDialogState.sharingSaving) closeProjectManager();
  });
  listen(projectDialogState.projectDialog, "cancel", (event) => {
    if (projectState.projectCreating || projectDialogState.sharingSaving || projectDialogState.projectView !== "browse")
      event.preventDefault();
    if (
      !projectState.projectCreating &&
      !projectDialogState.sharingSaving &&
      projectDialogState.projectView !== "browse"
    )
      void backProjectView();
  });
  listen(projectDialogState.projectDialog, "close", () => {
    settleDialogConfirmation(projectDialogState.projectDialog, false);
    showProjectBrowse();
  });
  listen(projectDialogState.projectDialog, "click", async (event) => {
    if (!(event.target instanceof Element)) return;

    if (event.target !== projectDialogState.projectDialog) return;
    const bounds = projectDialogState.projectDialog.getBoundingClientRect();
    if (
      event.clientX >= bounds.left &&
      event.clientX <= bounds.right &&
      event.clientY >= bounds.top &&
      event.clientY <= bounds.bottom
    )
      return;
    event.preventDefault();
    if (await allowProjectNavigation()) closeProjectManager();
  });
  projectDialogState.positionObserver = new ResizeObserver(positionProjectDialog);
  const positionObserver = projectDialogState.positionObserver;
  onApplicationDispose(() => positionObserver.disconnect());
  projectDialogState.positionObserver.observe(projectDialogState.projectDialog);
  listen(window, "resize", positionProjectDialog);
}
export function positionProjectDialog(): void {
  if (!projectManagerOpen() || !projectDialogState.projectAnchor) return;
  const bounds = projectDialogState.projectDialog.getBoundingClientRect();
  const desiredLeft = projectDialogState.projectAnchor.alignRight
    ? projectDialogState.projectAnchor.right - bounds.width
    : projectDialogState.projectAnchor.left;
  const left = Math.max(12, Math.min(desiredLeft, innerWidth - bounds.width - 12));
  const desiredTop =
    projectDialogState.projectAnchor.bottom + bounds.height + 20 <= innerHeight
      ? projectDialogState.projectAnchor.bottom + 8
      : projectDialogState.projectAnchor.top - bounds.height - 8;
  const top = Math.max(12, Math.min(desiredTop, innerHeight - bounds.height - 12));
  projectDialogState.projectDialog.style.left = `${Math.round(left)}px`;
  projectDialogState.projectDialog.style.top = `${Math.round(top)}px`;
}

export function projectManagerOpen() {
  return projectDialogState.projectDialog.open;
}

export function openProjectManager(): void {
  if (projectManagerOpen()) return;
  const alignRight = projectDialogState.projectView === "sharing" && Boolean(projectState.sharingTarget?.path);
  const trigger = alignRight
    ? document.querySelector<HTMLElement>("#more-menu > summary")
    : appState.element("projects-open");
  const bounds = requireValue(trigger).getBoundingClientRect();
  projectDialogState.projectAnchor = bounds.width
    ? {
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
        alignRight,
      }
    : { left: 12, right: innerWidth - 12, top: 12, bottom: 44, alignRight };
  appState.inlineEditor.dismissMenus();
  if (appState.compactLayout.matches) setSidebar(false);
  showDialog(projectDialogState.projectDialog);
  positionProjectDialog();
}

export function closeProjectManager(): void {
  if (projectManagerOpen()) projectDialogState.projectDialog.close();
}

export function projectFormState() {
  const form =
    projectDialogState.projectView === "create"
      ? appState.element("project-create-form")
      : projectDialogState.projectView === "sharing"
        ? appState.element("sharing-form")
        : null;
  return form
    ? JSON.stringify(
        [...form.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select")]
          .filter((control) => !(control instanceof HTMLInputElement) || !control.readOnly)
          .map((control) => [control.id, control.type === "checkbox" ? control.checked : control.value]),
      )
    : null;
}

export function clearSharingCredentials(): void {
  appState.element("sharing-password").value = "";
}

export function refreshProjectBusy(): void {
  const busy = projectState.projectCreating || projectDialogState.sharingSaving;
  projectDialogState.projectDialog.setAttribute("aria-busy", String(busy));
  const blocked = busy || hasDialogConfirmation(projectDialogState.projectDialog);
  appState.element("projects-close").disabled = busy;
  appState.element("project-back").disabled = blocked;
  appState.element("project-new").disabled = blocked;
  for (const view of projectDialogState.projectViews) view.inert = blocked;
}

export function setProjectView(view: string): void {
  if (!["browse", "create", "sharing"].includes(view)) throw new Error(`Unknown project view: ${view}`);
  projectDialogState.projectView = view;
  projectDialogState.projectDialog.dataset.view = view;
  for (const node of projectDialogState.projectViews) node.hidden = node.dataset.projectView !== view;
  appState.element("project-back").hidden = view === "browse";
  appState
    .element("project-back")
    .setAttribute("aria-label", projectDialogState.projectParent ? "Back to project settings" : "Back to projects");
  appState.element("project-new").hidden = view !== "browse";
  setText(
    appState.element("projects-title"),
    view === "browse"
      ? "Projects"
      : view === "create"
        ? "New project"
        : projectState.sharingTarget?.path
          ? "Document permissions"
          : "Project settings",
  );
  notice(appState.element("project-error"), "");
  refreshProjectBusy();
}

export function showProjectBrowse(): void {
  clearSharingCredentials();
  projectDialogState.projectFormSnapshot = null;
  projectDialogState.projectParent = null;
  projectDialogState.projectSessionOrigin = "browse";
  setProjectView("browse");
  renderProjects();
  if (projectManagerOpen()) appState.element("projects-filter").focus();
}

export function confirmProjectAction(message: string, label = "Continue", signal?: AbortSignal) {
  if (!projectManagerOpen()) {
    showProjectBrowse();
    openProjectManager();
  }
  return confirmAction(message, { label, dialog: projectDialogState.projectDialog, signal });
}

export async function allowProjectNavigation(signal?: AbortSignal) {
  if (signal?.aborted) return false;
  if (projectState.projectCreating || projectDialogState.sharingSaving) return false;
  return (
    projectDialogState.projectFormSnapshot === null ||
    projectDialogState.projectFormSnapshot === projectFormState() ||
    (await confirmProjectAction("Discard the unsaved changes in this form?", "Discard changes", signal))
  );
}

export async function backProjectView({ discard = false }: { discard?: boolean } = {}): Promise<void> {
  if (
    projectState.projectCreating ||
    projectDialogState.sharingSaving ||
    (!discard && !(await allowProjectNavigation()))
  )
    return;
  if (
    projectDialogState.projectView === "sharing" &&
    projectState.sharingTarget?.path &&
    projectDialogState.projectParent
  ) {
    const parent =
      projectModel.items.find((project) => project.id === requireValue(projectDialogState.projectParent).id) ??
      projectDialogState.projectParent;
    projectDialogState.projectParent = null;
    projectDialogState.projectFormSnapshot = null;
    await requireValue(actions, "Project dialog actions").openSharing(parent);
  } else showProjectBrowse();
}

export function syncProjectSource(): void {
  const kind = appState.element("project-kind").value;
  appState.element("project-source-field").hidden = kind === "new";
  appState.element("project-source").required = kind !== "new";
}

export async function openProjectCreation(): Promise<void> {
  if (!(await allowProjectNavigation())) return;
  appState.element("project-create-form").reset();
  syncProjectSource();
  setProjectView("create");
  projectDialogState.projectFormSnapshot = projectFormState();
  appState.element("project-name").focus();
}

export function renderProjects(): void {
  const query = appState.element("projects-filter").value.trim().toLowerCase();
  const visible = projectModel.items.filter((project) =>
    `${project.name} ${project.owner ?? ""}`.toLowerCase().includes(query),
  );
  const rows = visible.map((project) => {
    const row = document.createElement("div");
    row.className = "project-row";
    row.setAttribute("role", "listitem");
    const open = document.createElement("button");
    open.type = "button";
    open.className = "project-open";
    open.dataset.project = project.id;
    open.setAttribute("aria-current", String(project.id === projectModel.active?.id));
    const symbol = document.createElement("span");
    symbol.className = "project-symbol";
    symbol.append(createIcon("folder"));
    const text = document.createElement("span");
    text.className = "project-label";
    const name = document.createElement("strong");
    name.textContent = project.name;
    const detail = document.createElement("small");
    detail.textContent = project.owned ? "Owned by you" : project.owner ? `By ${project.owner}` : "Shared project";
    detail.hidden = project.owned;
    text.append(name, detail);
    const access = project.owned ? project.shared : project.access;
    const badge = document.createElement("span");
    badge.className = "project-access";
    badge.append(
      document.createTextNode(
        access === "private"
          ? project.owned
            ? "Private"
            : "Shared pages"
          : project.owned
            ? access === "edit"
              ? "Shared · edit"
              : "Shared · read"
            : access === "edit"
              ? "Can edit"
              : "Read only",
      ),
    );
    open.append(symbol, text, badge);
    if (project.id === projectModel.active?.id) {
      const current = createIcon("check");
      current.classList.add("project-current");
      open.append(current);
    }
    open.addEventListener(
      "click",
      () => void requireValue(actions, "Project dialog actions").switchProject(project.id),
    );
    row.append(open);
    if (project.owned) {
      const manage = document.createElement("button");
      manage.type = "button";
      manage.className = "project-manage";
      manage.setAttribute("aria-label", `Manage ${project.name}`);
      manage.title = `Manage ${project.name}`;
      manage.append(createIcon("settings"));
      manage.addEventListener("click", () => void requireValue(actions, "Project dialog actions").openSharing(project));
      row.append(manage);
    }
    return row;
  });
  appState.element("projects-list").replaceChildren(...rows);
  appState.element("projects-empty").hidden = visible.length > 0;
  setText(appState.element("projects-empty"), query ? "No matching projects" : "No projects");
}
