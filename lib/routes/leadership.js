"use strict";
// Leadership: the portfolio, read-only.
//
// Nothing here can change anything — the role exists so a manager can answer "how much is
// under construction, why hasn't it capitalized, and is the process moving" without asking
// Fixed Assets to cut a spreadsheet. Fixed Assets and admins see it too, because it is the
// same question they get asked.
const express = require("express");
const { leadershipView } = require("../views/leadershipView");
const { periodOf } = require("../domain/aucReview");
const rbac = require("../domain/rbac");

module.exports = function leadershipRoutes({ repos }) {
  const r = express.Router();

  r.get("/leadership", async (req, res) => {
    if (!rbac.can(req.ctx, "portfolio.read")) {
      return res.status(403).json({ error: "the portfolio view is for leadership, Fixed Assets and coordinators" });
    }
    res.json(await leadershipView(repos, req.ctx, { period: req.query.period || periodOf(new Date()) }));
  });

  return r;
};
