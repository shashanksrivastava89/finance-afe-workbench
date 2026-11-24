"use strict";
// Warm what the first person to open an AFE would otherwise wait for (2026-10-02).
//
// Two things are worked out on first use and remembered for the life of the process, and after
// every deploy or restart on UAT's B1 both were paid by whoever happened to open an AFE first:
//   - the form-hash check (`envelopeDocs.verifyFormHash`), which re-renders the whole signed form —
//     1.2 to 2.9 s an AFE, measured on 2026-09-28, against 46 to 81 ms once it is remembered;
//   - the signed document's bytes, which the attachment store reads out of Postgres the first time
//     the judge screen's frame asks for them and holds in memory after.
// This pays both at boot, in the background, one AFE at a time. Between AFEs it yields, so a
// request that arrives meanwhile is answered between two renders rather than after all of them.
//
// It warms THROUGH `faView` rather than calling the check itself: the answer is remembered
// against the exact routing and envelope the view hands it, so going through the view is the only
// way to be sure the entry left behind is the one the screen will ask for. Which AFEs are the
// Fixed Assets queue's own (`/fa/queue`), so the warm set and the screens cannot drift apart. The
// documents are only those waiting to be checked, because that is the one screen that embeds the
// signed file and it is a short list; everything else is fetched when somebody asks.
//
// Never on the 10-minute tick (it is not in `scheduler.JOBS`): once warm, an AFE stays warm until
// the process ends, and repeating it would spend the CPU it exists to save. A failure is counted
// and skipped — warming is an optimisation, never a reason for a boot or a request to fail.
const { faView, inFaHands, toCheck } = require("../views/faView");
const envelopeDocs = require("../envelopeDocs");

/** The warm-up's own identity: reading only, and holding no role that could do anything. */
const SYSTEM_CTX = {
  realUser: { email: "system", displayName: "Boot warm-up" },
  user: { email: "system", displayName: "Boot warm-up" },
  userRow: { email: "system", displayName: "Boot warm-up", matrixNames: [], roles: ["system"] },
  roles: ["system"], coordinatorFor: [], actingAs: null, realRoles: ["system"],
};

const breathe = () => new Promise((r) => setImmediate(r));

/**
 * @param {object} repos
 * @param {object} [opts] { log } — a line per AFE that could not be warmed
 * @returns {Promise<{ afes, checked, documents, failed, ms }>}
 */
async function run(repos, opts) {
  const log = (opts && opts.log) || (() => {});
  const t0 = Date.now();
  const afes = (await repos.afes.all(inFaHands)).filter((a) => a.envelopeId);
  let checked = 0, documents = 0, failed = 0;
  for (const afe of afes) {
    await breathe();
    try {
      const v = await faView(repos, afe, SYSTEM_CTX);
      if (v.formHash && v.formHash.checked) checked += 1;
      if (toCheck(afe)) {
        const stored = envelopeDocs.storedDocument(afe, v.envelope, v.resume);
        if (stored && await repos.attachmentStore.get(stored.attachmentId)) documents += 1;
      }
    } catch (e) {
      failed += 1;
      log(`warm-up: ${afe.id} skipped — ${e.message}`);
    }
  }
  return { afes: afes.length, checked, documents, failed, ms: Date.now() - t0 };
}

module.exports = { run, SYSTEM_CTX };
