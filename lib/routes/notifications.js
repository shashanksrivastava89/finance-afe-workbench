"use strict";
const express = require("express");

module.exports = function notificationRoutes({ repos }) {
  const r = express.Router();

  r.get("/notifications", async (req, res) => {
    const mine = await repos.notifications.all((n) => n.recipientEmail === req.ctx.user.email.toLowerCase());
    mine.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    res.json(mine.slice(0, 100));
  });

  r.post("/notifications/:id/read", async (req, res) => {
    const n = await repos.notifications.get(req.params.id);
    if (!n || n.recipientEmail !== req.ctx.user.email.toLowerCase()) return res.status(404).json({ error: "not found" });
    await repos.notifications.update(n.id, { readAt: new Date().toISOString() });
    res.json({ ok: true });
  });

  return r;
};
