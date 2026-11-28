// One page load only. The shell and each early read independently check the session cookie.
if (!Object.hasOwn(window, "folioStart")) {
  const reader = document.currentScript.dataset.reader;
  const reads = new Map();
  const started = new Set();
  const startup = window.folioStart = { reader, reads, started, at: performance.now() };
  const read = (path, account, project = "", method = "GET") => {
    const key = JSON.stringify([method, project, path]);
    if (started.has(key) || window.folioStart !== startup) return;
    started.add(key);
    const result = fetch(path, {
      method, credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { Accept: "application/json", ...(account && { "X-Folio-Start-Reader": account }),
        ...(project && { "X-Folio-Project": project }) },
    });
    result.catch(() => {});
    reads.set(key, result);
    return result;
  };
  read("/api/auth/status");
  if (reader) {
    const json = promise => promise.then(response => response.ok ? response.clone().json() : null).catch(() => null);
    const note = /^\/n\/([A-Za-z0-9_-]{8})$/.exec(location.pathname);
    const resource = note && json(read("/api/resource?id=" + note[1], reader));
    const prefs = json(read("/api/preferences", reader));
    const home = location.pathname === "/" && !location.search;
    const workspaceRead = read("/api/workspace", reader);
    read("/api/projects", reader);
    const valid = value => typeof value?.project === "string" && /^(?:default|[a-f0-9]{32})$/.test(value.project) &&
      typeof value.id === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.id);
    function prepare(target, source) {
      if (!valid(target)) return;
      read("/api/session", reader, target.project, "POST");
      read("/api/tree", reader, target.project);
      if (typeof target.path === "string" && !/\.(md|markdown)$/i.test(target.path)) return;
      const body = isSource => read("/api/document?id=" + target.id + (isSource ? "&render=source" : ""), reader, target.project);
      if (typeof source === "boolean") body(source);
      else prefs.then(value => {
        if (value?.web) body(["live", "source"].includes(value.web.defaultView));
      });
    }
    // Identifiers are only hints. Never advance the route, show a row or reuse a body on their authority.
    let hint, project;
    try { hint = JSON.parse(sessionStorage.getItem("folio.start.note")); } catch { /* Optional hint. */ }
    if (home) try { project = localStorage.getItem("folio.projects." + reader); } catch { /* Optional hint. */ }
    if (hint?.reader === reader && valid(hint) && !location.search &&
        ((home && (!project || project === hint.project)) || (note && hint.page === location.pathname)))
      prepare(hint, hint.source);
    else if (resource) resource.then(target => { if (target?.kind === "document") prepare(target); });
    else if (home) json(workspaceRead).then(value => prepare(value?.workspace?.recent?.find(n => !project || n.project === project)));
  }
}
