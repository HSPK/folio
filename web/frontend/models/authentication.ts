export type AuthenticationMode = "users" | "launchToken" | "public" | null;

export interface UserIdentity {
  readonly username: string;
  readonly role: "admin" | "user";
  readonly id?: string;
  readonly scope?: string;
  readonly draftKey?: string;
}

export interface AccountScope {
  readonly key: symbol;
  readonly principal: string | null;
  readonly generation: number;
  readonly signal: AbortSignal;
}

export function accountIdentity(user: UserIdentity | null): string | null {
  return user ? JSON.stringify([user.scope ?? "", user.id ?? user.username]) : null;
}
