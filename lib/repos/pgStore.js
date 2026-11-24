"use strict";
// Durable storage, activated by DATABASE_URL. Without it the app runs exactly as
// before, in memory — so a missing database degrades to the PoC behaviour instead of
// failing to boot.
//
// Design: **write-through, read-from-memory.** Every collection keeps its working set
// in memory (a few thousand documents, a handful of MB) and mirrors every mutation
// into Postgres as a JSONB row. On boot we load from Postgres if it has data, and fall
// back to seeding when it is empty.
//
// Why not a relational schema now: `all(pred)` and `find(pred)` take arbitrary
// JavaScript predicates and are used everywhere. Translating those to SQL is the
// Phase-1 relational model in docs/ERD.md §9, and doing it under demo pressure would
// risk the behaviour that 60+ smoke checks currently pin down. This gives real
// durability today without changing a single call site.
const { Pool } = require("pg");
const managedIdentity = require("../integrations/managedIdentity");

const DDL = `
CREATE TABLE IF NOT EXISTS documents (
  collection TEXT NOT NULL,
  id         TEXT NOT NULL,
  doc        JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (collection, id)
);
CREATE TABLE IF NOT EXISTS attachments (
  storage_key TEXT PRIMARY KEY,
  bytes       BYTEA NOT NULL,
  size_bytes  INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS documents_collection_idx ON documents (collection);
`;

/**
 * TLS is on unless the connection string asks for it to be off.
 *
 * A development container on this machine speaks no TLS, so `?sslmode=disable` in its URL says
 * so out loud. Everything else is encrypted by default — the decision is never taken from a
 * host name, so no deployed database can quietly end up in the clear because a URL looked local.
 */
function sslFor(url) {
  if (/[?&](sslmode=disable|ssl=false)\b/i.test(String(url))) return false;
  // Azure Postgres Flexible Server requires TLS. The server presents a Microsoft-issued
  // certificate; App Service's trust store does not carry that root, so the chain cannot be
  // verified from here. Encrypted, not authenticated — acceptable for a UAT PoC inside the
  // tenant, and flagged in CLAUDE.md as Phase-1 work (pin the DigiCert root, or managed identity).
  return { rejectUnauthorized: false };
}

// ---- the database signs the app in with Entra ID (Part B, DB Ops' request of 2 Oct 2026) ------
//
// With DATABASE_AUTH=entra the app has no database password at all: each new connection presents
// a token from the app's own managed identity, which Azure Database for PostgreSQL accepts for the
// role created for that identity (`pgaadauth_create_principal_with_oid`). DATABASE_URL then names
// only the host, the database and that role — `postgres://afe-workbench-uat@<host>:5432/afe`.
// Without the setting nothing here runs and the pool is exactly what it was.

/** The Entra audience Azure Database for PostgreSQL accepts a token for. */
const PG_AUDIENCE = "https://ossrdbms-aad.database.windows.net";

/** "entra" when DATABASE_AUTH says so, "password" otherwise — the mode /health reports. */
function authMode() {
  return String(process.env.DATABASE_AUTH || "").trim().toLowerCase() === "entra" ? "entra" : "password";
}

/**
 * The pool's settings in Entra mode: DISCRETE FIELDS, never a connection string. `pg` lets a
 * connection string override the options passed beside it, and a URL with no password parses to
 * `password: ""` — which would quietly replace the token with an empty password. The token is asked
 * for per connection (managedIdentity remembers it until shortly before it expires), and the
 * server's certificate is VERIFIED: a token is a credential, and it is only handed to the server
 * the certificate proves this is. `POST /api/admin/db/entra-check` tries all of it first.
 */
function entraConfig(url) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port) || 5432,
    database: decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres",
    user: decodeURIComponent(u.username),
    password: () => managedIdentity.getToken(PG_AUDIENCE),
    ssl: { rejectUnauthorized: true, servername: u.hostname },
  };
}

function createPool(url) {
  const common = { max: 4, idleTimeoutMillis: 30000, connectionTimeoutMillis: 15000 };
  if (authMode() === "entra") return new Pool(Object.assign(entraConfig(url), common));
  return new Pool(Object.assign({ connectionString: url, ssl: sslFor(url) }, common));
}

/**
 * Create the tables only when one is missing.
 *
 * A role that may read and write but not create — which is what the app's Entra role is given —
 * cannot run `CREATE TABLE IF NOT EXISTS` even when the table exists: Postgres checks the CREATE
 * privilege on the schema before it looks. So boot asks `to_regclass` first, and runs the DDL only
 * on a database that does not have the tables yet, which is the first boot under the owner's
 * password and never one under Entra. Returns whether it created anything.
 */
async function ensureSchema(pool) {
  const r = await pool.query("SELECT to_regclass('public.documents') AS documents, to_regclass('public.attachments') AS attachments, "
    + "to_regclass('public.documents_collection_idx') AS idx");
  const row = r.rows[0] || {};
  if (row.documents && row.attachments && row.idx) return false;
  await pool.query(DDL);
  return true;
}

/**
 * A dry run of Entra sign-in from INSIDE the container, before anybody switches DATABASE_AUTH:
 * can the identity get a token for the database, does the server's certificate verify, does the
 * role sign in, and may it read and write both tables? Changes nothing — one connection, three
 * read-only queries, closed. The token itself is never returned; its claims are, because the
 * runbook needs the identity's object id to create the role.
 *
 * @param {{ url: string, user: string }} o   url defaults to DATABASE_URL; user is the Entra role
 */
async function entraCheck(o) {
  const out = { identity: null, connect: null, privileges: null, schema: null, ready: false, problems: [] };
  const base = o && o.url ? o.url : process.env.DATABASE_URL;
  if (!base) { out.problems.push("DATABASE_URL is not set"); return out; }
  const cfg = entraConfig(base);
  if (o && o.user) cfg.user = String(o.user);
  if (!cfg.user) { out.problems.push("which role? Pass the Entra role name as `user`"); return out; }

  let token = null;
  try {
    token = await managedIdentity.getToken(PG_AUDIENCE);
    const claims = JSON.parse(Buffer.from(String(token).split(".")[1] || "", "base64url").toString("utf8") || "{}");
    out.identity = { ok: true, audience: claims.aud || null, objectId: claims.oid || null, appId: claims.appid || claims.azp || null,
      expiresAt: claims.exp ? new Date(claims.exp * 1000).toISOString() : null };
  } catch (e) {
    out.identity = { ok: false, error: e.message };
    out.problems.push(`no token: ${e.message}`);
    return out;
  }

  const { Client } = require("pg");
  const client = new Client(Object.assign({}, cfg, { password: token, connectionTimeoutMillis: 15000 }));
  try {
    await client.connect();
    const who = await client.query("SELECT current_user AS who, version() AS version");
    out.connect = { ok: true, host: cfg.host, database: cfg.database, user: who.rows[0].who, tls: "verified", server: String(who.rows[0].version).split(",")[0] };
    const priv = await client.query(`SELECT t, has_table_privilege(t, 'SELECT') AS s, has_table_privilege(t, 'INSERT') AS i,
      has_table_privilege(t, 'UPDATE') AS u, has_table_privilege(t, 'DELETE') AS d
      FROM (VALUES ('public.documents'), ('public.attachments')) AS v(t) WHERE to_regclass(t) IS NOT NULL`);
    out.privileges = {};
    for (const row of priv.rows) out.privileges[row.t.replace("public.", "")] = { select: row.s, insert: row.i, update: row.u, delete: row.d };
    const sch = await client.query("SELECT to_regclass('public.documents') IS NOT NULL AS documents, to_regclass('public.attachments') IS NOT NULL AS attachments, "
      + "to_regclass('public.documents_collection_idx') IS NOT NULL AS idx");
    out.schema = sch.rows[0];
    for (const t of ["documents", "attachments"]) {
      const p = out.privileges[t];
      if (!out.schema[t]) out.problems.push(`table ${t} does not exist yet — boot once under the owner's password first`);
      else if (!p || !(p.select && p.insert && p.update && p.delete)) out.problems.push(`${cfg.user} lacks SELECT, INSERT, UPDATE or DELETE on ${t}`);
    }
    if (!out.schema.idx) out.problems.push("the documents index does not exist yet — boot once under the owner's password first");
  } catch (e) {
    const tlsProblem = /certificate|self[- ]signed|CERT_|unable to verify/i.test(String(e.message));
    // A refusal AT sign-in comes after the TLS handshake, so the certificate verified — which is
    // what the first dry run on UAT showed (2026-10-14), before Entra sign-in was even enabled.
    const afterHandshake = /password authentication failed|role "[^"]*" does not exist|no pg_hba\.conf entry|database "[^"]*" does not exist/i.test(String(e.message));
    out.connect = { ok: false, host: cfg.host, database: cfg.database, user: cfg.user,
      tls: tlsProblem ? "not verified" : afterHandshake ? "verified" : "unknown", error: e.message };
    out.problems.push(tlsProblem ? `the server's certificate does not verify from here: ${e.message}` : `sign-in failed: ${e.message}`);
  } finally {
    await client.end().catch(() => {});
  }
  out.ready = out.problems.length === 0;
  return out;
}

/**
 * A collection with the in-memory interface, mirrored to Postgres.
 * `pool` may be null — then it behaves exactly like the in-memory collection.
 */
function pgCollection(prefix, pool, table) {
  let rows = new Map();
  let counter = 0;
  let suspended = false;
  const name = table || prefix;

  const noteId = (id) => {
    const m = /^(?:.*-)?(\d+)$/.exec(id);
    if (m) counter = Math.max(counter, parseInt(m[1], 10));
  };
  function nextId() { counter += 1; return `${prefix}-${String(counter).padStart(4, "0")}`; }

  // Persistence is fire-and-forget on the request path: a database hiccup must not
  // fail a user action that has already succeeded in memory. Errors are logged loudly.
  const persist = (id, doc) => {
    if (!pool || suspended) return;
    pool.query(
      "INSERT INTO documents (collection, id, doc, updated_at) VALUES ($1,$2,$3,now()) " +
      "ON CONFLICT (collection, id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()",
      [name, id, JSON.stringify(doc)]
    ).catch((e) => console.error(`[pg] persist ${name}/${id} failed:`, e.message));
  };
  const forget = (id) => {
    if (!pool) return;
    pool.query("DELETE FROM documents WHERE collection = $1 AND id = $2", [name, id])
      .catch((e) => console.error(`[pg] delete ${name}/${id} failed:`, e.message));
  };
  // Multi-row upsert, 500 per statement. Used by insertMany and _flush.
  async function writeBatch(docs) {
    const BATCH = 500;
    for (let i = 0; i < docs.length; i += BATCH) {
      const chunk = docs.slice(i, i + BATCH);
      const values = [];
      const params = [];
      chunk.forEach((doc, j) => {
        values.push(`($${j * 3 + 1},$${j * 3 + 2},$${j * 3 + 3})`);
        params.push(name, doc.id, JSON.stringify(doc));
      });
      await pool.query(
        "INSERT INTO documents (collection, id, doc) VALUES " + values.join(",") +
        " ON CONFLICT (collection, id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()",
        params
      );
    }
  }

  return {
    async insert(obj) {
      const id = obj.id || nextId();
      const row = Object.assign({ version: 1 }, obj, { id });
      rows.set(id, row);
      noteId(id);
      persist(id, row);
      return row;
    },
    // Bulk insert: rows land in memory immediately, then go to Postgres in batches of
    // 500. The per-row fire-and-forget path cannot keep up with an extract import.
    async insertMany(objs) {
      const out = [];
      for (const obj of objs) {
        const id = obj.id || nextId();
        const row = Object.assign({ version: 1 }, obj, { id });
        rows.set(id, row);
        noteId(id);
        out.push(row);
      }
      if (pool && !suspended && out.length) await writeBatch(out);
      return out;
    },
    async get(id) { return rows.get(id) || null; },
    async all(pred) {
      const list = Array.from(rows.values());
      return pred ? list.filter(pred) : list;
    },
    async find(pred) {
      for (const r of rows.values()) if (pred(r)) return r;
      return null;
    },
    async update(id, patch) {
      const row = rows.get(id);
      if (!row) throw new Error(`${prefix}: not found ${id}`);
      Object.assign(row, patch, { version: (row.version || 1) + 1 });
      persist(id, row);
      return row;
    },
    async remove(id) { rows.delete(id); forget(id); },
    async clear() {
      rows = new Map();
      counter = 0;
      if (pool) {
        await pool.query("DELETE FROM documents WHERE collection = $1", [name])
          .catch((e) => console.error(`[pg] clear ${name} failed:`, e.message));
      }
    },
    async count(pred) { return (await this.all(pred)).length; },
    // Boot-time load: straight into the map, no re-persisting what we just read.
    async _load(docs) {
      for (const d of docs) { rows.set(d.id, d); noteId(d.id); }
    },
    // Seeding writes thousands of rows; one statement per row through a 4-connection
    // pool takes minutes. Suppress the per-row writes during hydration and flush the
    // whole collection in batches afterwards.
    _suspend() { suspended = true; },
    async _flush() {
      suspended = false;
      if (!pool || !rows.size) return 0;
      const all = Array.from(rows.values());
      await writeBatch(all);
      return all.length;
    },
    _size() { return rows.size; },
    nextId,
  };
}

function pgAttachmentStore(pool) {
  const MAX_TOTAL = 200 * 1024 * 1024;
  const cache = new Map();
  // Bumped by clear(). Ids restart with the store, so bytes read for `att-0007` before a reset
  // and cached after it would be handed to the NEXT file given that id; an answer is cached only
  // if no reset ran while it was in flight (2026-10-02, when the boot warm-up made it likely).
  let generation = 0;
  return {
    async put(storageKey, buffer) {
      if (!pool) {
        let total = 0;
        cache.forEach((b) => { total += b.length; });
        if (total + buffer.length > 50 * 1024 * 1024) throw new Error("attachment store is full (in-memory cap)");
        cache.set(storageKey, buffer);
        return;
      }
      if (buffer.length > MAX_TOTAL) throw new Error("attachment too large");
      cache.set(storageKey, buffer);
      await pool.query(
        "INSERT INTO attachments (storage_key, bytes, size_bytes) VALUES ($1,$2,$3) " +
        "ON CONFLICT (storage_key) DO UPDATE SET bytes = EXCLUDED.bytes, size_bytes = EXCLUDED.size_bytes",
        [storageKey, buffer, buffer.length]
      );
    },
    async get(storageKey) {
      if (cache.has(storageKey)) return cache.get(storageKey);
      if (!pool) return null;
      const asked = generation;
      const r = await pool.query("SELECT bytes FROM attachments WHERE storage_key = $1", [storageKey]);
      if (!r.rows.length) return null;
      const buf = r.rows[0].bytes;
      if (asked === generation) cache.set(storageKey, buf);
      return buf;
    },
    async clear() {
      generation += 1;
      cache.clear();
      if (pool) await pool.query("DELETE FROM attachments").catch(() => {});
    },
  };
}

module.exports = { createPool, pgCollection, pgAttachmentStore, DDL, ensureSchema, authMode, entraConfig, entraCheck, PG_AUDIENCE };
