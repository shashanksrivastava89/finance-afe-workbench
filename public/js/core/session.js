// Who is signed in, what they may do, and the reference data every screen needs once.
import { api } from "./api.js";
import { store } from "./store.js";

export const session = {
  me: null, refdata: null, users: [], ready: false,
  /** Re-read who I am and what is waiting on me. `/api/me` carries the top bar's counts too. */
  async reload() {
    session.me = await api.get("/api/me");
    return session.me;
  },
};

export async function boot() {
  const [me, refdata] = await Promise.all([api.get("/api/me"), api.get("/api/refdata")]);
  session.me = me;
  session.refdata = refdata;
  session.ready = true;
  // "View as" is a support tool: administrators only, and only where the environment turns
  // it on. Everyone else never loads the people list at all.
  if (me.isAdmin && me.demoMode) {
    try { session.users = await api.get("/api/admin/users"); } catch { session.users = []; }
  }
  return session;
}

// What this person may do is decided on the server (lib/domain/rbac.js) and arrives in
// `/api/me`. A screen asks `can("fa.process")`, never "does their role list contain…", so the
// answer here and the answer the API gives can never be two different things.
export const can = (capability) => Boolean(session.me && (session.me.capabilities || []).includes(capability));
export const has = (role) => Boolean(session.me && (session.me.roles || []).includes(role));
export const isCoordinator = () => can("afe.coordinate") && (session.me.coordinatorFor || []).length > 0;
export const isFa = () => can("fa.process");
export const isAdmin = () => Boolean(session.me && session.me.isAdmin);

/** Switch the acted-as identity (demo only), then reload everything that depends on it. */
export async function actAs(email) {
  if (email) await api.post("/api/admin/act-as", { email });
  else await api.del("/api/admin/act-as");
  store.bust("/api");
  await boot();
}

export function firstName() {
  const n = session.me && session.me.displayName;
  return n ? String(n).split(/\s+/)[0] : "";
}
