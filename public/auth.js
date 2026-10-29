// Supabase client, session helpers, account gate, and the register/login/reset pages.
// Account status is enforced in SQL (RLS + RPC checks); the UI gate only explains it.
import { applyI18n, t } from "./i18n.js";
import { h } from "./core.js";

export const cfg = window.APP_CONFIG ?? {};
let client = null;

export function getClient() {
  client ??= window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return client;
}

export class AppError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// SQL business errors arrive as the bare code (`raise exception 'slug_taken'`).
export function errorText(err, vars) {
  const code = String(err?.code ?? err?.message ?? "");
  if (!/^[a-z_]+$/.test(code)) return t("err.generic");
  const key = `err.${code}`;
  const text = t(key, vars);
  return text === key ? t("err.generic") : text;
}

export async function rpc(name, args = {}) {
  const { data, error } = await getClient().rpc(name, args);
  if (error) throw new AppError(error.message);
  return data;
}

export async function callFunction(name, { method = "POST", body } = {}) {
  const { data } = await getClient().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new AppError("not_authorized");
  const res = await fetch(`${cfg.SUPABASE_URL}/functions/v1/${name}`, {
    method,
    headers: { apikey: cfg.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new AppError(json.error || "generic");
  return json;
}

export async function currentProfile() {
  const { data } = await getClient().auth.getUser();
  const user = data?.user;
  if (!user) return null;
  const { data: profile } = await getClient().from("profiles").select("*").eq("id", user.id).maybeSingle();
  return profile ?? null;
}

export async function signOut() {
  await getClient().auth.signOut();
  location.href = "/login";
}

export function homeFor(profile) {
  if (profile?.account_status !== "active") return null;
  return profile.role === "admin" ? "/admin" : "/dashboard";
}

async function supportContact() {
  try {
    return (await rpc("public_checkout_config"))?.support_contact || "";
  } catch {
    return "";
  }
}

// Waiting / blocked screens for accounts that are not active.
export async function renderGate(container, profile) {
  const pending = profile.account_status === "pending";
  const contact = pending ? "" : await supportContact();
  const tgBox = h("div", { class: "stack" });

  if (pending) {
    const connect = h("button", { class: "btn btn-secondary btn-sm", type: "button" }, t("set.tgConnect"));
    connect.addEventListener("click", async () => {
      try {
        const [link] = await rpc("create_telegram_link_code");
        tgBox.replaceChildren(
          h("p", { class: "hint" }, t("set.tgOpen")),
          h("a", { class: "btn btn-primary btn-sm", href: link.deeplink, target: "_blank", rel: "noopener" }, t("set.tgOpenButton")),
        );
      } catch (err) {
        tgBox.append(h("p", { class: "error" }, errorText(err)));
      }
    });
    if (!profile.telegram_chat_id) tgBox.append(h("p", { class: "muted small" }, t("gate.pending.telegram")), connect);
  }

  container.replaceChildren(
    h("div", { class: "card raised center stack" },
      h("h1", {}, t(pending ? "gate.pending.title" : "gate.blocked.title")),
      h("p", { class: "muted" }, t(pending ? "gate.pending.body" : "gate.blocked.body")),
      !pending && profile.status_reason ? h("p", { class: "notice bad" }, `${t("gate.reason")}: ${profile.status_reason}`) : null,
      !pending && contact ? h("p", {}, `${t("gate.contact")}: `, h("span", { class: "mono" }, contact)) : null,
      tgBox,
      h("button", { class: "btn btn-ghost", type: "button", onclick: signOut }, t("nav.logout")),
    ),
  );
}

// For dashboard/admin: returns the active profile or renders the right screen and returns null.
export async function requireActive(container, { admin = false } = {}) {
  const { data } = await getClient().auth.getSession();
  if (!data.session) {
    location.replace("/login");
    return null;
  }
  const profile = await currentProfile();
  if (!profile) {
    await signOut();
    return null;
  }
  if (profile.account_status !== "active") {
    await renderGate(container, profile);
    return null;
  }
  if (admin && profile.role !== "admin") {
    location.replace("/dashboard");
    return null;
  }
  return profile;
}

// ---------------------------------------------------------------------------
// Page wiring
// ---------------------------------------------------------------------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function formError(form, message) {
  const el = form.querySelector("[data-form-error]");
  el.textContent = message ?? "";
  el.hidden = !message;
}

function busy(form, on) {
  for (const b of form.querySelectorAll("button")) b.disabled = on;
}

function initRegister() {
  const form = document.getElementById("register-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const telegram = String(f.telegram ?? "").trim().replace(/^@+/, "");
    if (!f.full_name?.trim() || !f.email?.trim() || !f.phone?.trim() || !f.password) return formError(form, t("err.required"));
    if (!EMAIL_RE.test(f.email.trim())) return formError(form, t("err.email_invalid"));
    if (telegram && !/^[A-Za-z0-9_]{5,32}$/.test(telegram)) return formError(form, t("err.telegram_username_invalid"));
    if (f.password.length < 10) return formError(form, t("err.password_short"));
    if (f.password !== f.confirm) return formError(form, t("err.password_mismatch"));
    formError(form, null);
    busy(form, true);
    const { data, error } = await getClient().auth.signUp({
      email: f.email.trim(),
      password: f.password,
      options: {
        data: { full_name: f.full_name.trim(), phone: f.phone.trim(), telegram_username: telegram || null },
        emailRedirectTo: `${location.origin}/login`,
      },
    });
    busy(form, false);
    if (error) return formError(form, error.message);
    // Never auto-activate: whatever happened, the account is pending until an admin approves it.
    const needsConfirm = !data.session;
    if (data.session) await getClient().auth.signOut();
    document.getElementById("register-card").hidden = true;
    document.getElementById("register-done").hidden = false;
    document.getElementById("confirm-email").hidden = !needsConfirm;
  });
}

async function routeSignedIn(container) {
  const profile = await currentProfile();
  if (!profile) return;
  const home = homeFor(profile);
  if (home) location.replace(home);
  else await renderGate(container, profile);
}

function initLogin() {
  const form = document.getElementById("login-form");
  const container = document.getElementById("login-area");
  getClient().auth.getSession().then(({ data }) => data.session && routeSignedIn(container));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    if (!f.email || !f.password) return formError(form, t("err.required"));
    busy(form, true);
    const { error } = await getClient().auth.signInWithPassword({ email: f.email.trim(), password: f.password });
    busy(form, false);
    if (error) return formError(form, t("err.invalid_credentials"));
    await routeSignedIn(container);
  });
}

function initReset() {
  const requestForm = document.getElementById("reset-request");
  const updateForm = document.getElementById("reset-update");
  const showUpdate = () => {
    requestForm.closest(".card").hidden = true;
    updateForm.closest(".card").hidden = false;
  };
  getClient().auth.onAuthStateChange((event) => {
    if (event === "PASSWORD_RECOVERY") showUpdate();
  });
  if (/type=recovery/.test(location.hash)) showUpdate();

  requestForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = String(new FormData(requestForm).get("email") ?? "").trim();
    if (!EMAIL_RE.test(email)) return formError(requestForm, t("err.email_invalid"));
    busy(requestForm, true);
    await getClient().auth.resetPasswordForEmail(email, { redirectTo: `${location.origin}/reset` });
    busy(requestForm, false);
    // Same message whether or not the account exists.
    formError(requestForm, null);
    document.getElementById("reset-sent").hidden = false;
  });

  updateForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(updateForm));
    if ((f.password ?? "").length < 10) return formError(updateForm, t("err.password_short"));
    if (f.password !== f.confirm) return formError(updateForm, t("err.password_mismatch"));
    busy(updateForm, true);
    const { error } = await getClient().auth.updateUser({ password: f.password });
    busy(updateForm, false);
    if (error) return formError(updateForm, error.message);
    await getClient().auth.signOut();
    updateForm.replaceChildren(h("p", { class: "notice" }, t("reset.done")), h("a", { class: "btn btn-primary", href: "/login" }, t("nav.login")));
  });
}

const page = document.body?.dataset.page;
if (page === "register") initRegister();
if (page === "login") initLogin();
if (page === "reset") initReset();
if (page) applyI18n();
