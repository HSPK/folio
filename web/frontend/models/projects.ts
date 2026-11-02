export type ProjectSharing = "private" | "read" | "edit";
export type DocumentSharing = ProjectSharing | "inherit" | "publicRead" | "publicEdit";
export type ProjectSource = "new" | "folder";

export interface ProjectLink {
  readonly token: string;
  readonly access: ProjectSharing;
  readonly expiresAt?: number | null;
  readonly passwordRequired?: boolean;
}

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly owned: boolean;
  readonly root?: string;
  readonly imageDirectory: string;
  readonly shared: ProjectSharing;
  readonly owner?: string;
  readonly access?: ProjectSharing;
  readonly pages: Readonly<Record<string, ProjectSharing>>;
  readonly documentIds?: Readonly<Record<string, string>>;
  readonly publicLinks?: Readonly<Record<string, ProjectLink>>;
}

export interface ProjectPatch {
  readonly name?: string;
  readonly root?: string;
  readonly imageDirectory?: string;
  readonly shared?: ProjectSharing;
}

export type ProjectChange =
  | { readonly action: "create"; readonly name: string; readonly kind: ProjectSource; readonly source?: string }
  | ({ readonly action: "share"; readonly id: string } & ProjectPatch)
  | {
      readonly action: "document";
      readonly id: string;
      readonly document: string;
      readonly permission: DocumentSharing;
      readonly resetLink?: boolean;
      readonly publicOptions?: {
        readonly expiresAt: number | null;
        readonly password: string | null;
        readonly clearPassword: boolean;
      };
    }
  | { readonly action: "revokePublic"; readonly id: string; readonly document: string };

export function projectSharing(value: string): ProjectSharing {
  if (value !== "private" && value !== "read" && value !== "edit") throw new Error("Choose valid project permissions.");
  return value;
}
export function documentSharing(value: string): DocumentSharing {
  if (value === "inherit" || value === "publicRead" || value === "publicEdit") return value;
  return projectSharing(value);
}
export function projectSource(value: string): ProjectSource {
  if (value !== "new" && value !== "folder") throw new Error("Choose new or folder as the project source.");
  return value;
}
export function ownedProjectChange(value: ProjectChange): ProjectChange {
  return value.action === "document"
    ? Object.freeze({
        ...value,
        publicOptions: value.publicOptions ? Object.freeze({ ...value.publicOptions }) : undefined,
      })
    : Object.freeze({ ...value });
}
