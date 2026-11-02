import { isRecord } from "../types/guards";
import { ApiError } from "./error";
import { isResourceId } from "@folio/model";
import { isDocumentPayload, isFileEntry, isWorkspaceNote } from "../types/guards";
import { normalizeNotePath } from "@folio/model";
import type {
  Project,
  UserIdentity,
  AccountsListing,
  HistoryRevision,
  TrashEntry,
  ResourceEntry,
} from "../types/domain";
import { prepareSearchResults } from "../models/search";
import type { WorkspaceSnapshot } from "../models/workspace-lists";
import type { ProjectSharing } from "../models/projects";

export function decodedObject(value: unknown, label: string) {
  if (!isRecord(value)) throw new ApiError(`The service returned invalid ${label}.`);
  return value;
}

export function decodedString(value: unknown, label: string) {
  if (typeof value !== "string") throw new ApiError(`The service returned an invalid ${label}.`);
  return value;
}

export function decodedBoolean(value: unknown, label: string) {
  if (typeof value !== "boolean") throw new ApiError(`The service returned an invalid ${label}.`);
  return value;
}

export function decodedNumber(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new ApiError(`The service returned an invalid ${label}.`);
  return value;
}

export function decodedArray<T>(value: unknown, decode: (entry: unknown) => T, label: string): T[] {
  if (!Array.isArray(value)) throw new ApiError(`The service returned invalid ${label}.`);
  return value.map(decode);
}

export function validatedDocumentPermissions(value: unknown) {
  const permissions = decodedObject(value, "document permissions");
  const writable = decodedBoolean(permissions.writable, "document write permission");
  const collaborative = decodedBoolean(permissions.collaborative, "document collaboration permission");
  const owner = decodedBoolean(permissions.owner, "document ownership permission");
  if (collaborative && !writable) throw new ApiError("The service returned inconsistent document permissions.");
  return { writable, collaborative, owner };
}

function optionalString(value: unknown, label: string) {
  return value == null ? undefined : decodedString(value, label);
}

function nullableNumber(value: unknown, label: string) {
  return value == null ? null : decodedNumber(value, label);
}

function stringRecord(value: unknown, label: string) {
  const entries: [string, string][] = Object.entries(decodedObject(value, label)).map(([key, entry]) => [
    key,
    decodedString(entry, label),
  ]);
  return Object.fromEntries(entries);
}

function resourceId(value: unknown) {
  if (!isResourceId(value)) throw new ApiError("The service returned an invalid resource identity.");
  return value;
}

function role(value: unknown): "admin" | "user" {
  if (value !== "admin" && value !== "user") throw new ApiError("The service returned an invalid account role.");
  return value;
}

function sharing(value: unknown) {
  if (value !== "private" && value !== "read" && value !== "edit")
    throw new ApiError("The service returned invalid sharing permissions.");
  return value;
}

function sharingRecord(value: unknown) {
  const entries: [string, ProjectSharing][] = Object.entries(decodedObject(value, "page permissions")).map(
    ([path, value]) => [path, sharing(value)],
  );
  return Object.fromEntries(entries);
}

export function decodedUser(value: unknown): UserIdentity {
  const user = decodedObject(value, "account identity");
  return {
    username: decodedString(user.username, "username"),
    role: role(user.role),
    id: optionalString(user.id, "account ID"),
    scope: optionalString(user.scope, "account scope"),
    draftKey: optionalString(user.draftKey, "recovery key"),
  };
}

export function decodedAuthStatus(value: unknown): {
  mode: "users" | "launchToken";
  authenticated: boolean;
  setupRequired: boolean;
  user: UserIdentity | null;
} {
  const status = decodedObject(value, "authentication status");
  const mode = status.mode;
  if (mode !== "users" && mode !== "launchToken")
    throw new ApiError("The service returned an invalid authentication mode.");
  const authenticated = decodedBoolean(status.authenticated, "authentication status");
  return {
    mode,
    authenticated,
    setupRequired: decodedBoolean(status.setupRequired, "account setup status"),
    user: mode === "users" && authenticated ? decodedUser(status) : null,
  };
}

export function decodedAuthentication(value: unknown) {
  return { user: decodedUser(decodedObject(value, "authentication response").user) };
}

export function decodedWorkspace(value: unknown): WorkspaceSnapshot {
  const result = decodedObject(value, "saved workspace response");
  const revision = decodedNumber(result.revision, "workspace revision");
  if (!Number.isSafeInteger(revision) || revision < 0)
    throw new ApiError("The service returned an invalid workspace revision.");
  const workspace = decodedObject(result.workspace, "saved workspace");
  const note = (value: unknown) => {
    if (!isWorkspaceNote(value)) throw new ApiError("The saved workspace response is incomplete.");
    return { ...value };
  };
  return {
    revision,
    workspace: {
      favorites: decodedArray(workspace.favorites, note, "workspace favorites"),
      recent: decodedArray(workspace.recent, note, "workspace recents"),
    },
  };
}

export function decodedAccounts(value: unknown): AccountsListing {
  const accounts = decodedObject(value, "account listing");
  return {
    users: decodedArray(
      accounts.users,
      (user) => {
        const row = decodedObject(user, "account");
        return { username: decodedString(row.username, "username"), role: role(row.role) };
      },
      "accounts",
    ),
    invitations: decodedArray(
      accounts.invitations,
      (invitation) => {
        const row = decodedObject(invitation, "invitation");
        return {
          id: decodedString(row.id, "invitation ID"),
          usedBy: optionalString(row.usedBy, "invitation user"),
          expired: decodedBoolean(row.expired, "invitation expiration"),
          expiresAt: decodedNumber(row.expiresAt, "invitation expiration time"),
        };
      },
      "invitations",
    ),
  };
}

export function decodedAccountAction(value: unknown) {
  const result = decodedObject(value, "account update");
  return {
    accounts: result.accounts === null ? null : decodedAccounts(result.accounts),
    code: optionalString(result.code, "invitation code"),
  };
}

export function decodedProject(value: unknown): Project {
  const project = decodedObject(value, "project");
  let publicLinks: Project["publicLinks"];
  if (project.publicLinks !== undefined) {
    const entries: [string, NonNullable<Project["publicLinks"]>[string]][] = Object.entries(
      decodedObject(project.publicLinks, "public links"),
    ).map(([path, value]) => {
      const link = decodedObject(value, "public link");
      return [
        path,
        {
          token: decodedString(link.token, "public link token"),
          access: sharing(link.access),
          expiresAt: nullableNumber(link.expiresAt, "public link expiration"),
          passwordRequired: decodedBoolean(link.passwordRequired, "public link password status"),
        },
      ];
    });
    publicLinks = Object.fromEntries(entries);
  }
  return {
    id: decodedString(project.id, "project ID"),
    name: decodedString(project.name, "project name"),
    owned: decodedBoolean(project.owned, "project ownership"),
    root: optionalString(project.root, "project root"),
    owner: optionalString(project.owner, "project owner"),
    shared: sharing(project.shared),
    access: sharing(project.access),
    pages: sharingRecord(project.pages),
    imageDirectory: decodedString(project.imageDirectory, "image directory"),
    documentIds:
      project.documentIds === undefined ? undefined : stringRecord(project.documentIds, "document identities"),
    publicLinks,
  };
}

export const decodedProjects = (value: unknown) => decodedArray(value, decodedProject, "projects");

export function decodedSession(value: unknown) {
  const session = decodedObject(value, "session");
  const port = decodedNumber(session.port, "service port");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new ApiError("The service returned an invalid service port.");
  return {
    root: decodedString(session.root, "session root"),
    port,
    project: session.project == null ? null : decodedProject(session.project),
  };
}

export function decodedPublicSession(value: unknown) {
  const session = decodedObject(value, "public session");
  if (session.passwordRequired !== undefined && typeof session.passwordRequired !== "boolean") {
    throw new ApiError("The service returned an invalid public password status.");
  }
  if (session.passwordRequired === true) return { passwordRequired: true as const };
  return {
    passwordRequired: false as const,
    id: resourceId(session.id),
    path: decodedString(session.path, "public document path"),
    writable: decodedBoolean(session.writable, "public write permission"),
    project: optionalString(session.project, "public project ID"),
  };
}

export function decodedResource(value: unknown): ResourceEntry {
  const resource = decodedObject(value, "resource");
  const kind = resource.kind === "file" ? "document" : resource.kind;
  if (kind !== "document" && kind !== "directory" && kind !== "asset")
    throw new ApiError("The service returned an invalid resource kind.");
  return {
    id: resourceId(resource.id),
    path: decodedString(resource.path, "resource path"),
    project: decodedString(resource.project, "resource project"),
    kind,
  };
}

export function decodedDocument(value: unknown) {
  if (!isDocumentPayload(value)) throw new ApiError("The service returned an incomplete document.");
  if (value.permissions !== undefined) validatedDocumentPermissions(value.permissions);
  return value;
}

export function decodedPreview(value: unknown) {
  return { html: decodedString(decodedObject(value, "preview").html, "preview HTML") };
}

export function decodedImage(value: unknown) {
  const image = decodedObject(value, "image upload");
  return {
    path: decodedString(image.path, "image path"),
    document: resourceId(image.document),
    documentPath: decodedString(image.documentPath, "image document path"),
    warning: optionalString(image.warning, "image warning"),
  };
}

export function decodedDirectory(value: unknown) {
  return { path: decodedString(decodedObject(value, "directory").path, "directory path") };
}

export function decodedTree(value: unknown) {
  const tree = decodedObject(value, "library tree");
  const entries = (value: unknown) => {
    const seen = new Set<string>();
    return decodedArray(
      value,
      (value) => {
        if (!isFileEntry(value)) throw new ApiError("The service returned an invalid library entry.");
        const path = normalizeNotePath(value.path);
        if (seen.has(path)) throw new ApiError("The service returned duplicate library paths.");
        seen.add(path);
        return { id: value.id, path, name: value.name, title: value.title ?? null };
      },
      "library entries",
    );
  };
  return {
    root: decodedString(tree.root, "library root"),
    files: entries(tree.files),
    directories: entries(tree.directories),
    truncated: decodedBoolean(tree.truncated, "library scan limit"),
  };
}

export function decodedEntry(value: unknown) {
  const entry = decodedObject(value, "entry details");
  return {
    path: decodedString(entry.path, "entry path"),
    name: decodedString(entry.name, "entry name"),
    title: optionalString(entry.title, "entry title"),
    size: decodedNumber(entry.size, "entry size"),
    modifiedUnixMs: nullableNumber(entry.modifiedUnixMs, "entry modification time"),
  };
}

export function decodedMove(value: unknown) {
  const entry = decodedObject(value, "move result");
  const kind = entry.kind;
  if (kind !== "file" && kind !== "directory") throw new ApiError("The service returned an invalid moved entry kind.");
  return {
    id: resourceId(entry.id),
    path: decodedString(entry.path, "moved entry path"),
    kind,
    document: entry.document === undefined ? undefined : decodedDocument(entry.document),
    warning: optionalString(entry.warning, "move warning"),
  };
}

export function decodedJoined(value: unknown) {
  const joined = decodedObject(value, "collaboration session");
  return {
    ticket: decodedString(joined.ticket, "collaboration ticket"),
    roomId: decodedString(joined.roomId, "collaboration room"),
  };
}

export function decodedParticipation(value: unknown) {
  const status = decodedObject(value, "document participation");
  const phase = status.phase;
  if (phase !== "solo" && phase !== "prepare" && phase !== "join")
    throw new ApiError("The service returned an invalid participation phase.");
  const participant = status.participant === null ? null : decodedString(status.participant, "document participant");
  if (participant !== null && !/^[a-f0-9]{48}$/.test(participant))
    throw new ApiError("The service returned an invalid document participant.");
  return { phase, participant, permissions: validatedDocumentPermissions(status.permissions) };
}

export function decodedAppearance(value: unknown) {
  const appearance = decodedObject(value, "appearance settings");
  const theme = appearance.theme;
  if (theme !== "system" && theme !== "light" && theme !== "dark")
    throw new ApiError("The service returned an invalid appearance theme.");
  return {
    theme,
    latinFont: decodedString(appearance.latinFont, "Latin font"),
    cjkFont: decodedString(appearance.cjkFont, "CJK font"),
  };
}

function decodedRevision(value: unknown): HistoryRevision {
  const revision = decodedObject(value, "document revision");
  return {
    id: decodedNumber(revision.id, "revision ID"),
    version: decodedString(revision.version, "revision version"),
    created: decodedNumber(revision.created, "revision time"),
    actor: optionalString(revision.actor, "revision author"),
    kind: decodedString(revision.kind, "revision kind"),
    size: decodedNumber(revision.size, "revision size"),
  };
}

export function decodedHistory(value: unknown) {
  const history = decodedObject(value, "document history");
  return {
    currentVersion: optionalString(history.currentVersion, "current revision"),
    revisions: decodedArray(history.revisions, decodedRevision, "document revisions"),
  };
}

export function decodedRevisionContent(value: unknown) {
  const version = decodedObject(value, "revision content");
  return { content: decodedString(version.content, "revision content"), revision: decodedRevision(version.revision) };
}

export function decodedTrash(value: unknown): TrashEntry[] {
  return decodedArray(
    value,
    (value) => {
      const entry = decodedObject(value, "recycle-bin entry");
      return {
        id: decodedNumber(entry.id, "recycled entry ID"),
        path: decodedString(entry.path, "recycled path"),
        size: decodedNumber(entry.size, "recycled size"),
        deleted: decodedNumber(entry.deleted, "recycled time"),
      };
    },
    "recycle-bin entries",
  );
}

export function decodedAttachments(value: unknown) {
  const result = decodedObject(value, "attachments");
  return {
    truncated: decodedBoolean(result.truncated, "attachment scan status"),
    files: decodedArray(
      result.files,
      (value) => {
        const entry = decodedObject(value, "attachment");
        return {
          id: resourceId(entry.id),
          path: decodedString(entry.path, "attachment path"),
          size: decodedNumber(entry.size, "attachment size"),
          stamp: decodedString(entry.stamp, "attachment version"),
          referenced: decodedBoolean(entry.referenced, "attachment reference status"),
        };
      },
      "attachments",
    ),
  };
}

export function decodedBacklinks(value: unknown) {
  return decodedArray(
    value,
    (value) => {
      const link = decodedObject(value, "backlink");
      return {
        id: resourceId(link.id),
        path: decodedString(link.path, "backlink path"),
        title: optionalString(link.title, "backlink title"),
      };
    },
    "backlinks",
  );
}

export function decodedSearch(value: unknown) {
  const result = decodedObject(value, "search results");
  if (!Array.isArray(result.results)) throw new ApiError("The service returned invalid search results.");
  const results = prepareSearchResults(result.results);
  return {
    results,
    tags: decodedArray(
      result.tags,
      (value) => {
        const tag = decodedObject(value, "search facet");
        return { tag: decodedString(tag.tag, "search tag"), count: decodedNumber(tag.count, "search tag count") };
      },
      "search tags",
    ),
    projects: decodedArray(
      result.projects,
      (value) => {
        const project = decodedObject(value, "search project");
        return {
          id: decodedString(project.id, "search project ID"),
          name: decodedString(project.name, "search project name"),
        };
      },
      "search projects",
    ),
    warnings: decodedArray(result.warnings, (value) => decodedString(value, "search warning"), "search warnings"),
    cursor: decodedNumber(result.cursor, "search cursor"),
    indexing: decodedBoolean(result.indexing, "search indexing status"),
    truncated: decodedBoolean(result.truncated, "search result limit"),
  };
}

export function decodedShares(value: unknown) {
  return decodedArray(
    value,
    (value) => {
      const link = decodedObject(value, "shared link");
      return {
        project: decodedString(link.project, "shared project ID"),
        projectName: decodedString(link.projectName, "shared project name"),
        path: decodedString(link.path, "shared document path"),
        document: resourceId(link.document),
        token: decodedString(link.token, "shared link token"),
        access: sharing(link.access),
        passwordRequired: decodedBoolean(link.passwordRequired, "shared password status"),
        expiresAt: nullableNumber(link.expiresAt, "shared link expiration"),
      };
    },
    "shared links",
  );
}
