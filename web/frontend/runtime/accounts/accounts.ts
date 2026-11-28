import { createButton } from "@folio/editor-runtime";
import { element } from "../../types/elements";
import { authenticationSession } from "../../state/authentication";
import { decodedAccountAction, decodedAccounts } from "../../api/contracts";
import type { AccountsListing, Action } from "../../types/domain";
import { errorContext } from "../../types/errors";
import { api } from "../core/api";
import { ApiError, notice, setText } from "../core/dom";
import { confirmAction, showDialog } from "../dialogs/dialogs";
import { confirmDiscard } from "../documents/navigation";
import { listen } from "../lifecycle";
import { showAuthentication } from "./authentication";
let accountBusy: boolean;
let passwordTarget: string | null;

export function initializeAccountsAccounts(): void {
  accountBusy = false;
  passwordTarget = null;

  listen(
    element("invite-create"),
    "click",
    () => void accountAction({ action: "invite", hours: Number(element("invite-lifetime").value) }),
  );
  listen(element("invite-copy"), "click", async () => {
    try {
      await copyPlainText(element("invite-code").value);
      setText(element("invite-copy"), "Copied");
    } catch {
      element("invite-code").focus();
      element("invite-code").select();
      notice(element("accounts-error"), "Clipboard unavailable, copy manually", "warning");
    }
  });
  listen(element("settings-dialog"), "close", () => {
    element("invite-code").value = "";
    element("invite-created").hidden = true;
  });
  listen(element("account-password-cancel"), "click", () => element("account-password-dialog").close());
  listen(element("account-password-dialog"), "close", () => {
    element("account-password").value = "";
    passwordTarget = null;
  });
  listen(element("account-password-form"), "submit", async (event) => {
    event.preventDefault();
    if (!passwordTarget) return;
    const saved = await accountAction({
      action: "password",
      username: passwordTarget,
      password: element("account-password").value,
    });
    element("account-password").value = "";
    if (saved) element("account-password-dialog").close();
  });
  listen(element("auth-use-invitation"), "click", () => showAuthentication(false, "", true));
  listen(element("auth-back-login"), "click", () => {
    element("auth-invitation").value = "";
    element("auth-password").value = "";
    element("auth-confirm").value = "";
    showAuthentication(false);
  });
}
function accountButton(label: string, action: () => void) {
  const button = createButton({ label: label });

  button.disabled = accountBusy;
  button.addEventListener("click", action);
  return button;
}
function renderAccounts(value: AccountsListing): void {
  if (!Array.isArray(value?.users) || !Array.isArray(value?.invitations)) throw new ApiError("Incomplete account data");
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
        !(await confirmAction(`Change ${user.username} to ${role.value}? Their sessions will end`, {
          label: "Change role",
        }))
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
        passwordTarget = user.username;
        element("account-password").value = "";
        setText(element("account-password-title"), `Reset password: ${user.username}`);
        notice(element("account-password-error"), "");
        showDialog(element("account-password-dialog"), { restoreParent: true });
        element("account-password").focus();
      }),
      accountButton("Delete", async () => {
        if (await confirmAction(`Delete account ${user.username}? Note files are kept`, { label: "Delete account" })) {
          void accountAction({ action: "delete", username: user.username });
        }
      }),
    );
    users.append(row);
  }
  element("accounts-list").replaceChildren(users);
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
  element("invitations-list").replaceChildren(invitations);
  if (!value.invitations.length) element("invitations-list").textContent = "No invitations";
}
function accountControls(): void {
  element("invite-create").disabled = accountBusy;
  for (const control of document.querySelectorAll<HTMLButtonElement>(
    "#accounts-list button, #accounts-list select, #invitations-list button, #account-password-form button",
  )) {
    control.disabled = accountBusy;
  }
}
export async function loadAccounts(): Promise<void> {
  if (authenticationSession.user?.role !== "admin" || accountBusy) return;
  accountBusy = true;
  accountControls();
  notice(element("accounts-error"), "");
  try {
    renderAccounts(
      await api("/api/admin/accounts", {
        decode: decodedAccounts,
      }),
    );
  } catch (errorCause) {
    const error = errorContext(errorCause);
    notice(element("accounts-error"), error.message, "error");
  } finally {
    accountBusy = false;
    accountControls();
  }
}
async function accountAction(body: Action) {
  if (authenticationSession.user?.role !== "admin" || accountBusy) return false;
  const self = body.username === authenticationSession.user.username;
  if (self && !(await confirmDiscard("update your account and log in again"))) return false;
  accountBusy = true;
  accountControls();
  notice(element("accounts-error"), "");
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
    if (!response.accounts) throw new ApiError("Incomplete account update");
    renderAccounts(response.accounts);
    if (response.code) {
      element("invite-code").value = response.code;
      element("invite-created").hidden = false;
      setText(element("invite-copy"), "Copy invitation");
    }
    return true;
  } catch (errorCause) {
    const error = errorContext(errorCause);
    notice(element("accounts-error"), error.message, "error");
    if (element("account-password-dialog").open) notice(element("account-password-error"), error.message, "error");
    return false;
  } finally {
    if (body.password) body.password = "";
    accountBusy = false;
    accountControls();
  }
}

import { copyPlainText } from "../../../shared/clipboard";
