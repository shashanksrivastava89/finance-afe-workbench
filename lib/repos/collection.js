"use strict";
// Generic in-memory collection. The Postgres implementation replaces this file's
// factory with SQL-backed equivalents behind the SAME async interface (see docs/ERD.md §9).
function collection(prefix) {
  let rows = new Map();
  let counter = 0;

  function nextId() {
    counter += 1;
    return `${prefix}-${String(counter).padStart(4, "0")}`;
  }

  return {
    async insert(obj) {
      const id = obj.id || nextId();
      const row = Object.assign({ version: 1 }, obj, { id });
      rows.set(id, row);
      // keep the counter ahead of any seeded numeric suffixes
      const m = /^(?:.*-)?(\d+)$/.exec(id);
      if (m) counter = Math.max(counter, parseInt(m[1], 10));
      return row;
    },
    // Bulk load (seeding, extract imports). Same shape as insert, one pass.
    async insertMany(objs) {
      const out = [];
      for (const obj of objs) out.push(await this.insert(obj));
      return out;
    },
    async get(id) {
      return rows.get(id) || null;
    },
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
      return row;
    },
    async remove(id) {
      rows.delete(id);
    },
    async clear() {
      rows = new Map();
      counter = 0;
    },
    async count(pred) {
      return (await this.all(pred)).length;
    },
    nextId,
  };
}

module.exports = { collection };
