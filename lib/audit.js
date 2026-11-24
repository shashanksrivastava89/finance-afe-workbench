"use strict";
// The single audit model. EVERY mutation goes through record().
//
// v0.2 had two: events nested on the AFE document, and ad-hoc entries written inline by
// the case routes. Neither could be queried across entities, and the nested one reset its
// sequence on restart. This writes one append-only collection instead.
//
// Rows are never updated or deleted. Phase 1 revokes UPDATE/DELETE at the grant level.

/**
 * @param {object} repos
 * @param {object} ctx    request context (realUser, actingAs) — or {} for system actions
 * @param {object} ev     { entity, entityId, afeId?, type, fromState?, toState?, payload? }
 * @returns {Promise<object>} the stored event
 */
async function record(repos, ctx, ev) {
  const c = ctx || {};
  return repos.auditEvents.insert({
    entity: ev.entity || "afe",
    entityId: ev.entityId || null,
    afeId: ev.afeId || (ev.entity === "afe" ? ev.entityId : null) || null,
    actorEmail: c.realUser ? c.realUser.email : "system",
    actingAsEmail: c.actingAs ? c.actingAs.email : null,
    type: ev.type,
    fromState: ev.fromState || null,
    toState: ev.toState || null,
    payload: ev.payload || {},
    createdAt: new Date().toISOString(),
  });
}

/** Everything recorded against one AFE, oldest first. */
async function forAfe(repos, afeId) {
  const rows = await repos.auditEvents.all((e) => e.afeId === afeId);
  rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return rows;
}

module.exports = { record, forAfe };
