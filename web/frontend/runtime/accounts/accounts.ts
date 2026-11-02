import { authenticationSession } from "../../state/authentication";
import { decodedAccountAction, decodedAccounts } from "../../api/contracts";
import type { AccountsListing, Action } from "../../types/domain";
import { errorContext } from "../../types/errors";
import { api } from "../core/api";
import { appState } from "../core/bootstrap";
import { ApiError, notice, setText } from "../core/dom";
import { confirmAction, showDialog } from "../dialogs/dialogs";
import { confirmDiscard } from "../documents/navigation";
import { listen } from "../lifecycle";
import { showAuthentication } from "./authentication";
class AccountState {
  accountBusy!: boolean;
  passwordTarget!: string | null;
  accountsUi!: ReturnType<typeof createAccountsUi>;
}
export const accountState = new AccountState();
export function initializeAccountsAccounts(): void {
  accountState.accountBusy = false;
  accountState.passwordTarget = null;
  accountState.accountsUi = createAccountsUi();
  listen(
    accountState.accountsUi.create,
    "click",
    () => void accountAction({ action: "invite", hours: Number(accountState.accountsUi.lifetime.value) }),
  );
  listen(accountState.accountsUi.copy, "click", async () => {
    try {
      await navigator.clipboard.writeText(accountState.accountsUi.code.value);
      setText(accountState.accountsUi.copy, "Copied");
    } catch {
      accountState.accountsUi.code.focus();
      accountState.accountsUi.code.select();
      notice(
        accountState.accountsUi.error,
        "Clipboard access is unavailable. Copy the selected invitation key manually.",
        "warning",
      );
    }
  });
  listen(appState.ui.settingsDialog, "close", () => {
    accountState.accountsUi.code.value = "";
    accountState.accountsUi.created.hidden = true;
  });
  listen(appState.element("account-password-cancel"), "click", () => accountState.accountsUi.dialog.close());
  listen(accountState.accountsUi.dialog, "close", () => {
    accountState.accountsUi.password.value = "";
    accountState.passwordTarget = null;
  });
  listen(appState.element("account-password-form"), "submit", async (event) => {
    event.preventDefault();
    if (!accountState.passwordTarget) return;
    const saved = await accountAction({
      action: "password",
      username: accountState.passwordTarget,
      password: accountState.accountsUi.password.value,
    });
    accountState.accountsUi.password.value = "";
    if (saved) accountState.accountsUi.dialog.close();
  });
  listen(appState.element("auth-use-invitation"), "click", () => showAuthentication(false, "", true));
  listen(appState.element("auth-back-login"), "click", () => {
    appState.element("auth-invitation").value = "";
    appState.ui.authPassword.value = "";
    appState.ui.authConfirm.value = "";
    showAuthentication(false);
  });
}
export function accountButton(label: string, action: () => void) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.disabled = accountState.accountBusy;
  button.addEventListener("click", action);
  return button;
}
export function renderAccounts(value: AccountsListing): void {
  if (!Array.isArray(value?.users) || !Array.isArray(value?.invitations))
    throw new ApiError("Incomplete account data.");
  const users = document.createDocumentFragment();
  for (const user of value.users) {
    const row = document.createElement("div");
    row.className = "account-row";
    const name = document.createElement("strong");
    name.textContent = user.username;
    const role = document.createElement("select");
    role.setAttribute("aria-label", `Role for ${user.username}`);
    for (const value of ["user", "admin"] as const) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value === "admin" ? "Administrator" : "User";
      role.append(option);
    }
    role.value = user.role;
    role.addEventListener("change", async () => {
      if (
        !(await confirmAction(
          `Change ${user.username} to ${role.value}? Existing sessions for this account will end.`,
          { label: "Change role" },
        ))
      ) {
        role.value = user.role;
        return;
      }
      void accountAction({ action: "role", username: user.username, role: role.value });
    });
    row.append(
      name,
      role,
      accountButton("Reset password", () => {
        accountState.passwordTarget = user.username;
        accountState.accountsUi.password.value = "";
        setText(appState.element("account-password-title"), `Reset password: ${user.username}`);
        notice(accountState.accountsUi.passwordError, "");
        showDialog(accountState.accountsUi.dialog, { restoreParent: true });
        accountState.accountsUi.password.focus();
      }),
      accountButton("Delete", async () => {
        if (
          await confirmAction(
            `Delete account ${user.username}? Their sessions will end; note files will not be deleted.`,
            { label: "Delete account" },
          )
        ) {
          void accountAction({ action: "delete", username: user.username });
        }
      }),
    );
    users.append(row);
  }
  accountState.accountsUi.list.replaceChildren(users);
  const invitations = document.createDocumentFragment();
  for (const invite of value.invitations) {
    const row = document.createElement("div");
    row.className = "account-row invitation-row";
    const details = document.createElement("span");
    details.textContent = `${invite.id.slice(0, 8)} · ${
      invite.usedBy
        ? `Used by ${invite.usedBy}`
        : invite.expired
          ? "Expired"
          : `Expires ${new Date(invite.expiresAt * 1000).toLocaleString()}`
    }`;
    row.append(
      details,
      accountButton("Revoke", () => void accountAction({ action: "revokeInvite", id: invite.id })),
    );
    invitations.append(row);
  }
  accountState.accountsUi.invitations.replaceChildren(invitations);
  if (!value.invitations.length) accountState.accountsUi.invitations.textContent = "No invitations.";
}
export function accountControls(): void {
  accountState.accountsUi.create.disabled = accountState.accountBusy;
  for (const control of document.querySelectorAll<HTMLButtonElement>(
    "#accounts-list button, #accounts-list select, #invitations-list button, #account-password-form button",
  )) {
    control.disabled = accountState.accountBusy;
  }
}
export async function loadAccounts(): Promise<void> {
  if (authenticationSession.user?.role !== "admin" || accountState.accountBusy) return;
  accountState.accountBusy = true;
  accountControls();
  notice(accountState.accountsUi.error, "");
  try {
    renderAccounts(
      await api("/api/admin/accounts", {
        decode: decodedAccounts,
      }),
    );
  } catch (errorCause) {
    const error = errorContext(errorCause);
    notice(accountState.accountsUi.error, error.message, "error");
  } finally {
    accountState.accountBusy = false;
    accountControls();
  }
}
export async function accountAction(body: Action) {
  if (authenticationSession.user?.role !== "admin" || accountState.accountBusy) return false;
  const self = body.username === authenticationSession.user.username;
  if (self && !(await confirmDiscard("update your account and log in again"))) return false;
  accountState.accountBusy = true;
  accountControls();
  notice(accountState.accountsUi.error, "");
  try {
    const response = await api("/api/admin/accounts", {
      decode: decodedAccountAction,
      method: "POST",
      body,
    });
    if (self) {
      window.location.reload();
      return true;
    }
    if (!response.accounts) throw new ApiError("The service returned an incomplete account update.");
    renderAccounts(response.accounts);
    if (response.code) {
      accountState.accountsUi.code.value = response.code;
      accountState.accountsUi.created.hidden = false;
      setText(accountState.accountsUi.copy, "Copy invitation");
    }
    return true;
  } catch (errorCause) {
    const error = errorContext(errorCause);
    notice(accountState.accountsUi.error, error.message, "error");
    if (accountState.accountsUi.dialog.open) notice(accountState.accountsUi.passwordError, error.message, "error");
    return false;
  } finally {
    if (body.password) body.password = "";
    accountState.accountBusy = false;
    accountControls();
  }
}
function createAccountsUi() {
  return {
    list: appState.element("accounts-list"),
    invitations: appState.element("invitations-list"),
    error: appState.element("accounts-error"),
    create: appState.element("invite-create"),
    lifetime: appState.element("invite-lifetime"),
    created: appState.element("invite-created"),
    code: appState.element("invite-code"),
    copy: appState.element("invite-copy"),
    dialog: appState.element("account-password-dialog"),
    password: appState.element("account-password"),
    passwordError: appState.element("account-password-error"),
  };
}
