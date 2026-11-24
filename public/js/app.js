// Boot: who am I, then the chrome, then the screen for this URL. Screen families load on first
// use (dynamic import), so the first paint carries only what this page needs.
import { html, render } from "./core/dom.js";
import { boot } from "./core/session.js";
import { route, start } from "./core/router.js";
import { mountChrome, setActive, setRecord } from "./core/chrome.js";
import { afterPaint } from "./core/motion.js";

const requester = () => import("./screens/requester/hub.js");
const wizard = () => import("./screens/requester/wizard.js");
const status = () => import("./screens/requester/status.js");
const queue = () => import("./screens/coordinator/queue.js");
const coordinate = () => import("./screens/coordinator/coordinate.js");
const pots = () => import("./screens/coordinator/pots.js");
const inbox = () => import("./screens/approver/inbox.js");
const decision = () => import("./screens/approver/decision.js");
const faQueue = () => import("./screens/fa/queue.js");
const faJudge = () => import("./screens/fa/judge.js");
const faIssue = () => import("./screens/fa/issue.js");
const projects = () => import("./screens/projects/list.js");
const projectIo = () => import("./screens/projects/io.js");
const supplemental = () => import("./screens/requester/supplemental.js");
const leadership = () => import("./screens/lead/portfolio.js");
const aucReview = () => import("./screens/fa/review.js");
const tracker = () => import("./screens/fa/tracker.js");
const admin = () => import("./screens/admin/admin.js");
const mailbox = () => import("./screens/admin/mailbox.js");

route("/", requester, { section: "requests" });
route("/requests", requester, { section: "requests" });
route("/afe/new", wizard, { section: "requests" });
route("/afe/:id/edit/:step", wizard, { section: "requests" });
route("/afe/:id/review", wizard, { section: "requests" });
route("/afe/:id", status, { section: "requests" });
route("/afe/:id/thread", status, { section: "requests" });
route("/afe/:id/coordinate", coordinate, { section: "prepare" });
route("/prepare", queue, { section: "prepare" });
route("/pots", pots, { section: "pots" });
route("/approvals", inbox, { section: "approvals" });
route("/approve/:id", decision, { section: "approvals" });
route("/fa", faQueue, { section: "fa" });
route("/fa/:id/judge", faJudge, { section: "fa" });
route("/fa/:id/issue", faIssue, { section: "fa" });
route("/projects", projects, { section: "projects" });
route("/io/:ioNumber", projectIo, { section: "projects" });
route("/afe/:id/supplemental", supplemental, { section: "requests" });
route("/leadership", leadership, { section: "leadership" });
route("/auc-review", aucReview, { section: "fa" });
route("/tracker", tracker, { section: "fa" });
route("/admin", admin, { section: "admin" });
route("/mailbox", mailbox, { section: "mailbox" });

function notFound(root, ctx) {
  render(root, html`
    <div class="wrap pane">
      <h1 class="q">That page isn't here.</h1>
      <p class="hint">${ctx.error ? "The screen failed to load — the details are in the console." : `Nothing lives at ${ctx.path}.`}</p>
      <div class="foot"><a class="cta" href="/requests">Back to your requests</a></div>
    </div>`);
}

(async () => {
  const app = document.getElementById("app");
  try {
    await boot();
  } catch (e) {
    render(app, html`<div class="wrap pane"><h1 class="q">The service did not answer.</h1><p class="hint">${e.message}. Check the server log, then reload.</p></div>`);
    return;
  }
  mountChrome();
  await start(app, {
    before: (ctx) => { setActive(ctx.route && ctx.route.meta ? ctx.route.meta.section : ""); },
    // Leaving a screen closes the context bar, so a screen that shows no record never has to
    // remember to say so — and one that forgets cannot leave someone else's AFE named up there.
    screenChanged: () => setRecord(null),
    painted: afterPaint,
    notFound,
  });
})();
