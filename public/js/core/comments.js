// Posting to an AFE's conversation (R149) — one function for every screen that shows the thread,
// so the approver's page, the inbox, the coordinator's routing, the requester's record and Fixed
// Assets' judgment cannot disagree about what "Post" does. The markup is `parts.thread`.
import { $ } from "./dom.js";
import { api } from "./api.js";
import { store } from "./store.js";
import { toast, busy, showError } from "./ui.js";

/**
 * Post what is in the compose box under `root`.
 * @returns {Promise<boolean>} true when it posted; the caller reloads and repaints
 */
export async function postComment(afeId, root, button) {
  const box = $("[data-thread-text]", root);
  const text = box ? box.value.trim() : "";
  if (!text) { if (box) box.focus(); return false; }
  // The Ask button is the same post with `ask`: the one line that tells the other side (R163).
  // "Answer" on an approver's pausing question is the ANSWER transition — the one that releases
  // the hold and tells them; "Answer" on an ask is a comment, which the server reads as the answer.
  const ask = Boolean(button && button.dataset.ask);
  const answersQuestion = Boolean(button && button.dataset.answer === "question");
  const done = busy(button, ask ? "Asking…" : button && button.dataset.answer ? "Answering…" : "Posting…");
  try {
    const r = answersQuestion ? await api.post(`/api/afes/${afeId}/answer`, { text })
      : await api.post(`/api/afes/${afeId}/comment`, ask ? { text, ask: true } : { text });
    box.value = "";
    store.bust("/api");
    const note = String((r && r.note) || "posted");
    toast(note.charAt(0).toUpperCase() + note.slice(1) + ".", "ok");
    return true;
  } catch (e) {
    done();
    showError(e);
    return false;
  }
}
