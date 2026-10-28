/* Alooma app — viewer/editor client.
   Data lives in data.json in the public GitHub repo. Reading uses the
   GitHub API (or the Pages-served copy as fallback). Editing requires a
   GitHub token saved ONLY in this device's localStorage; every edit is a
   commit of data.json through the GitHub Contents API. */
(function () {
  "use strict";
  var L = window.ALOOMA;
  var DEFAULT_OWNER = "stainlesssteel770";
  var DEFAULT_REPO = "alooma-demo";
  var DEMO = true; /* demo build only: per-device sandbox, no token, no GitHub writes */
  var LS_KEY = "alooma-demo.editor.v1";

  var state = {
    data: null, sha: null, editor: null, /* {token, owner, repo, login} */
    packCraft: null, bulkCraft: null, loadedAt: null,
    offline: false, savedData: null, localBase: null
  };

  /* ---------- v3 E4: offline action queue + data snapshot ----------
     Saves are captured as ACTIONS (stock deltas, exact-count sets, history
     entries, settings keys) diffed against the last state this device
     knows it saved. Offline, actions queue on the device; on reconnect
     they are re-applied on top of the latest remote data, so both sides
     are kept. A queued exact count whose item also changed remotely is
     the ONLY case that stops and asks. Nothing ever overwrites the whole
     file silently. */
  var QUEUE_KEY = "alooma-demo.queue.v1", SNAP_KEY = "alooma-demo.snapshot.v1";
  var saveQueue = [];
  try { var q = JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); if (Array.isArray(q)) saveQueue = q; } catch (e) {}
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function persistQueue() { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(saveQueue)); } catch (e) {} }
  function persistSnapshot() {
    try { localStorage.setItem(SNAP_KEY, JSON.stringify({ data: state.data, sha: state.sha, savedData: state.savedData, at: new Date().toISOString() })); } catch (e) {}
  }
  function readSnapshot() {
    try { var s = JSON.parse(localStorage.getItem(SNAP_KEY) || "null"); return s && s.data ? s : null; } catch (e) { return null; }
  }

  /* ---------- small helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  var toastTimer = null;
  /* Item 4: toast placement against the ACTIVE tab's action bar, as a
     function of the CURRENT layout — showToast places it once, and
     queueBulkLine re-places it after its post-toast scroll (below).
     Brief item 2 (phone): place against the bar's ACTUAL position, not
     a fixed offset — the bar is sticky, so after a scroll it can sit
     mid-viewport instead of stuck above the nav, and a fixed offset
     then lands the toast right on top of it. Prefer below the bar
     (between bar and nav) when that gap fits the toast; otherwise sit
     above the bar. */
  function placeToast() {
    var t = $("toast");
    if (!t || t.hidden) return;
    if (window.innerWidth <= 700) {
      var bar = document.querySelector(".tab-panel.active .action-bar");
      var tabsEl = $("tabs");
      var navH = tabsEl ? tabsEl.offsetHeight : 66;
      var toastH = t.offsetHeight;
      var vh = window.innerHeight;
      var bottom;
      if (bar) {
        var br = bar.getBoundingClientRect();
        if (br.bottom > 0 && br.top < vh) {
          if (br.bottom + 8 + toastH <= vh - navH) {
            bottom = vh - br.bottom - toastH - 8; /* below the bar */
          } else {
            bottom = vh - br.top + 8; /* above the bar */
          }
        } else if (br.top >= vh) {
          bottom = bar.offsetHeight + navH + 8; /* bar below the fold */
        } else {
          bottom = navH + 8; /* bar scrolled past the top */
        }
      } else {
        bottom = navH + 8;
      }
      t.style.bottom = bottom + "px";
    } else {
      t.style.bottom = "";
    }
  }
  function showToast(html, actionLabel, actionFn, ms, suffixHtml) {
    var t = $("toast");
    /* Fix-round (batch c): the message sits in its own column and wraps
       to 2 lines max (line-clamp) instead of one-line ellipsis — the
       longer "Hand packed …" title must stay fully visible. */
    /* Polish item 3: an optional SKU suffix rides in its own flex-none
       span AFTER the message, so wrapping can never split the SKU —
       the SKU is what the packer reads back. */
    t.innerHTML = '<span class="toast-msg">' + html + "</span>" + (suffixHtml ? '<span class="toast-sku">' + suffixHtml + "</span>" : "");
    if (actionLabel) {
      var b = document.createElement("button");
      b.textContent = actionLabel;
      b.addEventListener("click", function () { t.hidden = true; actionFn(); });
      t.appendChild(b);
    }
    t.hidden = false;
    placeToast();
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ms || 4200);
  }
  function toast(msg) { showToast(esc(msg), null, null, 4200); }
  function actionToast(msg, entry) {
    /* Polish item 3: a trailing "(SKU)" leaves the message
       and rides as the toast-sku suffix instead of a nowrap span inside
       it — inside the message the wrap could split the SKU at 360.
       The leading space sits INSIDE the suffix span (a bare space
       between flex items would collapse), and the parens stay inside
       it too, so "(BM-6)" is one unbreakable unit. */
    var m = esc(msg).match(/\s*\(([^()]*-\d+)\)$/);
    var html = esc(msg), suffix = null;
    if (m) { html = esc(msg).slice(0, m.index); suffix = " (" + m[1] + ")"; }
    showToast(html, "UNDO", function () { undoEntry(entry, true); }, 10000, suffix);
  }
  /* v2 A3: batch saves (a whole delivery / count) get one UNDO that
     reverses every entry in the batch */
  function batchToast(msg, entries) {
    showToast(esc(msg), "UNDO", function () { undoEntries(entries); }, 10000);
  }
  function undoEntries(entries) {
    var any = false;
    entries.forEach(function (e) {
      if (!e.undone) { L.applyEffects(state.data.inventory, e.effects, -1); e.undone = true; any = true; }
    });
    if (!any) return;
    renderAll();
    saveData("Undo batch of " + entries.length).then(function () { toast("Undone — the whole batch was reversed."); });
  }
  /* A4 (Print = done): a print toast's UNDO is NOT History's Undo — it
     splices the entry out of History entirely and reverses its effects, so
     a printed sheet that never happened leaves no History trace. History's
     own Undo button keeps marking entries undone. */
  function undoPrintEntries(entries) {
    entries.forEach(function (e) {
      L.applyEffects(state.data.inventory, e.effects, -1);
      var i = state.data.history.indexOf(e);
      if (i >= 0) state.data.history.splice(i, 1);
    });
    renderAll();
    saveData("Undid print");
  }
  function printToast(msg, entries) {
    /* Polish item 3: same treatment as actionToast for a trailing bare
       SKU ("Printed BM-6" — no parens, so the space goes inside the
       suffix span the same way). */
    var m = esc(msg).match(/\s*([A-Z]{2,}-\d+)$/);
    var html = esc(msg), suffix = null;
    if (m) { html = esc(msg).slice(0, m.index); suffix = " " + m[1]; }
    showToast(html, "UNDO", function () { undoPrintEntries(entries); }, 10000, suffix);
  }
  function commitPrint(entries, toastMsg) {
    entries.forEach(function (e) { L.applyEffects(state.data.inventory, e.effects, +1); state.data.history.unshift(e); });
    renderAll();
    return saveData(toastMsg).then(function () { printToast(toastMsg, entries); });
  }
  function lastDeliveryFor(itemId) {
    for (var i = 0; i < state.data.history.length; i++) {
      var e = state.data.history[i];
      if (e.type === "received" && e.item === itemId && !e.undone) return e.amount || 0;
    }
    return 0;
  }
  /* The Inventory search box also filters the delivery / count forms:
     rows hide in place (typed values are never wiped by a re-render) */
  function filterEntryList(list) {
    if (!list) return;
    var head = null, headVisible = false;
    Array.prototype.forEach.call(list.children, function (el) {
      if (el.classList.contains("entry-head")) {
        if (head) head.style.display = headVisible ? "" : "none";
        head = el; headVisible = false;
      } else {
        var show = !invQuery || (el.getAttribute("data-name") || "").indexOf(invQuery) >= 0;
        el.style.display = show ? "" : "none";
        if (show) headVisible = true;
      }
    });
    if (head) head.style.display = headVisible ? "" : "none";
  }
  /* ---------- in-app confirm sheet (no window.confirm / window.prompt) ---------- */
  var sheetCb = null, sheetCancelCb = null, sheetSticky = false;
  function openSheet(opts) {
    $("sheet-title").textContent = opts.title || "";
    $("sheet-sub").textContent = opts.sub || "";
    $("sheet-summary").textContent = opts.summary || "";
    var extra = $("sheet-extra");
    if (opts.extraHtml) { extra.innerHTML = opts.extraHtml; extra.hidden = false; }
    else { extra.innerHTML = ""; extra.hidden = true; }
    var prim = $("sheet-primary");
    prim.textContent = opts.primary || "Confirm";
    prim.classList.toggle("danger", !!opts.primaryDanger);
    prim.classList.toggle("success", !!opts.primarySuccess);
    var cancelBtn = $("sheet-cancel");
    cancelBtn.textContent = opts.cancelLabel || "Cancel";
    cancelBtn.classList.toggle("btn-primary", !!opts.cancelFilled);
    cancelBtn.classList.toggle("danger", !!opts.cancelDanger);
    var wrap = $("sheet-input-wrap");
    if (opts.input) {
      wrap.hidden = false;
      $("sheet-input-label").textContent = opts.input.label || "";
      var inp = $("sheet-input");
      inp.value = opts.input.value;
      inp.min = opts.input.min != null ? opts.input.min : "";
      inp.step = opts.input.step || 1;
    } else { wrap.hidden = true; }
    sheetCb = opts.onConfirm;
    sheetCancelCb = opts.onCancel || null;
    sheetSticky = !!opts.stickyBackdrop;
    $("sheet-backdrop").hidden = false;
  }
  function closeSheet() { $("sheet-backdrop").hidden = true; sheetCb = null; sheetCancelCb = null; sheetSticky = false; editSheetOriginal = null; }
  function dismissSheet() { var cb = sheetCancelCb; closeSheet(); if (cb) cb(); }
  function packSummary(pack) {
    var shorts = [];
    pack.forEach(function (r) {
      var oh = qtyOf(r.item);
      if (oh < r.qty) shorts.push(r.name + " " + oh + " of " + r.qty);
    });
    var s = pack.length + " items";
    if (shorts.length) {
      s += " · Short: " + shorts.slice(0, 2).join(" · ");
      if (shorts.length > 2) s += " · +" + (shorts.length - 2) + " more";
    } else { s += " · Nothing short"; }
    return s;
  }
  function showError(msg) {
    var b = $("error-banner"); b.textContent = msg; b.hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function clearError() { $("error-banner").hidden = true; }
  function fmtDate(iso) {
    var d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) +
      ", " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  function b64encode(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = ""; bytes.forEach(function (b) { bin += String.fromCharCode(b); });
    return btoa(bin);
  }
  function b64decode(b64) {
    var bin = atob(String(b64).replace(/\s/g, ""));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function repoCfg() {
    return state.editor
      ? { owner: state.editor.owner, repo: state.editor.repo }
      : { owner: DEFAULT_OWNER, repo: DEFAULT_REPO };
  }
  function ghHeaders() {
    var h = { "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
    if (state.editor && state.editor.token) h["Authorization"] = "Bearer " + state.editor.token;
    return h;
  }

  /* ---------- data load / save ---------- */
  function apiDataUrl() {
    var c = repoCfg();
    return "https://api.github.com/repos/" + c.owner + "/" + c.repo + "/contents/data.json?ref=main&_=" + Date.now();
  }
  function loadData() {
    var demoSnap = DEMO ? readSnapshot() : null;
    return fetch(apiDataUrl(), { headers: ghHeaders(), cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("api " + r.status); return r.json(); })
      .then(function (j) {
        state.sha = j.sha;
        state.data = JSON.parse(b64decode(j.content));
        state.loadedAt = new Date();
      })
      .catch(function () {
        /* Fallback: the Pages-served copy of data.json (lags commits by ~1 min). */
        return fetch("data.json?_=" + Date.now(), { cache: "no-store" })
          .then(function (r) { if (!r.ok) throw new Error("pages " + r.status); return r.json(); })
          .then(function (d) { state.data = d; state.loadedAt = new Date(); });
      })
      .then(function () {
        normalizeData();
        state.loadFailed = false;
        document.body.classList.remove("load-failed");
        $("load-failed").hidden = true;
        state.syncKind = "Loaded";
        /* v3 E4: this loaded state is the base the next save diffs against */
        state.offline = false;
        state.savedData = clone(state.data);
        state.localBase = clone(state.data);
        if (DEMO && demoSnap) {
          state.data = demoSnap.data;
          state.sha = demoSnap.sha || null;
          state.savedData = demoSnap.savedData || clone(demoSnap.data);
          state.localBase = clone(state.data);
        } else {
          persistSnapshot();
        }
        refreshSyncStatus();
      })
      .catch(function () {
        /* v3 E4: no signal but this device has saved before — open on the
           last saved copy and queue any edits as actions */
        var snap = readSnapshot();
        if (snap) {
          state.data = snap.data;
          state.sha = snap.sha || null;
          state.savedData = snap.savedData || null;
          state.localBase = clone(snap.data);
          state.offline = true;
          state.loadedAt = snap.at ? new Date(snap.at) : new Date();
          normalizeData();
          /* The base above was cloned pre-normalization; re-clone after so
             an old snapshot (no recipes keys) diffs empty too, exactly
             like the online path — otherwise the first save would carry a
             phantom recipes migration. */
          state.localBase = clone(state.data);
          state.loadFailed = false;
          document.body.classList.remove("load-failed");
          $("load-failed").hidden = true;
          refreshSyncStatus();
          return;
        }
        /* A failed load must never look like zero stock: show one empty
           state, no quantities, and every screen/action stays hidden. */
        state.loadFailed = true;
        document.body.classList.add("load-failed");
        $("load-failed").hidden = false;
        updateSaveStatus("Couldn't load data");
      });
  }
  function relAgo(d) {
    if (!d) return "";
    var s = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (s < 45) return "now";
    var m = Math.round(s / 60);
    if (m < 60) return m + " min ago";
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  function refreshSyncStatus() {
    var n = saveQueue.length;
    if (n) {
      updateSaveStatus((state.offline ? "Offline" : "Waiting to save") + " · " + n + (n === 1 ? " change" : " changes") + " waiting");
      return;
    }
    if (state.offline) { updateSaveStatus("Offline · last saved copy"); return; }
    if (state.loadedAt) updateSaveStatus((state.syncKind || "Loaded") + " · " + relAgo(state.loadedAt));
  }
  function normalizeData() {
    if (!state.data || typeof state.data !== "object") state.data = L.emptyData();
    if (!state.data.inventory) state.data.inventory = {};
    state.data.settings = L.normalizeSettings(state.data.settings);
    /* Recipe editor (a): the active catalog comes from synced settings —
       set it before filling inventory rows so custom items get rows too.
       Old data without recipes normalizes to the built-ins, so the
       catalog is identical and the next diff is empty (no phantom save). */
    L.setCatalog(state.data.settings.recipes, state.data.settings.customItems);
    Object.keys(L.ITEMS).forEach(function (id) {
      if (!state.data.inventory[id]) state.data.inventory[id] = { qty: 0, threshold: null };
    });
    if (!Array.isArray(state.data.history)) state.data.history = [];
    /* Round 2 item 1 (2026-10-27 MI renames; IDs unchanged): stored
       history freezes display names at pack/count time, so rewrite them
       on load — old backups and old snapshots show the new names, while
       counts and SKUs stay attached to the same item IDs. Runs on every
       load path and on import (both call normalizeData); the bases are
       cloned after normalization, so this creates no phantom save. */
    var RENAMED = { "Tools & supplies tray #2": "Supplies tray #2", "Scrapbook paper pack": "Scrapbook pack", "AY - Special Request": "AY - by request" };
    state.data.history.forEach(function (entry) {
      if (entry.recipe) entry.recipe.forEach(function (ln) {
        if (ln.name && RENAMED[ln.name]) ln.name = RENAMED[ln.name];
      });
      if (typeof entry.title === "string") Object.keys(RENAMED).forEach(function (old) {
        if (entry.title.indexOf(old) >= 0) entry.title = entry.title.split(old).join(RENAMED[old]);
      });
    });
  }
  function settings() {
    if (!state.data.settings) state.data.settings = L.defaultSettings();
    return state.data.settings;
  }
  /* ---------- v3 E4: save engine (actions, queue, merge) ---------- */
  function diffAction(message, from, to) {
    if (!from || !to) return null;
    var deltas = {}, sets = {}, fields = {}, entries = [], replaced = [], removed = [], setKeys = {};
    var fromHist = {}, toHist = {};
    (from.history || []).forEach(function (e) { fromHist[e.id] = e; });
    (to.history || []).forEach(function (e) {
      toHist[e.id] = e;
      if (!fromHist[e.id]) entries.push(e);
      else if (JSON.stringify(fromHist[e.id]) !== JSON.stringify(e)) replaced.push(e);
    });
    (from.history || []).forEach(function (e) { if (!toHist[e.id]) removed.push(e.id); });
    /* An item whose change came with a count-fix entry is an exact SET,
       not a delta — sets are the only conflict-sensitive op */
    var counted = {};
    entries.forEach(function (e) {
      if (e.type !== "count-fix") return;
      if (e.item) counted[e.item] = true;
      (e.effects || []).forEach(function (ef) { counted[ef.item] = true; });
    });
    Object.keys(L.ITEMS).forEach(function (id) {
      var a = from.inventory[id] || { qty: 0, threshold: null };
      var b = to.inventory[id] || { qty: 0, threshold: null };
      if (a.qty !== b.qty) {
        if (counted[id]) sets[id] = { to: b.qty, base: a.qty };
        else deltas[id] = b.qty - a.qty;
      }
      var at = a.threshold != null ? a.threshold : null, bt = b.threshold != null ? b.threshold : null;
      if (at !== bt) fields[id] = { threshold: bt };
    });
    ["features", "boxes", "boxRules", "bins", "recipes", "customItems", "reorderQty", "hideReorderQtys"].forEach(function (k) {
      if (JSON.stringify((from.settings || {})[k]) !== JSON.stringify((to.settings || {})[k])) setKeys[k] = clone((to.settings || {})[k]);
    });
    var empty = !Object.keys(deltas).length && !Object.keys(sets).length && !Object.keys(fields).length &&
      !entries.length && !replaced.length && !removed.length && !Object.keys(setKeys).length;
    if (empty) return null;
    return { id: "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: new Date().toISOString(),
      message: message, deltas: deltas, sets: sets, fields: fields, entries: entries, replaced: replaced, removed: removed, settings: setKeys };
  }
  function putData(data, sha, message) {
    var c = repoCfg();
    var body = { message: message, content: b64encode(JSON.stringify(data, null, 2) + "\n"), branch: "main" };
    if (sha) body.sha = sha;
    return fetch("https://api.github.com/repos/" + c.owner + "/" + c.repo + "/contents/data.json", {
      method: "PUT", headers: ghHeaders(), body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) { var e = new Error("save " + r.status); e.status = r.status; throw e; }
      return r.json();
    }).then(function (j) { return j.content && j.content.sha ? j.content.sha : sha; });
  }
  function getRemote() {
    return fetch(apiDataUrl(), { headers: ghHeaders(), cache: "no-store" })
      .then(function (r) { if (!r.ok) { var e = new Error("api " + r.status); e.status = r.status; throw e; } return r.json(); })
      .then(function (j) { return { data: JSON.parse(b64decode(j.content)), sha: j.sha }; });
  }
  function askCountConflict(itemId, mine, theirs) {
    return new Promise(function (resolve) {
      openSheet({
        title: "Count conflict — " + L.ITEMS[itemId],
        summary: "You counted " + mine + ". While you were offline, " + L.ITEMS[itemId] + " changed on GitHub — it is now " + theirs + ". Which number should stand?",
        primary: "Use my count (" + mine + ")",
        cancelLabel: "Keep " + theirs,
        onConfirm: function () { resolve(true); },
        onCancel: function () { resolve(false); }
      });
    });
  }
  function applyOneAction(d, a) {
    Object.keys(a.deltas || {}).forEach(function (id) { if (d.inventory[id]) d.inventory[id].qty += a.deltas[id]; });
    Object.keys(a.fields || {}).forEach(function (id) { if (d.inventory[id]) d.inventory[id].threshold = a.fields[id].threshold; });
    Object.keys(a.settings || {}).forEach(function (k) { if (!d.settings) d.settings = L.defaultSettings(); d.settings[k] = clone(a.settings[k]); });
    (a.entries || []).forEach(function (e) {
      if (!d.history.some(function (h) { return h.id === e.id; })) d.history.unshift(clone(e));
    });
    (a.replaced || []).forEach(function (e) {
      var i = d.history.findIndex(function (h) { return h.id === e.id; });
      if (i >= 0) d.history[i] = clone(e);
    });
    (a.removed || []).forEach(function (id) {
      d.history = d.history.filter(function (h) { return h.id !== id; });
    });
    var chain = Promise.resolve();
    Object.keys(a.sets || {}).forEach(function (id) {
      chain = chain.then(function () {
        var s = a.sets[id];
        if (!d.inventory[id]) return;
        var cur = d.inventory[id].qty;
        if (cur === s.base) { d.inventory[id].qty = s.to; return; }
        /* The item also changed remotely — the one case that asks */
        return askCountConflict(id, s.to, cur).then(function (mine) {
          if (mine) d.inventory[id].qty = s.to;
        });
      });
    });
    return chain;
  }
  function applyActionsTo(data, actions) {
    var d = clone(data);
    if (!d.inventory) d.inventory = {};
    Object.keys(L.ITEMS).forEach(function (id) { if (!d.inventory[id]) d.inventory[id] = { qty: 0, threshold: null }; });
    if (!Array.isArray(d.history)) d.history = [];
    var chain = Promise.resolve();
    actions.forEach(function (a) { chain = chain.then(function () { return applyOneAction(d, a); }); });
    return chain.then(function () { d.settings = L.normalizeSettings(d.settings); return d; });
  }
  function mergeAndSave(actions, message) {
    return getRemote().then(function (remote) {
      return applyActionsTo(remote.data, actions).then(function (merged) {
        return putData(merged, remote.sha, message).then(function (newSha) {
          state.data = merged;
          normalizeData();
          state.localBase = clone(state.data);
          state.savedData = clone(state.data);
          state.sha = newSha;
          state.loadedAt = new Date();
          state.syncKind = "Saved";
          renderAll();
          persistSnapshot();
          refreshSyncStatus();
        });
      });
    });
  }
  function enqueueAction(action) {
    saveQueue.push(action);
    persistQueue();
    refreshSyncStatus();
  }
  var flushing = false;
  function flushQueue() {
    if (flushing || !saveQueue.length || !state.editor || state.loadFailed) return Promise.resolve();
    if (typeof navigator !== "undefined" && navigator.onLine === false) return Promise.resolve();
    flushing = true;
    var actions = saveQueue.slice();
    var message = actions.length === 1 ? actions[0].message : "Sync of " + actions.length + " offline changes";
    return mergeAndSave(actions, message).then(function () {
      saveQueue = saveQueue.slice(actions.length);
      persistQueue();
      state.offline = false;
      refreshSyncStatus();
      toast(actions.length === 1 ? "Back online — your offline change is saved." : "Back online — " + actions.length + " offline changes saved.");
    }).catch(function (e) {
      if (e && e.name === "TypeError") state.offline = true;
      refreshSyncStatus();
    }).then(function () { flushing = false; });
  }
  function saveData(message) {
    if (DEMO) {
      var demoAction = diffAction(message, state.localBase, state.data);
      if (!demoAction) { state.localBase = clone(state.data); return Promise.resolve(); }
      state.localBase = clone(state.data);
      state.savedData = clone(state.data);
      state.loadedAt = new Date();
      state.syncKind = "Saved";
      persistSnapshot();
      refreshSyncStatus();
      updateSaveStatus("Saved on this device");
      return Promise.resolve();
    }
    if (!state.editor) return Promise.reject(new Error("view-only"));
    var action = diffAction(message, state.localBase, state.data);
    if (!action) { state.localBase = clone(state.data); return Promise.resolve(); }
    if (state.offline || (typeof navigator !== "undefined" && navigator.onLine === false)) {
      state.localBase = clone(state.data);
      enqueueAction(action);
      return Promise.resolve();
    }
    updateSaveStatus("Saving…");
    return putData(state.data, state.sha, message).then(function (newSha) {
      state.sha = newSha;
      state.savedData = clone(state.data);
      state.localBase = clone(state.data);
      state.loadedAt = new Date();
      state.syncKind = "Saved";
      persistSnapshot();
      refreshSyncStatus();
    }).catch(function (e) {
      if (e && (e.status === 409 || e.status === 422)) {
        /* v3 E4: the file moved under us — reload and re-apply this change
           on top instead of overwriting the other save */
        return mergeAndSave([action], message).then(function () { state.localBase = clone(state.data); });
      }
      if (e && e.name === "TypeError") {
        /* The network dropped mid-save: keep the change as a queued action */
        state.offline = true;
        state.localBase = clone(state.data);
        enqueueAction(action);
        return;
      }
      updateSaveStatus("NOT saved — check connection");
      showError("Your change was made on this screen but could NOT be saved to GitHub (" + e.message + "). Do not rely on it until it saves — reload the page to see the true saved status, then try again.");
      throw e;
    });
  }
  function updateSaveStatus(txt) {
    var el = $("save-status");
    el.textContent = txt || "";
    /* v3 D7: at 360 the line only takes header room when it matters —
       a save just landed, is in flight, or failed */
    el.classList.toggle("fresh", /^(Saved|Saving|NOT saved|Couldn|Offline|Waiting)/.test(txt || ""));
  }

  /* ---------- mutations (editor only) ---------- */
  function newEntry(type, title, effects, extra) {
    var e = {
      id: "h" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      ts: new Date().toISOString(), type: type, title: title,
      effects: effects, undone: false
    };
    if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
    return e;
  }
  /* Recipe (c): a pack-time snapshot — each line as {item, name, qty}
     with the name as it stood when packed. Reprint and the History
     effect list read names from it when present; legacy entries
     without one fall back to current names. */
  function snapshotPack(pack, craftId) {
    /* Retest item 8: freeze the Per-6 rate at pack time, so a later
       recipe change can't rewrite an old entry's reprint column.
       Fix-round item 17: freeze the rate (per) the same way, so a
       reprint keeps showing 1/18 after a recipe change. A row's own
       per wins when present; otherwise the 6-kit pack's rate fills in. */
    var per6 = null, per = null;
    if (craftId) {
      per6 = {}; per = {};
      L.computePack(craftId, 6).forEach(function (r) { per6[r.item] = r.qty; per[r.item] = r.per; });
    }
    return pack.map(function (r) {
      var line = { item: r.item, name: r.name, qty: r.qty };
      if (per6) line.per6 = per6[r.item];
      if (r.per !== undefined) line.per = r.per;
      else if (per) line.per = per[r.item];
      return line;
    });
  }
  function snapshotName(entry, itemId) {
    if (entry.recipe) {
      for (var i = 0; i < entry.recipe.length; i++) if (entry.recipe[i].item === itemId) return entry.recipe[i].name;
    }
    return L.ITEMS[itemId] || itemId;
  }
  /* Apply effects + log entry + save. Returns a promise. */
  function commitChange(entry, commitMsg) {
    L.applyEffects(state.data.inventory, entry.effects, +1);
    state.data.history.unshift(entry);
    renderAll();
    return saveData(commitMsg).then(function () { actionToast(entry.title, entry); });
  }
  function requireEditor() {
    if (state.editor) return true;
    showError("This device is view-only. Connect a GitHub token in Settings to make changes from here.");
    return false;
  }

  /* ---------- rendering: shared ---------- */
  /* Pack entries in a craft: pair lines count as two (their A/B entries),
     so converted JCA still shows "9 items" like the old 9 lines did. */
  function craftEntryCount(c) {
    var lines = c.lines || c.items;
    return lines.reduce(function (n, ln) { return n + (Array.isArray(ln.items) ? ln.items.length : 1); }, 0);
  }
  function craftButtons(containerId, selectedId, onPick) {
    var box = $(containerId); box.innerHTML = "";
    L.CRAFTS.forEach(function (c) {
      if (c.hidden) return; /* recipe editor: hidden crafts leave the pickers only */
      var b = document.createElement("button");
      b.className = "craft-btn" + (c.id === selectedId ? " selected" : "");
      /* Polish item 2: the tick column is always rendered (empty when
         unselected), so selecting a craft never steals width from its
         name and never changes the row's height. */
      b.innerHTML = '<span class="craft-check" aria-hidden="true">' + (c.id === selectedId ? "✓" : "") + "</span>" +
        '<span class="craft-text">' + esc(c.name) + "<small>" + esc(c.code) + " · " + craftEntryCount(c) + " items</small></span>";
      b.addEventListener("click", function () { onPick(c.id); });
      box.appendChild(b);
    });
  }
  function qtyOf(itemId) { return state.data.inventory[itemId] ? state.data.inventory[itemId].qty : 0; }
  /* Batch C item 12: manual kits entries are parsed strictly — parseInt
     silently turned 6.5 into 6. strictKits gives NaN for anything that
     isn't a whole number; kitsError names the problem for the field. */
  function strictKits(raw) {
    if (raw === null || raw === undefined || String(raw).trim() === "") return NaN;
    var n = Number(raw);
    return Number.isInteger(n) ? n : NaN;
  }
  /* Item 7: Pack has no stepper (removed in Batch B), so its message
     names only a chip; Bulk keeps the stepper mention. Any value below
     6 (0, negatives like -6, 1–5) says "at least 6", not "multiples". */
  function kitsError(raw, mentionStepper) {
    if (raw === null || raw === undefined || String(raw).trim() === "") return null;
    var n = Number(raw);
    if (!Number.isInteger(n)) return "Kits must be a whole number — decimals aren't allowed.";
    if (n < 6) return "Kits must be at least 6.";
    if (!L.validKits(n)) return "Kits are ordered in multiples of 6 — use " + (mentionStepper ? "the stepper or a chip" : "a chip") + " (6, 12, 18, 24…).";
    return null;
  }

  /* ---------- Packing tab ---------- */
  function markChips(forId, kits) {
    document.querySelectorAll('.kits-chip[data-for="' + forId + '"]').forEach(function (c) {
      c.classList.toggle("selected", parseInt(c.getAttribute("data-kits"), 10) === kits);
    });
  }
  function updatePackProgress() {
    var boxes = $("pack-table").querySelectorAll("tbody input[type=checkbox]");
    var checked = 0;
    boxes.forEach(function (cb) { if (cb.checked) checked++; });
    var total = boxes.length;
    $("pack-progress").textContent = total ? checked + " of " + total + " checked" : "";
    $("pack-progress-fill").style.width = total ? Math.round(checked / total * 100) + "%" : "0";
    var btn = $("btn-complete-pack");
    var kitsNow = strictKits($("pack-kits").value);
    var ready = total > 0 && checked === total;
    btn.disabled = !ready;
    if (!state.packCraft) btn.textContent = "Choose a craft";
    else if (!L.validKits(kitsNow)) btn.textContent = "Choose kits";
    else if (!ready) btn.textContent = "Check " + (total - checked) + " more";
    else btn.textContent = "Complete " + L.sku(state.packCraft, kitsNow);
    $("btn-check-all").textContent = total > 0 && checked === total ? "Uncheck all" : "Check all";
  }
  var packMode = null; /* null until the packer taps Hand pack; "hand" shows the checklist */
  var queueMode = false; /* Packing's Queue mode: pick lines, Add, Print all / Hand pack all */
  var packKitsManual = false; /* kits entered by typing instead of chips */
  var bulkLines = []; /* [{craftId, kits}] queued on the Bulk import tab, in-memory only */
  var packSortBin = false; /* Batch C2: sort the pack list + sheet by bin */
  var packBoxOverride = null; /* null = use the box rule; an array = this order only */
  var packSelKey = null;
  var packKitsTouched = false; /* v2 A1: the kits error shows only after the field is touched */
  var packPrevKits = "", packLargeConfirmed = null; /* Batch C item 12: focus-time value + last confirmed large amount */
  var bulkPrevKits = "", bulkLargeConfirmed = null; /* Batch C item 12, Bulk side */
  /* ---------- multi-craft queue (brief item 1) ---------- */
  /* Lines persist on-device (localStorage) until finished or cleared, so a
     reload never eats a started queue. The single-craft path is untouched:
     the queue sits alongside it, and a queue of one behaves like today. */
  var packQueue = []; /* [{craftId, kits, printed}] in queue order */
  var queueHandIdx = -1; /* line being hand-packed, -1 = not hand-packing a queue */
  var queueHandTotal = 0; /* lines the current hand walk started with (for "Craft N of M") */
  var PACKQUEUE_LS = "alooma-demo.packqueue.v1";
  /* ---------- brief item 3: Packed by / Counted by (Batch B: Settings) ---------- */
  /* Optional names, never blocking. Each is stored per device under its own
     key (the packer and the counter aren't always the same person), set in
     Settings the moment it changes; stored on the History entry and printed
     on the sheet's byline instead of the blank when filled. */
  var PACKBY_LS = "alooma-demo.packedby.v1", COUNTBY_LS = "alooma-demo.countedby.v1";
  function storedBy(key) { try { return (localStorage.getItem(key) || "").trim(); } catch (e) { return ""; } }
  function persistPackQueue() { try { localStorage.setItem(PACKQUEUE_LS, JSON.stringify(packQueue)); } catch (e) { /* private mode etc. */ } }
  function loadPackQueue() {
    try {
      var raw = localStorage.getItem(PACKQUEUE_LS);
      if (!raw) return;
      var arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return;
      packQueue = arr.filter(function (ln) { return ln && L.craftById(ln.craftId) && L.validKits(ln.kits); })
        .map(function (ln) { return { craftId: ln.craftId, kits: ln.kits }; });
    } catch (e) { packQueue = []; }
  }
  function endQueueWalk() { queueHandIdx = -1; queueHandTotal = 0; }
  function queueDupIds() {
    var counts = {};
    packQueue.forEach(function (ln) { counts[ln.craftId] = (counts[ln.craftId] || 0) + 1; });
    var dups = {};
    Object.keys(counts).forEach(function (id) { if (counts[id] > 1) dups[id] = true; });
    return dups;
  }
  function queueLineBoxes(ln) {
    if (!settings().features.boxes) return null;
    return L.boxRuleFor(settings(), ln.craftId, ln.kits);
  }
  function renderQueue() {
    var dups = queueDupIds();
    var wrap = $("pack-queue");
    wrap.innerHTML = "";
    /* Brief item 4: the count lives in the list's header row, beside Clear all. */
    $("pack-queue-count").textContent = packQueue.length;
    if (!packQueue.length) {
      wrap.innerHTML = '<p class="hint">No orders in the queue yet — pick a craft and kit amount above, then tap Queue.</p>';
    }
    packQueue.forEach(function (ln, i) {
      var craft = L.craftById(ln.craftId);
      var row = document.createElement("div");
      row.className = "queue-line" + (dups[ln.craftId] ? " dup" : "");
      /* A4: no printed state — every line's kits stay editable until it is
         printed (which now completes it) or hand-packed. */
      /* Item 6: a manually typed kits value (42, 48, 60…) is not a chip
         value, so without it the select shows 6 while the line still
         holds the real count — and touching it would silently change
         the line. Include the real value in sorted position. */
      var kitOpts = [6, 12, 18, 24, 30, 36];
      if (kitOpts.indexOf(ln.kits) < 0) { kitOpts.push(ln.kits); kitOpts.sort(function (a, b) { return a - b; }); }
      var sel = '<select class="queue-kits" data-qidx="' + i + '" aria-label="Kits for ' + esc(L.sku(ln.craftId, ln.kits)) + '">' +
        kitOpts.map(function (k) { return '<option value="' + k + '"' + (k === ln.kits ? " selected" : "") + ">" + k + "</option>"; }).join("") + "</select>";
      /* Polish item 4: the SKU rides in its own nowrap span, so a queue
         card can never break it as "CAK-" / "18" — the hyphen is a
         break opportunity the browser will otherwise take. */
      row.innerHTML = '<span class="queue-main"><span>' + esc(craft.name) + " · </span>" + sel + "<span> kits · <span class=\"nowrap\">" + esc(L.sku(ln.craftId, ln.kits)) + "</span></span></span>" +
        '<button type="button" class="btn btn-quiet queue-remove" data-qidx="' + i + '" aria-label="Remove ' + esc(L.sku(ln.craftId, ln.kits)) + '">✕</button>';
      wrap.appendChild(row);
    });
    wrap.querySelectorAll(".queue-kits").forEach(function (s) {
      s.addEventListener("change", function () {
        var i = parseInt(s.getAttribute("data-qidx"), 10);
        packQueue[i].kits = parseInt(s.value, 10);
        persistPackQueue(); renderQueue();
      });
    });
    wrap.querySelectorAll(".queue-remove").forEach(function (b) {
      b.addEventListener("click", function () {
        var i = parseInt(b.getAttribute("data-qidx"), 10);
        if (queueHandIdx === i) endQueueWalk();
        else if (queueHandIdx > i) queueHandIdx--;
        packQueue.splice(i, 1);
        persistPackQueue(); renderPack();
      });
    });
    var cur = currentPack();
    $("btn-queue-add").disabled = !cur;
    var qa = $("btn-queue-add");
    if (cur) qa.innerHTML = "Add <span class=\"nowrap\">" + esc(L.sku(cur.craft.id, cur.kits)) + "</span>";
    else qa.textContent = "Add to queue";
    $("btn-queue-print").disabled = !packQueue.length;
    $("btn-queue-hand").disabled = !packQueue.length;
    $("btn-queue-clear").hidden = packQueue.length < 2;
    /* Retest item 4: Queue mode shows only Add + Done. Once Done is
       tapped, the saved queue shows only Print all + Hand pack all —
       they stay visible while the queue has lines, so a saved queue
       never loses Print all. During a walk only Done shows. */
    var walking = queueHandIdx >= 0;
    /* A walk is neither Queue mode nor the saved state: Done must stay
       visible mid-walk even when the walk started from the saved state
       (startHandPackAll never sets queueMode), and the row must stay
       visible for its progress text. */
    var saved = !queueMode && !walking && packQueue.length > 0;
    $("pack-queue-actions").hidden = !queueMode && !saved && !walking;
    $("btn-queue-add").hidden = walking || saved;
    $("btn-queue-done").hidden = saved;
    $("btn-queue-print").hidden = walking || queueMode;
    $("btn-queue-hand").hidden = walking || queueMode;
    /* Item 1 fold-in: the pinned queue row unpins during a walk so it
       never covers the sticky Complete bar (same bottom band). */
    $("pack-queue-actions").classList.toggle("walking", walking);
    $("pack-queue-progress").textContent = walking
      ? "Craft " + (queueHandTotal - packQueue.length + 1) + " of " + queueHandTotal : "";
  }
  function currentBoxes() {
    var cur = currentPack(); if (!cur || !settings().features.boxes) return null;
    if (packBoxOverride !== null) return packBoxOverride.slice();
    return L.boxRuleFor(settings(), cur.craft.id, cur.kits);
  }
  function renderPackBoxes() {
    var cur = currentPack();
    var on = !!cur && settings().features.boxes;
    var rule = on ? L.boxRuleFor(settings(), cur.craft.id, cur.kits) : null;
    var show = on && (rule !== null || packBoxOverride !== null);
    $("pack-boxes").hidden = !show;
    if (!show) { $("pack-boxes-edit").hidden = true; return; }
    var boxes = packBoxOverride !== null ? packBoxOverride : rule;
    $("pack-boxes-text").textContent = boxes.length ? L.boxesText(settings(), boxes) : "None";
  }
  function renderPack() {
    renderQueue();
    craftButtons("pack-crafts", state.packCraft, function (id) {
      if (queueHandIdx >= 0) endQueueWalk(); /* picking a different craft mid-walk ends the walk; queued lines stay */
      state.packCraft = id;
      /* Polish item 5: a pick with a saved queue enters Queue mode, so
         the row shows exactly Add + Done — never the single-actions
         row on top of the saved row (five buttons at once). Also
         covers mid-walk picks, since the walk just ended above. */
      if (packQueue.length > 0 && queueHandIdx < 0) queueMode = true;
      renderPack();
    });
    var rawKits = $("pack-kits").value;
    var kits = strictKits(rawKits);
    markChips("pack", kits);
    /* Chips or the manual box, never both (brief 5a). */
    $("pack-chips").hidden = packKitsManual;
    $("pack-kits-manual").hidden = !packKitsManual;
    var err = $("pack-error"), warn = $("pack-warning");
    err.textContent = ""; warn.hidden = true;
    var valid = L.validKits(kits);
    /* v2 A1: calm first screen — the red kits error appears only once the
       kits field has been touched; until then a muted help line shows.
       Batch C item 12: the message names the actual problem (decimal,
       zero, non-multiple) instead of silently coercing the value. */
    var showKitsErr = !valid && packKitsTouched;
    if (showKitsErr) err.textContent = kitsError(rawKits) || "Enter the number of kits — orders are multiples of 6.";
    $("pack-help").hidden = (state.packCraft && valid) || showKitsErr;
    $("pack-sku").textContent = valid && state.packCraft ? L.sku(state.packCraft, kits) : "—";
    /* Brief 5/6: the picker never collapses — the grid and chips stay open
       with the choice highlighted, and the action row below is the only
       thing that appears once both are chosen. */
    var selKey = state.packCraft + ":" + kits;
    if (selKey !== packSelKey) { packSelKey = selKey; packBoxOverride = null; packMode = null; $("pack-boxes-edit").hidden = true; }
    var tbody = $("pack-table").querySelector("tbody");
    tbody.innerHTML = "";
    if (!valid) {
      updatePackProgress();
      renderPackBoxes();
      renderPackActions();
      return;
    }
    if (!state.packCraft) { updatePackProgress(); renderPackBoxes(); renderPackActions(); return; }
    clearError(); /* v2 A1: a stale banner (e.g. from a Print tap) clears once the selection is valid */
    var pack = L.computePack(state.packCraft, kits);
    var binsOn = settings().features.bins;
    $("btn-pack-sort").hidden = !binsOn;
    $("btn-pack-sort").textContent = packSortBin && binsOn ? "Sorted by bin ✓" : "Sort by bin";
    var rowsPack = pack.slice();
    if (packSortBin && binsOn) {
      rowsPack.sort(function (a, b) {
        var ba = L.binFor(settings(), a.item), bb = L.binFor(settings(), b.item);
        return ba < bb ? -1 : ba > bb ? 1 : 0;
      });
    }
    var shortages = [];
    rowsPack.forEach(function (r, idx) {
      var onHand = qtyOf(r.item);
      if (onHand < r.qty) shortages.push({ name: r.name, have: onHand, need: r.qty, short: r.qty - onHand });
      var tr = document.createElement("tr");
      tr.innerHTML =
        '<td><input type="checkbox" data-idx="' + idx + '" aria-label="Packed: ' + esc(r.name) + '"></td>' +
        '<td><span class="row-name">' + esc(r.name) + "</span>" + (binsOn ? ' <span class="row-bin">' + esc(L.binFor(settings(), r.item)) + "</span>" : "") + "</td>" +
        '<td class="num">' + r.qty + "</td>" +
        '<td class="num' + (onHand < r.qty ? " short" : "") + '">' + onHand + "</td>";
      var cb = tr.querySelector("input");
      cb.addEventListener("change", function () {
        tr.classList.toggle("checked-row", cb.checked);
        updatePackProgress();
      });
      tr.addEventListener("click", function (ev) {
        if (ev.target !== cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event("change")); }
      });
      tbody.appendChild(tr);
    });
    if (shortages.length) {
      /* v3 E1: the toggle carries the total; expanding lists every short
         item on its own line — have / need / short — biggest shortage first */
      shortages.sort(function (a, b) { return b.short - a.short; });
      var lineText = "⚠ " + shortages.length + (shortages.length === 1 ? " item short" : " items short");
      var items = shortages.map(function (s) {
        return "<li>" + esc(s.name) + ": have " + s.have + ", need " + s.need + ", short " + s.short + "</li>";
      }).join("");
      warn.innerHTML = '<button type="button" class="warn-toggle" aria-expanded="false">' + esc(lineText) + '</button>' +
        '<div class="warn-full" hidden><ul class="short-list">' + items + "</ul>" +
        "<p>You can still record this — counts will go below zero so the shortage stays visible.</p></div>";
      var wt = warn.querySelector(".warn-toggle"), wf = warn.querySelector(".warn-full");
      wt.addEventListener("click", function () {
        var open = wf.hidden;
        wf.hidden = !open;
        wt.setAttribute("aria-expanded", open ? "true" : "false");
      });
      warn.hidden = false;
    }
    updatePackProgress();
    renderPackBoxes();
    renderPackActions();
  }
  function currentPack() {
    if (!state.packCraft) return null;
    var kits = strictKits($("pack-kits").value);
    if (!L.validKits(kits)) return null;
    return { craft: L.craftById(state.packCraft), kits: kits, pack: L.computePack(state.packCraft, kits) };
  }
  function completePacking() {
    if (!requireEditor()) return;
    var cur = currentPack(); if (!cur) return;
    var craft = cur.craft;
    var boxes = currentBoxes();
    /* v2 A2: a short order must look different — red block naming each
       shortage and where its count lands, danger primary, filled Go back */
    var shorts = cur.pack.filter(function (r) { return qtyOf(r.item) < r.qty; });
    shorts.sort(function (a, b) { return (b.qty - qtyOf(b.item)) - (a.qty - qtyOf(a.item)); });
    var sheetOpts = {
      title: craft.name,
      sub: cur.kits + " kits · " + L.sku(craft.id, cur.kits),
      summary: packSummary(cur.pack) + (boxes && boxes.length ? " · Boxes: " + L.boxesText(settings(), boxes) : ""),
      primary: "Subtract from inventory",
      onConfirm: function () {
        var by = storedBy(PACKBY_LS);
        var extra = { craftId: craft.id, kits: cur.kits };
        if (by) extra.packedBy = by;
        /* Fix-round item 13: a hand pack is NOT a print — it records as
           "hand-packed" ("Hand packed …"), which the Reprint gate
           (type === "packed") never offers a Reprint for. */
        var entry = newEntry(
          "hand-packed",
          "Hand packed " + craft.name + " — " + cur.kits + " kits (" + L.sku(craft.id, cur.kits) + ")",
          cur.pack.map(function (r) { return { item: r.item, delta: -r.qty }; }),
          extra
        );
        commitChange(entry, "Packed " + L.sku(craft.id, cur.kits));
      }
    };
    if (shorts.length) {
      sheetOpts.extraHtml = '<div class="sheet-short"><p class="sheet-short-title">⚠ ' + shorts.length + (shorts.length === 1 ? " item short" : " items short") + "</p><ul>" +
        shorts.map(function (r) { var have = qtyOf(r.item); return "<li>" + esc(r.name) + ": have " + have + ", need " + r.qty + ", short " + (r.qty - have) + "</li>"; }).join("") + "</ul></div>";
      sheetOpts.primary = "Subtract anyway (" + shorts.length + " short)";
      sheetOpts.primaryDanger = true;
      sheetOpts.cancelLabel = "Go back";
      sheetOpts.cancelFilled = true;
    }
    openSheet(sheetOpts);
  }

  /* ---------- multi-craft queue: start guards + actions ---------- */
  /* Whole-queue shortage first (shared items summed across lines), then the
     duplicate-craft pop-up; both gate Print all and Hand pack all, never the
     act of adding a line. */
  function queueShortages() {
    var need = {};
    packQueue.forEach(function (ln) {
      L.computePack(ln.craftId, ln.kits).forEach(function (r) { need[r.item] = (need[r.item] || 0) + r.qty; });
    });
    var out = [];
    Object.keys(need).forEach(function (item) {
      var have = qtyOf(item);
      if (have < need[item]) out.push({ name: L.ITEMS[item], have: have, need: need[item], short: need[item] - have });
    });
    out.sort(function (a, b) { return b.short - a.short; });
    return out;
  }
  function startQueue(action) {
    var shorts = queueShortages();
    if (shorts.length) {
      openSheet({
        title: "Items short in this queue",
        extraHtml: '<div class="sheet-short"><p class="sheet-short-title">⚠ ' + shorts.length + (shorts.length === 1 ? " item short" : " items short") + "</p><ul>" +
          shorts.map(function (s) { return "<li>" + esc(s.name) + ": have " + s.have + ", need " + s.need + ", short " + s.short + "</li>"; }).join("") + "</ul></div>",
        primary: "Start anyway",
        primaryDanger: true,
        cancelLabel: "Go back",
        cancelFilled: true,
        onConfirm: function () { startQueueAfterShortage(action); }
      });
      return;
    }
    startQueueAfterShortage(action);
  }
  function startQueueAfterShortage(action) {
    var dupNames = Object.keys(queueDupIds());
    if (dupNames.length) {
      var lines = dupNames.map(function (id) {
        var ls = packQueue.filter(function (ln) { return ln.craftId === id; });
        return L.craftById(id).name + " x" + ls.length + " (" + ls.map(function (ln) { return ln.kits + " kits"; }).join(" + ") + ")";
      });
      openSheet({
        title: "Multiple of the same craft detected",
        summary: lines.join(" · ") + ". Was this intentional?",
        primary: "YES",
        primarySuccess: true,
        cancelLabel: "NO",
        cancelDanger: true,
        onConfirm: function () { action(); },
        onCancel: function () { renderQueue(); }
      });
      return;
    }
    action();
  }
  /* A4: Print all prints AND completes every line at print time — stock
     deducts and History logs now, and the queue clears back to single view.
     One toast covers the whole job; its UNDO removes every entry. */
  function printQueueAll() {
    if (!packQueue.length) return;
    clearError();
    var by = storedBy(PACKBY_LS);
    var lines = packQueue.slice();
    var html = lines.map(function (ln) { return packSheetSection(ln.craftId, ln.kits, queueLineBoxes(ln), by); }).join("");
    var entries = lines.map(function (ln) {
      var craft = L.craftById(ln.craftId);
      var pack = L.computePack(ln.craftId, ln.kits);
      var extra = { craftId: ln.craftId, kits: ln.kits, recipe: snapshotPack(pack, ln.craftId) };
      if (by) extra.packedBy = by;
      return newEntry(
        "packed",
        "Packed " + craft.name + " — " + ln.kits + " kits (" + L.sku(ln.craftId, ln.kits) + ")",
        pack.map(function (r) { return { item: r.item, delta: -r.qty }; }),
        extra
      );
    });
    printHtml(html);
    packQueue = [];
    persistPackQueue(); /* A4: a printed queue must not come back on reload */
    endQueueWalk();
    queueMode = false;
    commitPrint(entries, "Printed " + lines.length + (lines.length === 1 ? " order" : " orders"));
  }
  function loadQueueLineIntoPack(i) {
    var ln = packQueue[i];
    state.packCraft = ln.craftId;
    $("pack-kits").value = ln.kits;
    packKitsTouched = true;
    renderPack(); /* the selection change resets packMode — set it after */
    packMode = "hand";
    renderPack();
  }
  /* Clear all: small quiet buttons in the list headers, shown only at 2+
     lines, always confirming first (Clear in red, Cancel the filled
     default). A started walk says so in the confirm; clearing mid-walk
     ends the walk and drops the loaded line, since it was a queue line.
     The bulk pick itself (not yet added) is untouched — only the list clears. */
  function clearQueue() {
    if (!requireEditor()) return;
    if (packQueue.length < 2) return;
    var n = packQueue.length;
    var notes = [];
    if (queueHandIdx >= 0) notes.push("the craft you're hand-packing");
    openSheet({
      title: "Clear all " + n + " crafts?",
      summary: n + " crafts in the queue will be removed" + (notes.length ? ", including " + notes.join(" and ") : "") + ".",
      primary: "Clear",
      primaryDanger: true,
      cancelLabel: "Cancel",
      cancelFilled: true,
      onConfirm: function () {
        var wasWalking = queueHandIdx >= 0;
        packQueue = [];
        endQueueWalk();
        persistPackQueue();
        if (wasWalking) { state.packCraft = null; $("pack-kits").value = ""; packMode = null; }
        renderPack();
      }
    });
  }
  function clearBulk() {
    if (!requireEditor()) return;
    if (bulkLines.length < 2) return;
    var n = bulkLines.length;
    openSheet({
      title: "Clear all " + n + " crafts?",
      summary: n + " crafts in the bulk list will be removed.",
      primary: "Clear",
      primaryDanger: true,
      cancelLabel: "Cancel",
      cancelFilled: true,
      onConfirm: function () { bulkLines = []; renderBulk(); }
    });
  }
  function startHandPackAll() {
    if (!packQueue.length) return;
    queueHandTotal = packQueue.length;
    queueHandIdx = 0;
    loadQueueLineIntoPack(0);
  }
  function completeQueueLine(i, advance) {
    if (!requireEditor()) return;
    var ln = packQueue[i]; if (!ln) return;
    var craft = L.craftById(ln.craftId);
    var pack = L.computePack(ln.craftId, ln.kits);
    var boxes = queueLineBoxes(ln);
    var shorts = pack.filter(function (r) { return qtyOf(r.item) < r.qty; });
    shorts.sort(function (a, b) { return (b.qty - qtyOf(b.item)) - (a.qty - qtyOf(a.item)); });
    var sheetOpts = {
      title: craft.name,
      sub: ln.kits + " kits · " + L.sku(ln.craftId, ln.kits),
      summary: packSummary(pack) + (boxes && boxes.length ? " · Boxes: " + L.boxesText(settings(), boxes) : ""),
      primary: "Subtract from inventory",
      onConfirm: function () {
        var by = storedBy(PACKBY_LS);
        var extra = { craftId: ln.craftId, kits: ln.kits };
        if (by) extra.packedBy = by;
        /* Batch C item 10: remember the removed line + its index so Undo
           can restore the line and step the walk back to it. */
        extra.queueLine = { craftId: ln.craftId, kits: ln.kits };
        extra.queueIndex = i;
        extra.recipe = snapshotPack(pack, ln.craftId);
        /* Fix-round item 13: same as the single hand pack — a walked
           queue line records as "hand-packed", never offered a Reprint. */
        var entry = newEntry(
          "hand-packed",
          "Hand packed " + craft.name + " — " + ln.kits + " kits (" + L.sku(ln.craftId, ln.kits) + ")",
          pack.map(function (r) { return { item: r.item, delta: -r.qty }; }),
          extra
        );
        packQueue.splice(i, 1);
        persistPackQueue();
        commitChange(entry, "Packed " + L.sku(ln.craftId, ln.kits));
        if (advance) {
          if (!packQueue.length) {
            endQueueWalk();
            queueMode = false; /* A4: finishing a walk leaves Queue mode */
            state.packCraft = null; $("pack-kits").value = ""; packMode = null; packKitsTouched = false;
            renderPack();
          } else {
            queueHandIdx = Math.min(i, packQueue.length - 1);
            loadQueueLineIntoPack(queueHandIdx);
          }
        } else {
          renderQueue();
        }
      }
    };
    if (shorts.length) {
      sheetOpts.extraHtml = '<div class="sheet-short"><p class="sheet-short-title">⚠ ' + shorts.length + (shorts.length === 1 ? " item short" : " items short") + "</p><ul>" +
        shorts.map(function (r) { var have = qtyOf(r.item); return "<li>" + esc(r.name) + ": have " + have + ", need " + r.qty + ", short " + (r.qty - have) + "</li>"; }).join("") + "</ul></div>";
      sheetOpts.primary = "Subtract anyway (" + shorts.length + " short)";
      sheetOpts.primaryDanger = true;
      sheetOpts.cancelLabel = "Go back";
      sheetOpts.cancelFilled = true;
    }
    openSheet(sheetOpts);
  }

  /* ---------- Pack path choice + Bulk import tab ---------- */
  /* After craft + kits are chosen on Packing, the packer picks a path: Print
     (print the sheet; Complete appears, unlocked by printing) or Hand pack
     (the on-screen checklist — the only place it shows). Separately, the Bulk
     import tab records orders that were already packed by hand: queue any mix
     of crafts and kit amounts, then record them all in one save. */
  function renderPackActions() {
    /* Batch C item 12: strict parse — parseInt("6.5") is 6, which wrongly
       showed the action buttons for a decimal kits value. */
    var kits = strictKits($("pack-kits").value);
    var hasSel = !!state.packCraft && L.validKits(kits);
    var walking = queueHandIdx >= 0;
    /* Fix-round item 12: a craft with 0 lines can't be printed or
       packed — its single actions hide, and a note says why (shown
       only when the hiding is because of empty, not Queue mode/walk).
       The help text is restored whenever the pick isn't empty, so the
       note never leaks onto a later pick. */
    var empty = hasSel && L.computePack(state.packCraft, kits).length === 0;
    $("pack-single-actions").hidden = !hasSel || empty || queueMode || walking;
    if (empty && !queueMode && !walking) {
      $("pack-help").textContent = "This craft has no items yet — add lines in Settings → Recipes.";
      $("pack-help").hidden = false;
    } else {
      $("pack-help").textContent = "Pick a craft, then the number of kits.";
    }
    /* The checklist shows only while hand-packing (single or walk). */
    $("pack-order").hidden = !(packMode === "hand" && hasSel);
    $("pack-checklist").hidden = packMode !== "hand";
    if (!(hasSel && packMode === "hand")) $("pack-warning").hidden = true;
  }
  function renderBulk() {
    craftButtons("bulk-crafts", state.bulkCraft, function (id) { state.bulkCraft = id; renderBulk(); });
    var rawBulkKits = $("bulk-kits").value;
    var kits = strictKits(rawBulkKits);
    markChips("bulk", kits);
    var err = $("bulk-error"); err.textContent = "";
    var valid = L.validKits(kits);
    $("bulk-sku").textContent = valid && state.bulkCraft ? L.sku(state.bulkCraft, kits) : "—";
    /* Batch C item 12: same strict messages as Packing — decimals and
       zero are named, not coerced or silently ignored. */
    if (state.bulkCraft && rawBulkKits.trim() !== "" && !valid) err.textContent = kitsError(rawBulkKits, true) || "Kits are ordered in multiples of 6 — use the stepper or a chip (6, 12, 18, 24…).";
    renderBulkLines();
  }
  function renderBulkLines() {
    var wrap = $("bulk-lines");
    wrap.innerHTML = "";
    if (!bulkLines.length) {
      wrap.innerHTML = '<p class="hint">No orders added yet — pick a craft and kit amount above, then tap Add.</p>';
    }
    bulkLines.forEach(function (ln, i) {
      var craft = L.craftById(ln.craftId);
      var row = document.createElement("div");
      row.className = "hand-line";
      row.innerHTML = "<span>" + esc(craft.name) + " · " + ln.kits + " kits · " + esc(L.sku(ln.craftId, ln.kits)) + "</span>" +
        '<button type="button" class="btn btn-quiet" data-remove="' + i + '" aria-label="Remove ' + esc(L.sku(ln.craftId, ln.kits)) + '">✕</button>';
      wrap.appendChild(row);
    });
    var add = $("btn-bulk-add");
    var kits = strictKits($("bulk-kits").value);
    /* Fix-round item 12: a 0-line craft can't be bulk-added either. */
    var bulkEmpty = !!state.bulkCraft && L.validKits(kits) && L.computePack(state.bulkCraft, kits).length === 0;
    add.disabled = !(!!state.bulkCraft && L.validKits(kits)) || bulkEmpty;
    if (!state.bulkCraft) { add.textContent = "Pick a craft"; }
    else if (!L.validKits(kits)) { add.textContent = "Choose kits"; }
    else if (bulkEmpty) { add.textContent = "No items yet"; }
    else { add.innerHTML = "Add <span class=\"nowrap\">" + esc(L.sku(state.bulkCraft, kits)) + "</span>"; }
    var rec = $("btn-bulk-record");
    rec.disabled = !bulkLines.length;
    rec.textContent = bulkLines.length
      ? "Record all · " + bulkLines.length + (bulkLines.length === 1 ? " order" : " orders")
      : "Record all";
    $("btn-bulk-clear").hidden = bulkLines.length < 2;
    $("bulk-lines-count").textContent = bulkLines.length;
  }
  function addBulkLine() {
    if (!requireEditor()) return;
    var kits = strictKits($("bulk-kits").value);
    if (!state.bulkCraft || !L.validKits(kits)) return;
    if (!L.computePack(state.bulkCraft, kits).length) return;
    /* Batch C item 3: no prompt while adding — the duplicate check fires
       at Record all only (the old v3 D1 add-time prompt is gone). */
    queueBulkLine(state.bulkCraft, kits);
  }
  /* Brief item 2: after an Add, the new card must clear the toast too,
     not just the bar + nav. Scrolling up only grows the gap to a
     below-bar toast (the bar moves up with the card), so this adjustment
     can't create a new overlap. Phone only: on desktop the toast sits
     at a fixed bottom and this extra scroll can park the action bar
     UNDER the toast — where the next tap hits the toast's UNDO button
     instead of the bar (that exact intercept broke the offline-queue
     suite: Record's center landed on UNDO, undoing the Add). */
  function scrollCardClearOfToast(el) {
    if (!el) return;
    if (window.innerWidth > 700) return;
    var toast = $("toast");
    if (!toast || toast.hidden) return;
    var cr = el.getBoundingClientRect();
    var tr = toast.getBoundingClientRect();
    if (cr.bottom > tr.top - 8) window.scrollBy(0, cr.bottom - tr.top + 8);
  }
  function queueBulkLine(craftId, kits) {
    var line = { craftId: craftId, kits: kits };
    bulkLines.push(line);
    /* v3 D1: clear the picker after each Add, so a second tap on Add
       can't quietly queue the same order twice */
    state.bulkCraft = null;
    $("bulk-kits").value = "";
    renderBulk();
    /* Brief item 2: the new card scrolls fully into view above the bar
       (scroll-margin-bottom in the phone CSS clears bar + nav + toast);
       the toast is placed against the bar's post-scroll position, then
       the card is nudged above the toast if they still touch. */
    var el = $("bulk-lines").lastElementChild;
    if (el) el.scrollIntoView({ block: "nearest" });
    showToast("Added <span class=\"nowrap\">" + esc(L.sku(craftId, kits)) + "</span>", "UNDO", function () {
      var i = bulkLines.indexOf(line);
      if (i >= 0) { bulkLines.splice(i, 1); renderBulk(); }
    }, 8000);
    scrollCardClearOfToast(el);
    /* Item 4: the scroll above can park the bar under the toast — the
       toast was placed against the bar's pre-scroll position, and the
       scroll transitions the bar from in-flow to stuck. Re-place
       against the post-scroll bar, then clear the card again (the bar
       is stuck by now, so the second scroll can't move it under the
       toast again). */
    placeToast();
    scrollCardClearOfToast(el);
    /* Desktop: the fixed bottom toast can park over the Record button,
       so the next tap hits UNDO and silently undoes the Add (the Batch A
       intercept, back via the Batch B header row pushing Record down).
       Scrolling DOWN the document (positive dy) lifts the button up the
       screen, clear of the toast. Phone already places the toast clear
       of the bar, so this is desktop-only. */
    if (window.innerWidth > 700) {
      var rec = $("btn-bulk-record"), toast = $("toast");
      if (rec && toast && !toast.hidden) {
        var rr = rec.getBoundingClientRect(), tr = toast.getBoundingClientRect();
        if (rr.bottom > tr.top && rr.top < tr.bottom) window.scrollBy(0, rr.bottom - tr.top + 8);
      }
    }
  }
  function recordAllBulk() {
    if (!requireEditor()) return;
    if (!bulkLines.length) return;
    var lines = bulkLines.slice();
    /* Aggregate the batch for the confirm summary so shortages account for
       every line, not just one order at a time. */
    var aggByItem = {}, aggPack = [];
    lines.forEach(function (ln) {
      L.computePack(ln.craftId, ln.kits).forEach(function (r) {
        if (aggByItem[r.item]) aggByItem[r.item].qty += r.qty;
        else { var c = { item: r.item, name: r.name, qty: r.qty }; aggByItem[r.item] = c; aggPack.push(c); }
      });
    });
    var skus = lines.map(function (ln) { return L.sku(ln.craftId, ln.kits); });
    /* Batch C item 3: the duplicate check fires here, at Record all only —
       same wording and YES-green / NO-red styling as Packing's check. */
    var bulkCounts = {};
    lines.forEach(function (ln) { bulkCounts[ln.craftId] = (bulkCounts[ln.craftId] || 0) + 1; });
    var bulkDupIds = Object.keys(bulkCounts).filter(function (id) { return bulkCounts[id] > 1; });
    if (bulkDupIds.length) {
      var dlines = bulkDupIds.map(function (id) {
        var ls = lines.filter(function (ln) { return ln.craftId === id; });
        return L.craftById(id).name + " x" + ls.length + " (" + ls.map(function (ln) { return ln.kits + " kits"; }).join(" + ") + ")";
      });
      openSheet({
        title: "Multiple of the same craft detected",
        summary: dlines.join(" · ") + ". Was this intentional?",
        primary: "YES",
        primarySuccess: true,
        cancelLabel: "NO",
        cancelDanger: true,
        onConfirm: function () { openRecordConfirm(); },
        onCancel: function () { renderBulk(); }
      });
      return;
    }
    openRecordConfirm();
    function openRecordConfirm() { openSheet({
      title: "Record all",
      sub: lines.length + (lines.length === 1 ? " order: " : " orders: ") +
        skus.slice(0, 3).join(", ") + (skus.length > 3 ? " +" + (skus.length - 3) + " more" : "") + " · bulk",
      summary: packSummary(aggPack),
      primary: "Subtract from inventory",
      onConfirm: function () {
        /* One history entry per order (Undo/Edit keep working per order),
           applied locally like a delivery, then a SINGLE save for the batch. */
        lines.slice().reverse().forEach(function (ln) {
          var craft = L.craftById(ln.craftId);
          var pack = L.computePack(ln.craftId, ln.kits);
          var entry = newEntry(
            "bulk",
            "Bulk " + craft.name + " — " + ln.kits + " kits (" + L.sku(ln.craftId, ln.kits) + ")",
            pack.map(function (r) { return { item: r.item, delta: -r.qty }; }),
            { craftId: ln.craftId, kits: ln.kits, recipe: snapshotPack(pack, ln.craftId) }
          );
          L.applyEffects(state.data.inventory, entry.effects, +1);
          state.data.history.unshift(entry);
        });
        bulkLines = [];
        renderAll();
        saveData("Bulk " + lines.length + " order(s)").then(function () {
          toast("Recorded " + lines.length + " bulk order" + (lines.length === 1 ? "" : "s") + ".");
        });
      }
    }); }
  }

  /* ---------- Inventory tab ---------- */
  var invOpenItem = null, invPanelMode = "receive";
  var invQuery = "", invFilter = "all";
  var invSortBin = false; /* Batch C2: "By bin" sort toggle */
  function isLow(itemId) {
    var rec = state.data.inventory[itemId];
    return rec && rec.threshold !== null && rec.threshold !== undefined && rec.qty <= rec.threshold;
  }
  function applyInvFilters() {
    var lowCount = 0, outCount = 0, total = 0;
    document.querySelectorAll(".inv-item").forEach(function (row) {
      var itemId = row.getAttribute("data-item");
      var rec = state.data.inventory[itemId];
      var low = isLow(itemId);
      if (low) lowCount++;
      if (rec && rec.qty === 0) outCount++;
      total++;
      var matchName = !invQuery || L.ITEMS[itemId].toLowerCase().indexOf(invQuery) >= 0;
      var matchMode = invFilter === "all" || (invFilter === "low" && low) || (invFilter === "out" && rec && rec.qty === 0);
      row.style.display = matchName && matchMode ? "" : "none";
    });
    document.querySelectorAll("#inventory-groups .inv-group").forEach(function (g) {
      var any = Array.prototype.some.call(g.querySelectorAll(".inv-item"), function (r) { return r.style.display !== "none"; });
      g.style.display = any ? "" : "none";
    });
    $("all-count").textContent = total;
    $("low-count").textContent = lowCount;
    $("out-count").textContent = outCount;
    $("btn-filter-all").setAttribute("aria-pressed", invFilter === "all" ? "true" : "false");
    $("btn-lowfilter").setAttribute("aria-pressed", invFilter === "low" ? "true" : "false");
    $("btn-outfilter").setAttribute("aria-pressed", invFilter === "out" ? "true" : "false");
    $("btn-binfilter").hidden = !settings().features.bins;
    $("btn-binfilter").setAttribute("aria-pressed", invSortBin ? "true" : "false");
  }
  function renderInventory() {
    updateReorderButton();
    var wrap = $("inventory-groups"); wrap.innerHTML = "";
    L.inventoryGroups().forEach(function (g) {
      var div = document.createElement("div"); div.className = "inv-group";
      var html = "<h3><span>" + esc(g.name) + '</span><span class="inv-onhand">On hand</span></h3>';
      var items = g.items.slice();
      if (invSortBin && settings().features.bins) {
        items.sort(function (a, b) {
          var ba = L.binFor(settings(), a), bb = L.binFor(settings(), b);
          return ba < bb ? -1 : ba > bb ? 1 : 0;
        });
      }
      items.forEach(function (itemId) {
        var rec = state.data.inventory[itemId];
        var badge = "";
        if (rec.qty === 0) badge = '<span class="low-badge out-badge">Out of stock</span>';
        else if (isLow(itemId)) badge = '<span class="low-badge">Low · ≤' + rec.threshold + "</span>";
        html +=
          '<div class="inv-item" data-item="' + itemId + '">' +
          '<button type="button" class="inv-main" aria-expanded="' + (invOpenItem === itemId) + '">' +
          '<span class="inv-name">' + esc(L.ITEMS[itemId]) + (L.itemUnit(itemId) ? " (" + esc(L.itemUnit(itemId)) + ")" : "") + "</span>" + badge + (settings().features.bins ? '<span class="inv-bin">' + esc(L.binFor(settings(), itemId)) + "</span>" : "") +
          '<span class="inv-qty">' + rec.qty + "</span>" +
          '<span class="inv-chev" aria-hidden="true">' + (invOpenItem === itemId ? "▾" : "▸") + "</span>" +
          "</button>";
        if (invOpenItem === itemId) {
          var modes = [["receive", "Receive"], ["set", "Set count"], ["warning", "Warning"]];
          if (settings().features.bins) modes.push(["bin", "Bin"]);
          var seg = modes.map(function (m) {
            return '<button type="button" data-mode="' + m[0] + '"' + (invPanelMode === m[0] ? ' class="on"' : "") + ">" + m[1] + "</button>";
          }).join("");
          var placeholder = invPanelMode === "receive" ? "Amount"
            : invPanelMode === "set" ? "Actual count (now " + rec.qty + ")"
            : invPanelMode === "bin" ? "Bin label (now " + L.binFor(settings(), itemId) + ")"
            : "Warn at or below (blank = off)";
          var prefill = invPanelMode === "warning" && rec.threshold !== null && rec.threshold !== undefined ? rec.threshold
            : invPanelMode === "bin" ? (settings().bins[itemId] || "") : "";
          var goLabel = invPanelMode === "receive" ? "Add" : invPanelMode === "set" ? "Set" : "Save";
          html +=
            '<div class="inv-panel editor-only">' +
            '<div class="seg" role="group" aria-label="Action for ' + esc(L.ITEMS[itemId]) + '">' + seg + "</div>" +
            '<div class="inrow"><input type="' + (invPanelMode === "bin" ? "text" : "number") + '" class="inv-panel-input" min="0" step="1" inputmode="' + (invPanelMode === "bin" ? "text" : "numeric") + '" placeholder="' + placeholder + '" value="' + prefill + '">' +
            '<button type="button" class="go inv-panel-go">' + goLabel + "</button></div>" +
            '<div class="panel-note">On hand now: ' + rec.qty + (rec.threshold !== null && rec.threshold !== undefined ? " · low-stock warning at or below " + rec.threshold : " · no low-stock warning") + (settings().features.bins ? " · Bin " + esc(L.binFor(settings(), itemId)) : "") + "</div>" +
            "</div>";
        }
        html += "</div>";
      });
      div.innerHTML = html;
      wrap.appendChild(div);
    });
    wrap.querySelectorAll(".inv-item").forEach(function (row) {
      var itemId = row.getAttribute("data-item");
      var name = L.ITEMS[itemId];
      row.querySelector(".inv-main").addEventListener("click", function () {
        if (invOpenItem === itemId) { invOpenItem = null; }
        else { invOpenItem = itemId; invPanelMode = "receive"; }
        renderInventory();
      });
      var panel = row.querySelector(".inv-panel");
      if (!panel) return;
      panel.querySelectorAll(".seg button").forEach(function (b) {
        b.addEventListener("click", function () { invPanelMode = b.getAttribute("data-mode"); renderInventory(); });
      });
      panel.querySelector(".inv-panel-go").addEventListener("click", function () {
        if (!requireEditor()) return;
        var raw = panel.querySelector(".inv-panel-input").value;
        var v = raw === "" ? null : parseInt(raw, 10);
        if (invPanelMode === "receive") {
          /* Fix-round item 6: parseInt("6.5") is 6, so decimals used to
             sail through as truncated counts, and huge counts had no
             cap. Strict digits + 1–999. (Set mode below is untouched:
             0 stays a legitimate count there.) */
          if (!/^\d+$/.test(raw.trim()) || v <= 0 || v > 999) { showError("Enter how many " + name + " were received (a whole number from 1 to 999)."); return; }
          clearError();
          commitChange(
            newEntry("received", "Received " + v + " × " + name, [{ item: itemId, delta: v }], { item: itemId, amount: v }),
            "Received " + v + " x " + name
          );
        } else if (invPanelMode === "set") {
          if (!Number.isInteger(v) || v < 0) { showError("Enter the actual counted number for " + name + " (0 or more)."); return; }
          var cur = qtyOf(itemId);
          if (v === cur) { toast(name + " is already " + cur + " — nothing to fix."); return; }
          clearError();
          commitChange(
            newEntry("count-fix", "Count fix " + name + ": " + cur + " → " + v, [{ item: itemId, delta: v - cur }], { item: itemId, counted: v }),
            "Count fix " + name + " to " + v
          );
        } else if (invPanelMode === "bin") {
          var binVal = raw.trim();
          clearError();
          if (binVal) settings().bins[itemId] = binVal; else delete settings().bins[itemId];
          renderAll();
          saveData("Bin " + name + " -> " + L.binFor(settings(), itemId))
            .then(function () { toast("Bin for " + name + ": " + L.binFor(settings(), itemId)); });
        } else {
          if (raw !== "" && (!Number.isInteger(v) || v < 0)) { showError("Low-stock warning for " + name + " must be 0 or more, or blank for off."); return; }
          clearError();
          state.data.inventory[itemId].threshold = v;
          renderAll();
          saveData("Low-stock warning " + name + " -> " + (v === null ? "off" : v))
            .then(function () { toast("Warning for " + name + ": " + (v === null ? "off" : "at or below " + v)); });
        }
      });
    });
    applyInvFilters();
  }
  function renderCountEntry() {
    var list = $("count-entry-list"); list.innerHTML = "";
    L.inventoryGroups().forEach(function (g) {
      var head = document.createElement("div");
      head.className = "entry-head";
      head.innerHTML = "<strong>" + esc(g.name) + "</strong>";
      list.appendChild(head);
      g.items.forEach(function (itemId) {
        var row = document.createElement("div"); row.className = "count-row";
        row.setAttribute("data-name", L.ITEMS[itemId].toLowerCase());
        row.innerHTML = "<span>" + esc(L.ITEMS[itemId]) + " (on hand: " + qtyOf(itemId) + ')</span>' +
          '<input type="number" min="0" step="1" data-item="' + itemId + '" placeholder="Counted">';
        list.appendChild(row);
      });
    });
    filterEntryList(list);
  }
  function applyCounts() {
    if (!requireEditor()) return;
    var inputs = $("count-entry-list").querySelectorAll("input[data-item]");
    var changes = [];
    inputs.forEach(function (inp) {
      if (inp.value === "") return;
      var v = parseInt(inp.value, 10);
      var itemId = inp.getAttribute("data-item");
      if (!Number.isInteger(v) || v < 0) return;
      var cur = qtyOf(itemId);
      if (v !== cur) changes.push({ item: itemId, counted: v, delta: v - cur, cur: cur });
    });
    if (!changes.length) { toast("No counts differ from what's on hand — nothing to apply."); return; }
    /* v2 A3: confirm sheet first. A count that differs from on-hand by more
       than 50% either way is flagged amber; on-hand 0 is never flagged
       (user's rule — with everything at 0 it would flag the world). */
    var lines = changes.map(function (ch) {
      var flag = "";
      if (ch.cur !== 0 && Math.abs(ch.counted - ch.cur) > Math.abs(ch.cur) / 2) {
        var pct = Math.round((ch.counted - ch.cur) / Math.abs(ch.cur) * 100);
        flag = ' <span class="flag">(' + (pct > 0 ? "+" : "") + pct + "% — double-check)</span>";
      }
      return "<li>" + esc(L.ITEMS[ch.item]) + ": " + ch.cur + " → " + ch.counted + flag + "</li>";
    }).join("");
    openSheet({
      title: "Set " + changes.length + (changes.length === 1 ? " count?" : " counts?"),
      summary: "Check the new counts — nothing is saved yet.",
      extraHtml: '<ul class="sheet-lines">' + lines + "</ul>",
      primary: "Apply counts",
      cancelLabel: "Edit numbers",
      onConfirm: function () {
        var by = storedBy(COUNTBY_LS);
        var entries = [];
        changes.forEach(function (ch) {
          var extra = { item: ch.item, counted: ch.counted };
          if (by) extra.countedBy = by;
          var entry = newEntry(
            "count-fix",
            "Count fix " + L.ITEMS[ch.item] + ": " + ch.cur + " → " + ch.counted,
            [{ item: ch.item, delta: ch.delta }],
            extra
          );
          /* apply locally without a save per item; one save at the end */
          L.applyEffects(state.data.inventory, entry.effects, +1);
          state.data.history.unshift(entry);
          entries.push(entry);
        });
        $("count-entry").hidden = true;
        renderAll();
        saveData("Count entry: " + entries.length + " item(s) fixed").then(function () {
          batchToast("Counts applied: " + entries.length + " item(s) updated.", entries);
        });
      }
    });
  }
  /* Batch B4: receive a whole delivery on one form — one save, one History entry per item */
  function renderDeliveryEntry() {
    var list = $("delivery-entry-list"); list.innerHTML = "";
    L.inventoryGroups().forEach(function (g) {
      var head = document.createElement("div");
      head.className = "entry-head";
      head.innerHTML = "<strong>" + esc(g.name) + "</strong>";
      list.appendChild(head);
      g.items.forEach(function (itemId) {
        var row = document.createElement("div"); row.className = "count-row";
        row.setAttribute("data-name", L.ITEMS[itemId].toLowerCase());
        row.innerHTML = "<span>" + esc(L.ITEMS[itemId]) + " (on hand: " + qtyOf(itemId) + ')</span>' +
          '<input type="number" min="0" step="1" data-item="' + itemId + '" placeholder="Arrived">';
        list.appendChild(row);
      });
    });
    filterEntryList(list);
  }
  function applyDelivery() {
    if (!requireEditor()) return;
    var inputs = $("delivery-entry-list").querySelectorAll("input[data-item]");
    var received = [];
    /* Fix-round item 6: strict digits + 1–999, and skipped lines are
       named instead of silently dropped (parseInt used to truncate
       "6.5" to 6 and accept huge counts). */
    var skipped = [];
    inputs.forEach(function (inp) {
      if (inp.value === "") return;
      var rawD = inp.value.trim();
      var v = /^\d+$/.test(rawD) ? parseInt(rawD, 10) : NaN;
      if (!Number.isInteger(v) || v <= 0 || v > 999) { skipped.push(L.ITEMS[inp.getAttribute("data-item")] || inp.getAttribute("data-item")); return; }
      received.push({ item: inp.getAttribute("data-item"), amount: v });
    });
    if (!received.length) { toast(skipped.length ? "Nothing saved — skipped (not a whole number from 1 to 999): " + skipped.join(", ") : "Type how many of each item arrived first — nothing to save yet."); return; }
    if (skipped.length) toast("Skipped (not a whole number from 1 to 999): " + skipped.join(", "));
    /* v2 A3: confirm sheet first; an amount over 5× that item's last
       delivery is flagged amber in the list */
    var lines = received.map(function (r) {
      var last = lastDeliveryFor(r.item);
      var onHand = qtyOf(r.item);
      var flag = "";
      if (last > 0 && r.amount > 5 * last) flag = ' <span class="flag">(' + Math.round(r.amount / last) + "× usual)</span>";
      /* v3 D5: no earlier delivery to compare with — flag against on-hand instead */
      else if (last <= 0 && onHand > 0 && r.amount > 5 * onHand) flag = ' <span class="flag">(' + Math.round(r.amount / onHand) + "× on hand)</span>";
      return "<li>" + esc(L.ITEMS[r.item]) + " +" + r.amount + flag + "</li>";
    }).join("");
    openSheet({
      title: "Add " + received.length + (received.length === 1 ? " item" : " items") + " to stock?",
      summary: "Check the amounts — nothing is saved yet.",
      extraHtml: '<ul class="sheet-lines">' + lines + "</ul>",
      primary: "Add to stock",
      cancelLabel: "Edit numbers",
      onConfirm: function () {
        var entries = [];
        received.forEach(function (r) {
          var entry = newEntry(
            "received",
            "Received " + r.amount + " × " + L.ITEMS[r.item],
            [{ item: r.item, delta: r.amount }],
            { item: r.item, amount: r.amount }
          );
          /* apply locally without a save per item; one save at the end */
          L.applyEffects(state.data.inventory, entry.effects, +1);
          state.data.history.unshift(entry);
          entries.push(entry);
        });
        $("delivery-entry").hidden = true;
        renderAll();
        saveData("Delivery: " + received.length + " item(s) received").then(function () {
          batchToast("Delivery saved: " + received.length + " item(s) received.", entries);
        });
      }
    });
  }

  /* ---------- History tab ---------- */
  var TYPE_LABEL = { "received": "Received", "packed": "Packed", "hand-packed": "Hand-packed", "bulk": "Bulk", "count-fix": "Count fix", "import": "Backup import" };
  var TYPE_DOT = { "packed": "#1A7336", "hand-packed": "#20242B", "bulk": "#3A6EA5", "received": "#5C6570", "count-fix": "#8A4B00", "import": "#5C6570" };
  function fmtDateRel(iso) {
    var d = new Date(iso), now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    var yest = new Date(now); yest.setDate(now.getDate() - 1);
    var day = sameDay ? "Today" : d.toDateString() === yest.toDateString() ? "Yesterday"
      : d.toLocaleDateString([], { month: "short", day: "numeric" });
    return day + " " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  function renderHistory() {
    var wrap = $("history-list"); wrap.innerHTML = "";
    if (!state.data.history.length) { wrap.innerHTML = '<p class="hint">No changes logged yet.</p>'; return; }
    state.data.history.forEach(function (entry) {
      var div = document.createElement("div");
      div.className = "history-entry" + (entry.undone ? " undone" : "");
      var eff = entry.effects.map(function (e) {
        return esc(snapshotName(entry, e.item)) + " " + (e.delta > 0 ? "+" : "") + e.delta;
      });
      var summary = eff.slice(0, 3).join(" · ");
      if (eff.length > 3) summary += " · +" + (eff.length - 3) + " more";
      var fullList = eff.length > 3
        ? "<details><summary>Show all " + eff.length + " changes</summary>" + eff.join(" · ") + "</details>" : "";
      var by = entry.packedBy || entry.countedBy;
      div.innerHTML =
        '<div class="history-head"><span class="type-dot" style="background:' + (TYPE_DOT[entry.type] || "#5C6570") + '"></span>' +
        '<span class="history-title">' + esc(entry.title) + (by ? " — by " + esc(by) : "") + "</span>" +
        '<span class="history-date">' + esc(fmtDateRel(entry.ts)) + "</span></div>" +
        (eff.length ? '<div class="history-effects">' + summary + fullList + "</div>" : "") +
        (entry.undone ? '<div class="undone-tag">Undone</div>' : "") +
        /* Batch C A5: Reprint shows on every printed (packed) entry that
           isn't undone — to editors AND viewers — and only there. Bulk
           entries were packed outside the app and never printed, so they
           get no Reprint; neither do entries without a craft/kits pair. */
        (!entry.undone && (state.editor || (entry.type === "packed" && entry.craftId && entry.kits)) ?
          '<div class="history-actions">' +
          (state.editor ? '<button class="btn btn-edit">Edit…</button><button class="btn btn-undo">Undo</button>' : "") +
          (entry.type === "packed" && entry.craftId && entry.kits ? '<button class="btn btn-reprint">Reprint</button>' : "") +
          "</div>" : "");
      wrap.appendChild(div);
      if (!entry.undone && state.editor) {
        div.querySelector(".btn-undo").addEventListener("click", function () { undoEntry(entry); });
        div.querySelector(".btn-edit").addEventListener("click", function () { editEntry(entry); });
      }
      if (!entry.undone && entry.type === "packed" && entry.craftId && entry.kits) {
        var rb = div.querySelector(".btn-reprint");
        if (rb) rb.addEventListener("click", function () {
          /* Reprint recomputes boxes from the CURRENT box rule, keeps the
             entry's own Packed-by name (blank if none was stored — never
             the currently stored name), prints the entry's snapshot rows
             when present (legacy entries recompute from the current
             recipe), and changes nothing: no stock move, no new History
             entry, no save. */
          var boxes = settings().features.boxes ? L.boxRuleFor(settings(), entry.craftId, entry.kits) : null;
          var date = new Date(entry.ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
          printHtml(packSheetSection(entry.craftId, entry.kits, boxes, entry.packedBy, { date: date, reprint: true, pack: entry.recipe }));
        });
      }
    });
  }
  function undoEntry(entry, skipConfirm) {
    if (!requireEditor()) return;
    if (entry.undone) return;
    var doUndo = function () {
      L.applyEffects(state.data.inventory, entry.effects, -1);
      entry.undone = true;
      /* Batch C item 10: undoing a hand-packed queue line restores the
         line and steps the walk back to it. The index is clamped — lines
         completed since may have shifted the queue. A finished walk
         restarts over the restored queue; an active walk keeps its total
         (progress counts remaining lines, as before). */
      var restoredIdx = -1;
      if (entry.queueLine) {
        restoredIdx = Math.min(entry.queueIndex != null ? entry.queueIndex : packQueue.length, packQueue.length);
        packQueue.splice(restoredIdx, 0, { craftId: entry.queueLine.craftId, kits: entry.queueLine.kits });
        persistPackQueue();
      }
      renderAll();
      if (restoredIdx >= 0) {
        queueMode = true;
        if (queueHandIdx < 0) queueHandTotal = packQueue.length;
        queueHandIdx = restoredIdx;
        loadQueueLineIntoPack(restoredIdx);
        activateTab("pack");
      }
      saveData("Undo: " + entry.title).then(function () { toast("Undone: " + entry.title); });
    };
    if (skipConfirm) { doUndo(); return; }
    var eff = entry.effects.map(function (e) {
      return snapshotName(entry, e.item) + " " + (e.delta > 0 ? "+" : "") + e.delta;
    });
    var summary = eff.slice(0, 3).join(" · ") + (eff.length > 3 ? " · +" + (eff.length - 3) + " more" : "");
    openSheet({
      title: "Undo this entry?",
      sub: entry.title,
      summary: "These changes will be reversed exactly: " + summary,
      primary: "Undo — reverse it",
      onConfirm: doUndo
    });
  }
  function replaceEffects(entry, newEffects, newTitle, extraUpdates) {
    /* reverse old, apply new, keep one history entry */
    L.applyEffects(state.data.inventory, entry.effects, -1);
    L.applyEffects(state.data.inventory, newEffects, +1);
    entry.effects = newEffects;
    if (newTitle) entry.title = newTitle;
    if (extraUpdates) Object.keys(extraUpdates).forEach(function (k) { entry[k] = extraUpdates[k]; });
    entry.editedAt = new Date().toISOString();
    renderAll();
    return saveData("Edit history: " + entry.title);
  }
  function editEntry(entry) {
    if (!requireEditor()) return;
    if (entry.type === "received") {
      editSheetOriginal = entry.amount;
      openSheet({
        title: "Edit entry",
        sub: "Received — " + (L.ITEMS[entry.item] || ""),
        summary: "",
        input: { label: "Received quantity", value: entry.amount, min: 1 },
        primary: "Save",
        onConfirm: function (v) {
          if (!Number.isInteger(v) || v <= 0) { toast("Enter a quantity above 0."); return; }
          replaceEffects(entry, [{ item: entry.item, delta: v }],
            "Received " + v + " × " + L.ITEMS[entry.item], { amount: v })
            .then(function () { toast("Entry updated."); });
        }
      });
    } else if (entry.type === "count-fix") {
      editSheetOriginal = entry.counted;
      openSheet({
        title: "Edit entry",
        sub: "Count fix — " + (L.ITEMS[entry.item] || ""),
        summary: "",
        input: { label: "Counted number", value: entry.counted, min: 0 },
        primary: "Save",
        onConfirm: function (c) {
          if (!Number.isInteger(c) || c < 0) { toast("Enter a counted number, 0 or more."); return; }
          var oldDelta = entry.effects[0].delta;
          var before = entry.counted - oldDelta;
          replaceEffects(entry, [{ item: entry.item, delta: c - before }],
            "Count fix " + L.ITEMS[entry.item] + ": " + before + " → " + c, { counted: c })
            .then(function () { toast("Entry updated."); });
        }
      });
    } else if (entry.type === "packed" || entry.type === "hand-packed" || entry.type === "bulk") {
      var craft0 = L.craftById(entry.craftId);
      editSheetOriginal = entry.kits;
      openSheet({
        title: "Edit entry",
        sub: craft0.name + " — currently " + entry.kits + " kits (" + L.sku(entry.craftId, entry.kits) + ")",
        summary: "",
        input: { label: "Number of kits (multiple of 6)", value: entry.kits, min: 6, step: 6 },
        primary: "Save",
        onConfirm: function (k) {
          if (!L.validKits(k)) { toast("Kits must be a multiple of 6."); return; }
          if (k === entry.kits) return;
          var pack = L.computePack(entry.craftId, k);
          var verb = entry.type === "packed" ? "Packed" : entry.type === "bulk" ? "Bulk" : "Hand-packed";
          var craft = L.craftById(entry.craftId);
          /* Recipe (c): an edit re-packs at the new kits, so the
             snapshot refreshes to the new pack (current names) — a
             reprint after an edit must match the edited entry. */
          var updates = { kits: k, recipe: snapshotPack(pack, entry.craftId) };
          /* Batch C item 10: keep a later walk-undo consistent with the
             edit — the restored line carries the edited kit count. */
          if (entry.queueLine) updates.queueLine = { craftId: entry.craftId, kits: k };
          replaceEffects(entry,
            pack.map(function (r) { return { item: r.item, delta: -r.qty }; }),
            verb + " " + craft.name + " — " + k + " kits (" + L.sku(entry.craftId, k) + ")",
            updates)
            .then(function () { toast("Entry updated."); });
        }
      });
    } else {
      toast("This entry type can't be edited — undo it instead.");
    }
  }

  /* ---------- Printing (4x6 thermal labels) ---------- */
  function printHtml(html) {
    $("print-area").innerHTML = html;
    setTimeout(function () { window.print(); }, 60);
  }
  function printDate() {
    return new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }
  /* One craft's 4x6 sheet section. Single print and Print all share this
     builder, so a queue job is exactly the single sheets in queue order. */
  /* Batch C A5: opts = { date, reprint } — a Reprint prints the same
     sheet again with the ORIGINAL date filled in and a REPRINT line last
     in the footer. Normal prints keep a blank Date and no REPRINT line. */
  function packSheetSection(craftId, kits, boxes, by, opts) {
    opts = opts || {};
    var craft = L.craftById(craftId);
    /* Recipe (c): a snapshot reprint renders its frozen rows (names +
       totals). Retest item 8: the Per-6 column comes from the
       snapshot when present — a rate frozen at pack time — and only
       falls back to the current recipe for legacy snapshots without
       per6. */
    var pack = opts.pack || L.computePack(craftId, kits);
    var binsOn = settings().features.bins;
    var sheetPack = pack.slice();
    if (packSortBin && binsOn) {
      sheetPack.sort(function (a, b) {
        var ba = L.binFor(settings(), a.item), bb = L.binFor(settings(), b.item);
        return ba < bb ? -1 : ba > bb ? 1 : 0;
      });
    }
    /* Per-6 column from a 6-kit pack: shape-agnostic (pair lines expand
       to their A/B entries, tier lines compute to 1) and identical to the
       old per-line map for every built-in craft. */
    var per6 = {};
    /* Fix-round item 17: the Per-6 column shows the rate when it isn't
       per-6 ("1/18" for tier18 lines, not a bare "1"). The snapshot's
       frozen per wins; legacy snapshots without per fall back to the
       current recipe's rate, mirroring the per6 fallback. The header
       stays "Per 6". */
    var perRate = {};
    L.computePack(craftId, 6).forEach(function (r) { per6[r.item] = r.qty; perRate[r.item] = r.per; });
    if (opts.pack) opts.pack.forEach(function (r) { if (r.per6 !== undefined) per6[r.item] = r.per6; if (r.per !== undefined) perRate[r.item] = r.per; });
    /* Round 2 item 4: the pack sheet hides 0/0 rows (Per 6 = 0 and
       Total = 0) — the JCA pair's unused tray at 6 kits. Sheet only:
       computePack, the inventory list, the hand-pack checklist and the
       count sheet all still show the row. Unknown rows (no per6 entry)
       are kept, never hidden. */
    sheetPack = sheetPack.filter(function (r) { return per6[r.item] !== 0 || r.qty !== 0; });
    var rows = sheetPack.map(function (r) {
      return '<tr><td class="tick"><span class="tick-box"></span></td><td>' + esc(r.name) + "</td>" +
        (binsOn ? '<td class="bin">' + esc(L.binFor(settings(), r.item)) + "</td>" : "") +
        '<td class="qty regular">' + per6[r.item] + (perRate[r.item] && perRate[r.item] !== 6 ? "/" + perRate[r.item] : "") + '</td><td class="qty">' + r.qty + "</td></tr>";
    }).join("");
    /* New pack-sheet layout (general, no per-craft rules): header line 1
       is the craft name alone; header line 2 is the kits/Order ID/
       Packed by/Date subtitle. Fix-round item 8: Date used to be an 8pt
       absolutely-positioned element on line 1, where it printed ON TOP
       of long titles (Hafrashat Challah unreadable, worse on a filled
       reprint date). It now lives in-flow on line 2, at full subtitle
       size — in-flow text can never overlap the title, and it costs 0pt
       of height (a separate date line would cost ~10.4pt). A reprint
       still shows its ORIGINAL date here. Fix-round item 7: the stray
       " · " after the Order ID blank is gone. The footer is BOXES only
       and is omitted entirely when there are no boxes and it isn't a
       reprint, so a no-boxes sheet has no footer block at all. REPRINT
       stays as its own div last in the footer when present. BOXES uses
       commas on the sheet (the on-screen " + " separator elsewhere is
       untouched). The <br> after the Order ID blank is load-bearing,
       not cosmetic: without it the subtitle's UNWRAPPED width (403pt
       before Date joined line 2, longer now) exceeds the table width,
       and Chrome's auto layout answers by narrowing the Item column
       ~17pt — which wrapped MI's long names to 2 lines each and
       spilled the MI-boxes footer. With the forced break the title cell's max is the 262pt
       craft name, the columns keep their natural widths, and the
       visual result is identical (the subtitle wrapped at exactly this
       point anyway). The space before the <br> is also load-bearing:
       textContent gives a bare <br> no separator at all, so without it
       the subtitle reads "____________Packed by" to the queue tests'
       normalized-text assertions. */
    var foot = "";
    if ((boxes && boxes.length) || opts.reprint) {
      foot = '<div class="print-foot">' + (boxes && boxes.length ? '<span class="foot-boxes">BOXES: ' + esc(boxes.join(", ")) + "</span>" : "") +
        (opts.reprint ? "<div>REPRINT</div>" : "") + "</div>";
    }
    return '<section class="print-page pack-sheet"><table><thead>' +
      '<tr class="p-title"><th colspan="' + (binsOn ? 5 : 4) + '"><div class="label-title-row"><div class="label-title">' + esc(craft.name) + "</div></div>" +
      '<div class="label-sub">Total kits: ' + kits + " · Order ID: ____________ <br>Packed by: " + (by ? esc(by) : "________") + " · Date: " + (opts.date ? esc(opts.date) : "________") + "</div>" +
      "</th></tr>" +
      "<tr><th class='tick'></th><th>Item</th>" + (binsOn ? "<th>Bin</th>" : "") + "<th class='qty'>Per 6</th><th class='qty'>Total</th></tr></thead>" +
      "<tbody>" + rows + "</tbody></table>" + foot + "</section>";
  }
  /* A4: single Print prints this one craft's sheet and completes it at the
     same moment — stock deducts and History logs at print time. A short
     order still asks first ("Print anyway"); a covered order prints at once.
     The pick clears afterward so a second tap can't double-deduct. */
  function printSingle() {
    if (!requireEditor()) return;
    var cur = currentPack(); if (!cur || !cur.pack.length) return;
    var craft = cur.craft;
    var boxes = currentBoxes();
    var shorts = cur.pack.filter(function (r) { return qtyOf(r.item) < r.qty; });
    shorts.sort(function (a, b) { return (b.qty - qtyOf(b.item)) - (a.qty - qtyOf(a.item)); });
    function doPrint() {
      clearError();
      var by = storedBy(PACKBY_LS);
      var extra = { craftId: craft.id, kits: cur.kits, recipe: snapshotPack(cur.pack, craft.id) };
      if (by) extra.packedBy = by;
      var entry = newEntry(
        "packed",
        "Packed " + craft.name + " — " + cur.kits + " kits (" + L.sku(craft.id, cur.kits) + ")",
        cur.pack.map(function (r) { return { item: r.item, delta: -r.qty }; }),
        extra
      );
      printHtml(packSheetSection(craft.id, cur.kits, boxes, by));
      state.packCraft = null; $("pack-kits").value = ""; packMode = null; packKitsTouched = false;
      commitPrint([entry], "Printed " + L.sku(craft.id, cur.kits));
    }
    if (shorts.length) {
      openSheet({
        title: craft.name,
        sub: cur.kits + " kits · " + L.sku(craft.id, cur.kits),
        summary: packSummary(cur.pack) + (boxes && boxes.length ? " · Boxes: " + L.boxesText(settings(), boxes) : ""),
        extraHtml: '<div class="sheet-short"><p class="sheet-short-title">⚠ ' + shorts.length + (shorts.length === 1 ? " item short" : " items short") + "</p><ul>" +
          shorts.map(function (r) { var have = qtyOf(r.item); return "<li>" + esc(r.name) + ": have " + have + ", need " + r.qty + ", short " + (r.qty - have) + "</li>"; }).join("") + "</ul></div>",
        primary: "Print anyway",
        primaryDanger: true,
        cancelLabel: "Go back",
        cancelFilled: true,
        onConfirm: doPrint
      });
      return;
    }
    doPrint();
  }
  function printInventory(mode) {
    var binsOn = settings().features.bins;
    var date = printDate();
    /* Fix-round item 3: printed sheets use AT OR UNDER, matching the
       screen badge and the README ("at or below"). The old strict <
       left an at-threshold item unflagged in print only. */
    function isLow(itemId) {
      var rec = state.data.inventory[itemId];
      return !!(rec && rec.threshold !== null && rec.threshold !== undefined && rec.qty <= rec.threshold);
    }
    var sections = L.inventoryGroups().map(function (g) {
      var items = g.items.slice();
      if (mode === "count" && binsOn && invSortBin) {
        items.sort(function (a, b) {
          var ba = L.binFor(settings(), a), bb = L.binFor(settings(), b);
          return ba < bb ? -1 : ba > bb ? 1 : 0;
        });
      }
      var rows = items.map(function (itemId) {
        var low = isLow(itemId);
        var name = (low ? '<span class="low-tag">LOW</span> ' : "") + esc(L.ITEMS[itemId]) + (L.itemUnit(itemId) ? " (" + esc(L.itemUnit(itemId)) + ")" : "");
        if (mode === "count") {
          return '<tr' + (low ? ' class="low"' : "") + "><td>" + name + "</td>" +
            (binsOn ? '<td class="bin">' + esc(L.binFor(settings(), itemId)) + "</td>" : "") +
            '<td class="qty regular">' + qtyOf(itemId) + '</td><td class="counted-cell"></td></tr>';
        }
        return '<tr' + (low ? ' class="low"' : "") + "><td>" + name + '</td><td class="qty">' + qtyOf(itemId) + "</td></tr>";
      }).join("");
      var cols = mode === "count" ? (binsOn ? 4 : 3) : 2;
      var headRow = mode === "count"
        ? "<tr><th>Item</th>" + (binsOn ? "<th>Bin</th>" : "") + "<th class='qty'>Should be</th><th>Counted</th></tr>"
        : "<tr><th>Item</th><th class='qty'>On hand</th></tr>";
      return '<section class="print-page"><table><thead>' +
        '<tr class="p-title"><th colspan="' + cols + '"><div class="label-title">' + esc(g.name) + '</div><div class="label-sub">' + (mode === "count" ? "Count sheet · " : "Inventory · ") + date + "</div></th></tr>" +
        headRow + "</thead><tbody>" + rows + "</tbody></table></section>";
    });
    /* Brief item 4: the count footer prints ONCE, after the last section —
       in flow inside it, so it either sits under the last table or, kept
       whole by break-inside: avoid, flows onto one final label. */
    if (mode === "count") {
      var by = storedBy(COUNTBY_LS);
      var footHtml = '<div class="print-foot"><div>Counted by: ' + (by ? esc(by) : "____________________") + '</div><div>Date: ____________</div></div>';
      sections[sections.length - 1] = sections[sections.length - 1].replace(/<\/section>$/, footHtml + "</section>");
    }
    printHtml(sections.join(""));
  }

  /* ---------- v3 E2: reorder list ---------- */
  function reorderItems() {
    var out = [];
    /* Reorder quantity setting: a valid positive integer replaces the
       2 × warning level − on hand default for every low item. Unset,
       null, or invalid values fall back to the formula, so old data
       (no key at all) behaves exactly as before. */
    var rq = settings().reorderQty;
    var fixed = (typeof rq === "number" && Number.isInteger(rq) && rq > 0) ? rq : null;
    L.inventoryGroups().forEach(function (g) {
      g.items.forEach(function (itemId) {
        var rec = state.data.inventory[itemId];
        if (rec && rec.threshold !== null && rec.threshold !== undefined && rec.qty <= rec.threshold) {
          out.push({ item: itemId, name: L.ITEMS[itemId], group: g.name, qty: rec.qty, level: rec.threshold, order: fixed !== null ? fixed : Math.max(0, rec.threshold * 2 - rec.qty) });
        }
      });
    });
    return out;
  }
  function updateReorderButton() {
    var b = $("btn-reorder");
    if (!b) return;
    var n = reorderItems().length;
    b.textContent = "Reorder · " + n;
    b.disabled = n === 0;
  }
  function renderReorderPanel() {
    var list = $("reorder-list"); list.innerHTML = "";
    var items = reorderItems();
    if (!items.length) {
      list.innerHTML = '<p class="hint">Nothing is at or under its warning level right now.</p>';
      return;
    }
    items.forEach(function (r) {
      var row = document.createElement("div"); row.className = "count-row";
      row.innerHTML = "<span>" + esc(r.name) + " (on hand: " + r.qty + " · warning at " + r.level + ')</span>' +
        '<input type="number" min="0" step="1" data-item="' + r.item + '" value="' + r.order + '" aria-label="Order quantity for ' + esc(r.name) + '">';
      list.appendChild(row);
    });
  }
  function printReorder() {
    var qtys = {};
    $("reorder-list").querySelectorAll("input[data-item]").forEach(function (inp) {
      var v = parseInt(inp.value, 10);
      qtys[inp.getAttribute("data-item")] = Number.isInteger(v) && v >= 0 ? v : 0;
    });
    var groups = {}, order = [];
    reorderItems().forEach(function (r) {
      if (!groups[r.group]) { groups[r.group] = []; order.push(r.group); }
      groups[r.group].push(r);
    });
    /* Reorder print option (separate from the quantity setting): with
       quantities hidden the printed list is just the group name and the
       item names — no on-hand, warning-level, or order numbers. */
    var hideQtys = !!settings().hideReorderQtys;
    var date = printDate();
    var html = order.map(function (g) {
      var rows = groups[g].map(function (r) {
        if (hideQtys) return "<tr><td>" + esc(r.name) + "</td></tr>";
        return "<tr><td>" + esc(r.name) + '</td><td class="qty">' + r.qty + '</td><td class="qty regular">' + r.level + '</td><td class="qty">' + (qtys[r.item] != null ? qtys[r.item] : r.order) + "</td></tr>";
      }).join("");
      return '<section class="print-page"><table><thead>' +
        '<tr class="p-title"><th colspan="' + (hideQtys ? 1 : 4) + '"><div class="label-title">' + esc(g) + '</div><div class="label-sub">Reorder list · ' + date + "</div></th></tr>" +
        (hideQtys ? "<tr><th>Item</th></tr>" : "<tr><th>Item</th><th class='qty'>On hand</th><th class='qty'>Warning level</th><th class='qty'>Order qty</th></tr>") + "</thead>" +
        "<tbody>" + rows + "</tbody></table></section>";
    }).join("");
    printHtml(html);
  }

  /* ---------- Settings: connect / disconnect / backup ---------- */
  /* Batch C item 15: each tab is a history step (#pack, #bulk, …) so the
     phone Back button goes to the previous tab. User tab switches
     pushState (in requestTab); programmatic switches — the applyTabAccess
     fallback, a popstate Discard — only replaceState, never adding an
     entry. pushState/replaceState never fire hashchange, so the handler
     below only ever sees browser Back/forward presses. */
  var userNavigated = false; /* any user tab switch or hash navigation yet */
  var leaveFromHash = false; /* the open leave prompt came from Back/forward */
  var suppressHashNav = false; /* ignore the hashchange a Stay forward() causes */
  function pushTabState(name) {
    try { var h = "#" + name; if (window.location.hash !== h) history.pushState(null, "", h); } catch (e) {}
  }
  function syncTabHash(name) {
    try { var h = "#" + name; if (window.location.hash !== h) history.replaceState(null, "", h); } catch (e) {}
  }
  function activateTab(name) {
    document.querySelectorAll("#tabs button").forEach(function (x) {
      var on = x.getAttribute("data-tab") === name;
      x.classList.toggle("active", on);
      x.setAttribute("aria-selected", on ? "true" : "false");
    });
    document.querySelectorAll(".tab-panel").forEach(function (x) { x.classList.toggle("active", x.id === "tab-" + name); });
    if (name === "settings") renderBackupNote();
    currentTab = name;
    syncTabHash(name);
    /* Item 7: Bulk kit chips visible on open (phone) — if the chips row
       lands under the sticky action bar on activation, scroll just
       enough to clear it. Activation only, never in renderBulk, so
       typing never yanks the page. */
    if (name === "bulk" && window.innerWidth <= 700) {
      var chips = $("bulk-chips"), bar = document.querySelector("#tab-bulk .action-bar");
      if (chips && bar) {
        var cr = chips.getBoundingClientRect(), br = bar.getBoundingClientRect();
        if (cr.bottom > br.top) window.scrollBy(0, cr.bottom - br.top + 8);
      }
    }
  }
  /* ---------- A3: one leave rule for every tab ---------- */
  /* Nothing clears silently anymore. If anything is chosen or unsaved —
     a Pack pick, a queue, a Bulk list, an open inventory edit, or a name
     typed in Settings but not yet saved — switching to ANY other tab asks
     "Discard" or "Stay and finish". Discard clears it all and switches;
     Stay keeps you there with everything exactly as it was. The same rule
     feeds beforeunload (the browser's own prompt) and, in Batch C, the
     Back-button hash steps. Settings toggles save the instant they change,
     so they are never "unsaved"; the Names fields save on change (blur),
     so a typed-but-unblurred name IS unsaved until it saves. */
  var currentTab = "pack";
  var editSheetOriginal = null; /* set by editEntry; cleared by closeSheet */
  function clearPackQueueAndWalk() {
    packQueue = [];
    endQueueWalk();
    persistPackQueue();
  }
  function panelInputDirty() {
    var inp = document.querySelector(".inv-panel-input");
    if (!inp || invOpenItem === null) return false;
    var rec = state.data.inventory[invOpenItem];
    var prefill = "";
    if (invPanelMode === "warning") prefill = (rec && rec.threshold !== null && rec.threshold !== undefined) ? String(rec.threshold) : "";
    else if (invPanelMode === "bin") prefill = (settings().bins && settings().bins[invOpenItem]) || "";
    var v = invPanelMode === "bin" ? inp.value.trim() : inp.value;
    return v !== prefill;
  }
  function entryInputsDirty() {
    /* Only OPEN forms count: Cancel hides a form but leaves its typed
       values in the DOM until the next open re-renders fresh inputs, and
       a hidden form is cancelled work, not work in progress. Counting
       hidden forms broke test-ui's inventory -> pack switch after the
       D5 count block (stale heat-gun value in the hidden count form
       fired the guard). */
    var dirty = false;
    if (!$("count-entry").hidden) document.querySelectorAll("#count-entry-list input[data-item]").forEach(function (inp) {
      if (inp.value !== "") dirty = true;
    });
    if (!$("delivery-entry").hidden) document.querySelectorAll("#delivery-entry-list input[data-item]").forEach(function (inp) {
      if (inp.value !== "") dirty = true;
    });
    return dirty;
  }
  function editSheetDirty() {
    if ($("sheet-backdrop").hidden || editSheetOriginal === null) return false;
    if ($("sheet-input-wrap").hidden) return false;
    return parseInt($("sheet-input").value, 10) !== editSheetOriginal;
  }
  function hasUnsavedInvHist() { return panelInputDirty() || entryInputsDirty() || editSheetDirty(); }
  function discardInvHistChanges() {
    invOpenItem = null;
    document.querySelectorAll("#count-entry-list input[data-item], #delivery-entry-list input[data-item]").forEach(function (inp) { inp.value = ""; });
    /* Discard clears the open forms themselves, not just their inputs — an
       emptied form left open after Discard reads as still-in-progress. */
    $("count-entry").hidden = true;
    $("delivery-entry").hidden = true;
    dismissSheet();
    renderInventory();
  }
  function saveSheetState() {
    if ($("sheet-backdrop").hidden) return null;
    return {
      title: $("sheet-title").textContent,
      sub: $("sheet-sub").textContent,
      summary: $("sheet-summary").textContent,
      extraHtml: $("sheet-extra").innerHTML,
      primary: $("sheet-primary").textContent,
      primaryDanger: $("sheet-primary").classList.contains("danger"),
      cancelLabel: $("sheet-cancel").textContent,
      cancelFilled: $("sheet-cancel").classList.contains("btn-primary"),
      cancelDanger: $("sheet-cancel").classList.contains("danger"),
      input: $("sheet-input-wrap").hidden ? null : { label: $("sheet-input-label").textContent, value: $("sheet-input").value, min: $("sheet-input").min, step: $("sheet-input").step },
      onConfirm: sheetCb,
      onCancel: sheetCancelCb,
      editOriginal: editSheetOriginal
    };
  }
  function restoreSheetState(s) {
    if (!s) return;
    openSheet(s);
    editSheetOriginal = s.editOriginal;
  }
  function requestTab(name) {
    if (name === currentTab) return;
    userNavigated = true;
    if (hasUnsaved()) {
      var saved = saveSheetState();
      /* leaveFromHash stays as the hashchange handler set it (true for a
         Back/forward prompt, false for a tab click) — it decides below
         whether Discard pushes a new entry or not. */
      openSheet({
        title: "Unsaved changes",
        summary: "You have unsaved changes.",
        primary: "Stay and finish",
        cancelLabel: "Discard",
        cancelDanger: true,
        onConfirm: function () {
          restoreSheetState(saved);
          /* A prompt opened by Back/forward must also restore the
             history position — forward() returns to the entry Back
             came from, and the suppress flag swallows its hashchange. */
          if (leaveFromHash) {
            leaveFromHash = false;
            suppressHashNav = true;
            try { history.forward(); } catch (e) {}
          }
        },
        onCancel: function () {
          var fromHash = leaveFromHash;
          leaveFromHash = false;
          discardAllUnsaved();
          /* History is already AT the target entry after a Back press,
             so Discard must not push — only a tab click adds an entry. */
          if (!fromHash) pushTabState(name);
          activateTab(name);
        }
      });
      return;
    }
    pushTabState(name);
    activateTab(name);
  }
  function settingsDirty() {
    var packed = $("set-packed-by"), counted = $("set-counted-by");
    if (packed && packed.value !== storedBy(PACKBY_LS)) return true;
    if (counted && counted.value !== storedBy(COUNTBY_LS)) return true;
    return false;
  }
  /* Fix-round item 2: a SAVED queue is not unsaved work — its lines are
     already in localStorage the moment they are added, so leaving with
     only a saved queue never prompts. What prompts is a half-finished
     pick (craft/kits chosen, not yet added), a walk in progress, a bulk
     list, an open inventory/history edit, or a dirty setting. */
  function hasUnsaved() {
    return !!state.packCraft || $("pack-kits").value !== "" ||
      queueHandIdx >= 0 || bulkLines.length > 0 ||
      hasUnsavedInvHist() || settingsDirty();
  }
  /* Fix-round item 2: Discard drops ONLY the half-finished work — the
     pick, the walk position, the bulk list, open edits. It never touches
     the saved queue lines (they survive Discard and reload). */
  function discardAllUnsaved() {
    state.packCraft = null; $("pack-kits").value = ""; packMode = null; packBoxOverride = null; packKitsTouched = false;
    endQueueWalk(); queueMode = false;
    state.bulkCraft = null; $("bulk-kits").value = ""; bulkLines = [];
    discardInvHistChanges();
    renderAll(); /* re-renders Settings inputs from stored values, too */
  }
  /* View-only devices see ONLY Inventory and History (the user's rule). The
     connect screen stays reachable by tapping the header badge. */
  function applyTabAccess() {
    var editor = !!state.editor;
    document.querySelectorAll("#tabs button").forEach(function (b) {
      var t = b.getAttribute("data-tab");
      /* A2: the Bulk tab is opt-in (default OFF) even for editors. */
      b.hidden = (!editor && t !== "inventory" && t !== "history") ||
        (t === "bulk" && !(settings().features && settings().features.bulkTab));
    });
    var active = document.querySelector("#tabs button.active");
    if (active && active.hidden) activateTab(editor ? "pack" : "inventory");
  }
  function renderSettings() {
    var status = $("settings-conn-status");
    var badge = $("conn-badge");
    if (state.editor) {
      badge.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5"/></svg> Editor';
      badge.className = "badge badge-editor";
      document.body.classList.remove("view-only");
      status.innerHTML = "This device is connected as editor" +
        (state.editor.login ? " (<strong>@" + esc(state.editor.login) + "</strong>)" : "") +
        " for repo <strong>" + esc(state.editor.owner + "/" + state.editor.repo) + "</strong>. Changes made here are saved to that repo.";
      $("connect-form").hidden = true;
      $("disconnect-wrap").hidden = false;
    } else {
      badge.textContent = "View only";
      badge.className = "badge badge-view";
      document.body.classList.add("view-only");
      status.innerHTML = "This device is <strong>view-only</strong>: it can see Inventory and History only. To make changes from this device, connect it once — sign in with GitHub or paste a token; the sign-in is saved on this device only, and you can disconnect it any time here in Settings.";
      $("connect-form").hidden = false;
      $("disconnect-wrap").hidden = true;
    }
    /* v3 D6: viewers get the Print button at the right end of the chip
       row — the 48px editor action row is not spent on one icon for them */
    var pwrap = document.querySelector(".print-menu-wrap");
    var ptarget = state.editor ? document.querySelector(".inv-actions") : document.querySelector(".inv-filters");
    if (pwrap && ptarget && pwrap.parentElement !== ptarget) ptarget.appendChild(pwrap);
    $("device-login").hidden = !GH_APP_CLIENT_ID;
    applyTabAccess();
    renderBackupNote();
    $("about-repo").textContent = repoCfg().owner + "/" + repoCfg().repo;
    document.querySelectorAll(".editor-note").forEach(function (n) { /* visibility via body.view-only CSS on siblings; notes shown by CSS */ });
  }
  function connectDevice() {
    var token = $("gh-token").value.trim();
    var owner = $("gh-owner").value.trim() || DEFAULT_OWNER;
    var repo = $("gh-repo").value.trim() || DEFAULT_REPO;
    var err = $("connect-error"); err.textContent = "";
    if (!token) { err.textContent = "Paste a GitHub token first."; return; }
    var headers = { "Accept": "application/vnd.github+json", "Authorization": "Bearer " + token };
    fetch("https://api.github.com/user", { headers: headers })
      .then(function (r) { if (!r.ok) throw new Error("Token was rejected by GitHub (" + r.status + ")."); return r.json(); })
      .then(function (u) {
        return fetch("https://api.github.com/repos/" + owner + "/" + repo + "/contents/data.json?ref=main", { headers: headers })
          .then(function (r) {
            if (!r.ok) throw new Error("Token works, but it can't read " + owner + "/" + repo + " (" + r.status + "). Check the repo name and that the token has Contents access to it.");
            return u;
          });
      })
      .then(function (u) {
        state.editor = { token: token, owner: owner, repo: repo, login: u.login || "" };
        try { localStorage.setItem(LS_KEY, JSON.stringify(state.editor)); } catch (e) { /* private mode etc. */ }
        $("gh-token").value = "";
        clearError();
        return loadData();
      })
      .then(function () {
        renderAll();
        toast("Connected — this device can now edit.");
      })
      .catch(function (e) { err.textContent = e.message; });
  }
  function disconnectDevice() {
    /* v2 A6: the last pop-ups move into the in-app sheet */
    openSheet({
      title: "Disconnect this device?",
      summary: "The site becomes view-only here (Inventory and History only). Your data in the repo is not touched.",
      primary: "Disconnect",
      onConfirm: function () {
        state.editor = null;
        try { localStorage.removeItem(LS_KEY); } catch (e) {}
        state.sha = null;
        loadData().then(function () { renderAll(); toast("Disconnected — this device is view-only now."); });
      }
    });
  }
  /* ---------- GitHub App device sign-in (no token to paste) ---------- */
  /* Public client ID of the "Alooma Packing" GitHub App (alooma repo only,
     Contents read/write, device flow on, user tokens non-expiring). Empty =
     the sign-in block stays hidden and the token path is the only connect. */
  var GH_APP_CLIENT_ID = "";
  var devicePoll = null;
  function stopDeviceLogin() {
    if (devicePoll) { clearTimeout(devicePoll); devicePoll = null; }
    $("device-login-wait").hidden = true;
    $("btn-gh-login").disabled = false;
  }
  function startDeviceLogin() {
    var err = $("connect-error"); err.textContent = "";
    stopDeviceLogin();
    fetch("https://github.com/login/device/code", {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: GH_APP_CLIENT_ID })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.device_code) throw new Error((d && d.error_description) || "GitHub did not return a sign-in code.");
      $("device-code").textContent = d.user_code;
      $("device-login-wait").hidden = false;
      $("btn-gh-login").disabled = true;
      var interval = (d.interval || 5) * 1000;
      var deadline = Date.now() + (d.expires_in || 900) * 1000;
      var poll = function () {
        if (Date.now() > deadline) { stopDeviceLogin(); err.textContent = "That code expired — tap Connect with GitHub to get a new one."; return; }
        fetch("https://github.com/login/oauth/access_token", {
          method: "POST",
          headers: { "Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: GH_APP_CLIENT_ID, device_code: d.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" })
        }).then(function (r) { return r.json(); }).then(function (t) {
          if (t.access_token) { finishDeviceLogin(t.access_token); return; }
          if (t.error === "authorization_pending") { devicePoll = setTimeout(poll, interval); return; }
          if (t.error === "slow_down") { interval += 5000; devicePoll = setTimeout(poll, interval); return; }
          stopDeviceLogin();
          err.textContent = t.error === "access_denied" ? "The sign-in was denied on GitHub." : (t.error_description || "GitHub sign-in failed (" + t.error + ").");
        }).catch(function () { devicePoll = setTimeout(poll, interval); });
      };
      devicePoll = setTimeout(poll, interval);
    }).catch(function () {
      err.textContent = "Couldn't reach GitHub to start the sign-in. If this keeps happening, connect with a token instead (below).";
    });
  }
  function finishDeviceLogin(token) {
    stopDeviceLogin();
    var headers = { "Accept": "application/vnd.github+json", "Authorization": "Bearer " + token };
    fetch("https://api.github.com/user", { headers: headers })
      .then(function (r) { if (!r.ok) throw new Error("GitHub approved the sign-in but the token was rejected (" + r.status + ")."); return r.json(); })
      .then(function (u) {
        return fetch("https://api.github.com/repos/" + DEFAULT_OWNER + "/" + DEFAULT_REPO + "/contents/data.json?ref=main", { headers: headers })
          .then(function (r) {
            if (!r.ok) throw new Error("Signed in, but the app can't read " + DEFAULT_OWNER + "/" + DEFAULT_REPO + " (" + r.status + "). The GitHub App must be installed on that repo.");
            return u;
          });
      })
      .then(function (u) {
        state.editor = { token: token, owner: DEFAULT_OWNER, repo: DEFAULT_REPO, login: u.login || "", kind: "device" };
        try { localStorage.setItem(LS_KEY, JSON.stringify(state.editor)); } catch (e) { /* private mode etc. */ }
        clearError();
        return loadData();
      })
      .then(function () {
        renderAll();
        toast("Connected — this device can now edit.");
      })
      .catch(function (e) { $("connect-error").textContent = e.message; });
  }
  function exportBackup() {
    /* Fix-round item 14: the backup is a wrapper now — data plus the
       saved queue and the device names, so a restore brings those back
       too. Old bare-data files still import (see importBackup). */
    var wrapper = {
      app: "alooma", version: 1,
      data: state.data,
      packQueue: packQueue.slice(),
      names: { packedBy: storedBy(PACKBY_LS), countedBy: storedBy(COUNTBY_LS) }
    };
    var blob = new Blob([JSON.stringify(wrapper, null, 2) + "\n"], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "alooma-backup-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    /* v3 E3: remember on this device when the last backup was taken */
    try { localStorage.setItem("alooma-demo.lastBackup.v1", new Date().toISOString()); } catch (e) {}
    renderBackupNote();
  }
  function renderBackupNote() {
    var el = $("last-backup");
    if (!el) return;
    var raw = null;
    try { raw = localStorage.getItem("alooma-demo.lastBackup.v1"); } catch (e) {}
    var d = raw ? new Date(raw) : null;
    el.textContent = "Last backup (this device): " + (d && !isNaN(d.getTime())
      ? d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" })
      : "never");
    var stale = $("backup-stale");
    if (stale) stale.hidden = !!d && !isNaN(d.getTime()) && (Date.now() - d.getTime()) < 7 * 24 * 3600 * 1000;
  }
  function importBackup(file) {
    if (!requireEditor()) return;
    var reader = new FileReader();
    reader.onload = function () {
      var parsed;
      try { parsed = JSON.parse(reader.result); } catch (e) { showError("That file is not valid JSON — import cancelled."); return; }
      /* Fix-round item 14: accept the new wrapper AND old bare-data
         files. A wrapper carries data + queue + names; a bare file
         carries data only and leaves queue/names untouched. */
      var isWrapper = !!(parsed && typeof parsed === "object" && parsed.data && typeof parsed.data === "object");
      var data = isWrapper ? parsed.data : parsed;
      if (!data || typeof data.inventory !== "object" || !Array.isArray(data.history)) {
        showError("That file doesn't look like an Alooma backup (needs inventory + history) — import cancelled."); return;
      }
      /* Degenerate backup: empty inventory + empty history + no usable
         recipes — refuse with a toast instead of erroring on the null
         recipes or, worse, confirm-replacing real data with nothing. */
      var invEmpty = Object.keys(data.inventory).length === 0;
      var histEmpty = data.history.length === 0;
      var recsEmpty = !data.settings || data.settings.recipes === undefined || data.settings.recipes === null || (Array.isArray(data.settings.recipes) && data.settings.recipes.length === 0);
      if (invEmpty && histEmpty && recsEmpty) { toast("Nothing to import, backup is empty"); return; }
      /* A malformed recipes block rejects the whole file — no partial
         import, nothing changed. */
      if (data.settings && data.settings.recipes !== undefined) {
        var recs = data.settings.recipes;
        var bad = !Array.isArray(recs) || recs.some(function (r) { return !r || typeof r.id !== "string" || typeof r.name !== "string" || !Array.isArray(r.lines); });
        if (bad) { showError("That backup's recipes are malformed — import cancelled, nothing changed."); return; }
      }
      /* Never silently drop lines: warn when the backup's recipes
         differ from current (or when an old file carries none, which
         resets recipes to the built-ins). Comparison is on normalized
         recipes, so an equivalent file doesn't warn. */
      var recipeWarn = "";
      var curEff = JSON.stringify(L.normalizeRecipes(state.data.settings ? state.data.settings.recipes : undefined));
      if (!data.settings || data.settings.recipes === undefined) {
        recipeWarn = " This backup has no saved recipes (old format) — importing will reset recipes to the built-ins, dropping your current custom recipes and lines.";
      } else if (JSON.stringify(L.normalizeRecipes(data.settings.recipes)) !== curEff) {
        recipeWarn = " This backup's recipes differ from your current ones — importing will replace matching crafts' lines (built-in crafts missing from the backup stay).";
      }
      openSheet({
        title: "Replace all data with this backup?",
        summary: "Current inventory and history will be overwritten. This is logged in History." + recipeWarn,
        primary: "Replace all data",
        onConfirm: function () {
          state.data = data;
          /* Fix-round item 14, Path A: merge the backup's recipes onto
             the built-in 6 instead of replacing the catalog — a backup
             that lists only BM must not delete TAM and the other crafts.
             Backup recipes override matching built-ins by id; built-ins
             missing from the backup stay; custom crafts are kept. */
          if (isWrapper && state.data.settings && Array.isArray(state.data.settings.recipes)) {
            var incoming = L.normalizeRecipes(state.data.settings.recipes);
            var merged = L.builtInRecipes().map(function (b) {
              for (var i = 0; i < incoming.length; i++) if (incoming[i].id === b.id) return incoming[i];
              return b;
            });
            incoming.forEach(function (r) {
              var seen = false;
              for (var j = 0; j < merged.length; j++) if (merged[j].id === r.id) { seen = true; break; }
              if (!seen) merged.push(r);
            });
            state.data.settings.recipes = merged;
          }
          normalizeData();
          /* Wrapper-only restores: a validated queue (known crafts,
             valid kits) and the device names. Old files skip this, so
             the current queue and names survive an old restore. */
          if (isWrapper) {
            if (Array.isArray(parsed.packQueue)) {
              packQueue = parsed.packQueue.filter(function (ln) { return ln && typeof ln.craftId === "string" && L.craftById(ln.craftId) && L.validKits(ln.kits); });
              persistPackQueue();
            }
            if (parsed.names && typeof parsed.names === "object") {
              try {
                if (typeof parsed.names.packedBy === "string") localStorage.setItem(PACKBY_LS, parsed.names.packedBy);
                if (typeof parsed.names.countedBy === "string") localStorage.setItem(COUNTBY_LS, parsed.names.countedBy);
              } catch (e) {}
            }
          }
          var marker = newEntry("import", "Imported a backup file", [], {});
          state.data.history.unshift(marker);
          renderAll();
          saveData("Import backup").then(function () { toast("Backup imported and saved."); });
        }
      });
    };
    reader.readAsText(file);
  }

  /* ---------- Settings: default boxes (Batch C1, free-form list) ---------- */
  /* Boxes are a simple list of names the user adds himself (any count, no
     sizes). A rule = craft (dropdown) + kit count (typed, multiples of 6
     only) + ANY number of boxes: each pick from the box dropdown adds one
     to the rule (shown as chips), so bigger orders can default to two,
     three, four boxes. */
  var rulePickedBoxes = []; /* boxes chosen so far for the rule being built */
  function renderBoxSettings() {
    var s = settings();
    $("set-boxes-on").checked = !!s.features.boxes;
    $("boxes-editor").hidden = !s.features.boxes;
    var list = $("box-list"); list.innerHTML = "";
    if (!s.boxes.length) list.innerHTML = '<p class="hint">No boxes yet — add your first box below.</p>';
    s.boxes.forEach(function (name) {
      var row = document.createElement("div"); row.className = "box-rule-row";
      row.innerHTML = "<span>" + esc(name) + "</span>";
      var del = document.createElement("button");
      del.type = "button"; del.className = "btn btn-quiet"; del.textContent = "Delete";
      del.setAttribute("aria-label", "Delete box " + name);
      del.addEventListener("click", function () {
        if (!requireEditor()) return;
        settings().boxes = settings().boxes.filter(function (b) { return b !== name; });
        /* A deleted box disappears from any rules that used it */
        settings().boxRules = settings().boxRules.map(function (r) {
          return { craftId: r.craftId, kits: r.kits, boxes: r.boxes.filter(function (b) { return b !== name; }) };
        }).filter(function (r) { return r.boxes.length > 0; });
        saveData("Box removed: " + name).then(function () { toast("Box removed."); renderAll(); });
      });
      row.appendChild(del);
      list.appendChild(row);
    });
    var rulesList = $("box-rules-list"); rulesList.innerHTML = "";
    if (!s.boxRules.length) rulesList.innerHTML = '<p class="hint">No rules yet.</p>';
    s.boxRules.forEach(function (r, idx) {
      var craft = L.craftById(r.craftId);
      var row = document.createElement("div"); row.className = "box-rule-row";
      row.innerHTML = "<span>" + esc(craft ? craft.name : r.craftId) + " · " + r.kits + " kits = " + esc(L.boxesText(s, r.boxes)) + "</span>";
      var del = document.createElement("button");
      del.type = "button"; del.className = "btn btn-quiet"; del.textContent = "Delete";
      del.addEventListener("click", function () {
        if (!requireEditor()) return;
        settings().boxRules.splice(idx, 1);
        saveData("Box rule removed").then(function () { toast("Rule removed."); renderAll(); });
      });
      row.appendChild(del);
      rulesList.appendChild(row);
    });
    var craftSel = $("rule-craft");
    if (!craftSel.options.length) {
      L.CRAFTS.forEach(function (c) {
        var o = document.createElement("option"); o.value = c.id; o.textContent = c.name;
        craftSel.appendChild(o);
      });
    }
    /* The box dropdown mirrors the user's box list; picking a box adds it
       to the rule being built (see the change wiring) */
    var boxSel = $("rule-boxes");
    boxSel.innerHTML = "";
    var ph = document.createElement("option"); ph.value = ""; ph.textContent = "Choose a box…";
    boxSel.appendChild(ph);
    s.boxes.forEach(function (name) {
      var o = document.createElement("option"); o.value = name; o.textContent = name;
      boxSel.appendChild(o);
    });
    boxSel.value = "";
    renderRulePicked();
  }
  function renderRulePicked() {
    var wrap = $("rule-boxes-picked");
    wrap.innerHTML = "";
    if (!rulePickedBoxes.length) {
      wrap.innerHTML = '<span class="hint">No boxes picked for this rule yet — choose from the box menu.</span>';
      return;
    }
    rulePickedBoxes.forEach(function (name, i) {
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "kits-chip selected";
      chip.textContent = name + " ✕";
      chip.setAttribute("aria-label", "Remove " + name + " from this rule");
      chip.addEventListener("click", function () {
        rulePickedBoxes.splice(i, 1);
        renderRulePicked();
      });
      wrap.appendChild(chip);
    });
  }
  function addBoxFromField() {
    if (!requireEditor()) return;
    var inp = $("new-box-name");
    var name = inp.value.trim();
    if (!name) { toast("Type a box name first."); return; }
    var dupe = settings().boxes.some(function (b) { return b.toLowerCase() === name.toLowerCase(); });
    if (dupe) { toast("That box is already in the list."); return; }
    settings().boxes.push(name);
    inp.value = "";
    saveData("Box added: " + name).then(function () { toast("Box added."); renderAll(); });
  }

  /* ---------- Settings: bin locations (Batch C2) ---------- */
  function renderBinSettings() {
    $("set-bins-on").checked = !!settings().features.bins;
  }

  /* ---------- Settings: reorder quantity + hide-quantities print ---------- */
  /* Two separate saved settings: reorderQty (a number, or null when
     unset) and hideReorderQtys (a boolean, default false). Neither lives
     in defaultSettings — like features.bulkTab, unset means the old
     behavior (formula default, quantities shown). */
  function renderReorderSettings() {
    var q = $("set-reorder-qty");
    if (q) q.value = (settings().reorderQty !== null && settings().reorderQty !== undefined) ? String(settings().reorderQty) : "";
    var h = $("set-hide-reorder-qtys");
    if (h) h.checked = !!settings().hideReorderQtys;
  }

  /* ---------- Settings: Bulk tab toggle (brief A2, default OFF) ---------- */
  function renderBulkTabSetting() {
    $("set-bulk-on").checked = !!(settings().features && settings().features.bulkTab);
  }

  /* ---------- Settings: Names (brief 5e) ---------- */
  /* Rendered from the per-device stored values; saved on change (blur/Enter),
     not on every keystroke, so a typed-but-unblurred name counts as unsaved
     under the A3 leave rule until it saves. */
  function renderNamesSetting() {
    $("set-packed-by").value = storedBy(PACKBY_LS);
    $("set-counted-by").value = storedBy(COUNTBY_LS);
  }
  function saveNamesSetting() {
    try {
      var p = $("set-packed-by").value.trim(), c = $("set-counted-by").value.trim();
      if (p) localStorage.setItem(PACKBY_LS, p); else localStorage.removeItem(PACKBY_LS);
      if (c) localStorage.setItem(COUNTBY_LS, c); else localStorage.removeItem(COUNTBY_LS);
    } catch (e) { /* private mode etc. */ }
  }

  /* ---------- Settings: Recipes (recipe editor sub-batch b) ----------
     Immediate save per valid edit (approved plan): no unsaved-recipe state,
     so the A3 leave rule needs no recipe-dirty check — same precedent as
     the boxes editor's fields, which are likewise not A3-protected.
     renderRecipesSetting writes ONLY #recipes-list, so the static Add form
     keeps in-progress text across re-renders. Expansion state lives in
     expandedRecipeId so a save re-render keeps the open craft open. */
  var expandedRecipeId = null;
  var pendingNewItem = null; /* {recipeId, lineIdx, slot} while the create-item form is open */
  function slugify(s) {
    var slug = String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return slug || "craft";
  }
  function recipeEntries(recipe) {
    var n = 0;
    (recipe.lines || []).forEach(function (ln) { n += Array.isArray(ln.items) ? ln.items.length : 1; });
    return n;
  }
  /* Whole-craft validation: "" means valid. Blocks the save, never throws. */
  function validateRecipe(recipe) {
    if (!recipe.name || !String(recipe.name).trim()) return "Give the craft a name.";
    var seen = {};
    var lines = recipe.lines || [];
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (Array.isArray(ln.items)) {
        if (ln.items.length !== 2 || !ln.items[0] || !ln.items[1]) return "Each alternating pair needs two different items.";
        if (ln.items[0] === ln.items[1]) return "The two items in a pair must be different.";
        if (!(Number.isInteger(ln.qty) && ln.qty > 0 && ln.qty <= 999)) return "Pair quantities must be whole numbers from 1 to 999.";
        if (seen[ln.items[0]] || seen[ln.items[1]]) return "An item can only appear once in a craft.";
        seen[ln.items[0]] = seen[ln.items[1]] = true;
      } else {
        if (!ln.item) return "Every line needs an item.";
        if (!(Number.isInteger(ln.qty) && ln.qty > 0 && ln.qty <= 999)) return "Quantities must be whole numbers from 1 to 999.";
        if (!(Number.isInteger(ln.per) && ln.per > 0 && ln.per <= 999)) return "“Per” must be a whole number from 1 to 999.";
        if (seen[ln.item]) return "An item can only appear once in a craft.";
        seen[ln.item] = true;
      }
    }
    return "";
  }
  function itemOptions(selected, showNew) {
    var html = "";
    /* Fix-round item 15: an unchosen row gets an explicit empty option
       (selected unless the Create-new-item form is open for it) so the
       select never misleadingly displays the first item. */
    if (!selected) html += '<option value=""' + (!showNew ? " selected" : "") + ">Choose an item…</option>";
    Object.keys(L.ITEMS).forEach(function (id) {
      var unit = L.itemUnit(id);
      html += '<option value="' + esc(id) + '"' + (id === selected ? " selected" : "") + ">" + esc(L.ITEMS[id]) + (unit ? " (" + esc(unit) + ")" : "") + "</option>";
    });
    html += '<option value="__new__"' + (showNew ? " selected" : "") + ">Create new item…</option>";
    return html;
  }
  /* Item-11 decision, part B6: "fits on label" check for the new-item
     name. The 4x6 pack sheet prints item names at 12.5pt Arial in an Item
     column. The threshold is the real measured bins-off Item CONTENT
     width — 137pt, the minimum of the baseline bins-off sheets (HCB
     137pt, CAK 145pt, from header x-positions in the PDFs minus cell
     padding/borders). Measure the typed name with the
     same font; if it overflows, report about how many characters over
     (width over / average char width). Advisory only — saving is never
     blocked by this check. */
  var labelCanvas = null;
  function labelFitOver(name) {
    if (!name) return 0;
    if (!labelCanvas) labelCanvas = document.createElement("canvas").getContext("2d");
    labelCanvas.font = "12.5pt Arial, Helvetica, sans-serif";
    var wPt = labelCanvas.measureText(name).width * 72 / 96;
    if (wPt <= 137) return 0;
    return Math.max(1, Math.ceil((wPt - 117) / (wPt / name.length)));
  }
  function renderRecipesSetting() {
    var list = $("recipes-list");
    if (!list) return;
    var recipes = settings().recipes || [];
    var html = "";
    recipes.forEach(function (r) {
      html += '<div class="recipe-row" data-recipe-row="' + esc(r.id) + '">';
      html += '<div class="recipe-head"><strong>' + esc(r.name) + '</strong> <span class="recipe-code">' + esc(r.code) + "</span>" +
        (r.hidden ? ' <span class="recipe-hidden">Hidden</span>' : "") +
        '<span class="recipe-count">' + r.lines.length + " lines</span>" +
        '<button type="button" class="btn btn-quiet" data-recipe-edit>Edit</button></div>';
      if (expandedRecipeId === r.id) {
        html += '<div class="recipe-editor">';
        html += '<label>Name <input type="text" data-recipe-name value="' + esc(r.name) + '" autocomplete="off"></label>';
        html += '<span class="hint">Code ' + esc(r.code) + " is locked after creation.</span> ";
        html += '<button type="button" class="btn btn-quiet" data-hide-toggle>' + (r.hidden ? "Unhide" : "Hide") + "</button>";
        r.lines.forEach(function (ln, idx) {
          var isPending = pendingNewItem && pendingNewItem.recipeId === r.id && pendingNewItem.lineIdx === idx;
          html += '<div class="recipe-line" data-recipe-line="' + idx + '">';
          if (Array.isArray(ln.items)) {
            html += '<span class="hint">Alternating pair</span>' +
              '<select data-line-item>' + itemOptions(ln.items[0], isPending && pendingNewItem.slot === 0) + "</select>" +
              '<select data-line-item2>' + itemOptions(ln.items[1], isPending && pendingNewItem.slot === 1) + "</select>" +
              '<label>Qty <input type="number" min="1" step="1" data-line-qty value="' + ln.qty + '"></label>' +
              '<span class="hint">per 6</span>';
          } else {
            html += '<select data-line-item>' + itemOptions(ln.item, isPending && pendingNewItem.slot === 0) + "</select>" +
              '<label>Qty <input type="number" min="1" step="1" data-line-qty value="' + ln.qty + '"></label>' +
              '<label>Per <input type="number" min="1" step="1" data-line-per value="' + (ln.per || 6) + '"></label>';
          }
          html += '<button type="button" class="btn btn-quiet" data-line-remove>Remove</button></div>';
        });
        if (pendingNewItem && pendingNewItem.recipeId === r.id) {
          html += '<div class="recipe-new-item"><label>New item name <input type="text" data-new-item-name autocomplete="off"></label>' +
            '<label>Unit (optional) <input type="text" data-new-item-unit autocomplete="off"></label>' +
            '<button type="button" class="btn btn-primary" data-new-item-create>Create item</button>' +
            '<button type="button" class="btn btn-quiet" data-new-item-cancel>Cancel</button><p class="field-error" data-label-fit hidden></p></div>';
        }
        html += '<div class="btn-row"><button type="button" class="btn" data-add-line>Add line</button><button type="button" class="btn" data-add-pair>Add alternating pair</button></div>';
        html += '<p class="field-error" data-recipe-error></p>';
        html += "</div>";
      }
      html += "</div>";
    });
    list.innerHTML = html;
  }
  /* The live catalog (L.CRAFTS/L.ITEMS) is a copy set on load; an in-app
     edit changes state.data only, so re-sync it after every recipe save —
     otherwise the picker, inventory groups, and item selects would keep
     showing the pre-edit catalog until the next reload. */
  function syncCatalog() {
    var s = settings();
    L.setCatalog(s.recipes, s.customItems);
    /* Fix-round item 4: a brand-new catalog item has no inventory row
       yet. The load path creates one, but a live editor save did not —
       so renderInventory threw on rec.qty, renderAll aborted, and
       History never refreshed. Create the row here, same shape as the
       load path, so the item appears immediately, no reload needed. */
    Object.keys(L.ITEMS).forEach(function (id) {
      if (!state.data.inventory[id]) state.data.inventory[id] = { qty: 0, threshold: null };
    });
  }
  function commitRecipe(recipeId, mutate, msg) {
    var recipes = settings().recipes || [];
    var idx = recipes.findIndex(function (r) { return r.id === recipeId; });
    if (idx < 0) return;
    mutate(recipes[idx]);
    saveData(msg || "Recipe updated").then(function () { syncCatalog(); renderAll(); });
  }
  /* Validated edit: on failure the error shows and nothing saves — and
     nothing re-renders, so the user's input stays exactly as typed. */
  function applyRecipeEdit(recipeId, mutate, msg) {
    var recipes = settings().recipes || [];
    var idx = recipes.findIndex(function (r) { return r.id === recipeId; });
    if (idx < 0) return;
    var cand = JSON.parse(JSON.stringify(recipes[idx]));
    mutate(cand);
    var err = validateRecipe(cand);
    /* Fix-round item 5: renaming onto another craft's name is blocked
       too (case-insensitive) — validateRecipe only sees one craft, so
       the sibling check lives here. */
    if (!err && recipes.some(function (r) { return r.id !== recipeId && r.name.trim().toLowerCase() === String(cand.name).trim().toLowerCase(); })) err = "A craft with that name already exists.";
    if (err) {
      var row = document.querySelector('[data-recipe-row="' + recipeId + '"]');
      var errEl = row ? row.querySelector("[data-recipe-error]") : null;
      if (errEl) errEl.textContent = err;
      return;
    }
    recipes[idx] = cand;
    saveData(msg || "Recipe updated").then(function () { syncCatalog(); renderAll(); });
  }
  function recipeRowId(el) {
    var row = el.closest ? el.closest("[data-recipe-row]") : null;
    return row ? row.getAttribute("data-recipe-row") : null;
  }
  function recipeLineIdx(el) {
    var line = el.closest ? el.closest("[data-recipe-line]") : null;
    return line ? parseInt(line.getAttribute("data-recipe-line"), 10) : -1;
  }
  function bindRecipeEditor() {
    var card = $("recipes-card");
    if (!card) return;
    card.addEventListener("click", function (e) {
      var t = e.target;
      var id = recipeRowId(t);
      if (t.hasAttribute("data-recipe-edit")) {
        expandedRecipeId = expandedRecipeId === id ? null : id;
        renderRecipesSetting();
        return;
      }
      if (!id) return;
      if (t.hasAttribute("data-hide-toggle")) {
        commitRecipe(id, function (r) { r.hidden = !r.hidden; }, "Recipe hidden");
        return;
      }
      if (t.hasAttribute("data-line-remove")) {
        var ridx = recipeLineIdx(t);
        /* Fix-round item 16: removal offers Undo instead of a blocking
           confirm — the toast restores the exact line at its old index. */
        var recipes = settings().recipes || [];
        var recipe = recipes.find(function (r) { return r.id === id; });
        var removed = recipe && recipe.lines[ridx] ? JSON.parse(JSON.stringify(recipe.lines[ridx])) : null;
        commitRecipe(id, function (r) { r.lines.splice(ridx, 1); }, "Recipe line removed");
        if (removed) showToast("Recipe line removed", "UNDO", function () {
          commitRecipe(id, function (r) { r.lines.splice(Math.min(ridx, r.lines.length), 0, removed); }, "Recipe line restored");
        }, 10000);
        return;
      }
      if (t.hasAttribute("data-add-line") || t.hasAttribute("data-add-pair")) {
        var recipes = settings().recipes || [];
        var recipe = recipes.find(function (r) { return r.id === id; });
        if (!recipe) return;
        var used = {};
        recipeLineItems(recipe).forEach(function (it) { used[it] = true; });
        var free = Object.keys(L.ITEMS).filter(function (it) { return !used[it]; });
        var row = document.querySelector('[data-recipe-row="' + id + '"]');
        var errEl = row ? row.querySelector("[data-recipe-error]") : null;
        if (t.hasAttribute("data-add-line")) {
          /* Fix-round item 15: Add line adds an EMPTY row the user must
             choose — never a random item at qty 1. It saves via the
             unvalidated commitRecipe path; editing it before choosing
             errors "Every line needs an item" (validateRecipe), and an
             unchosen row never packs or prints (isValidLine drops it
             from the active catalog on reload — it is a session draft
             until an item is chosen). The all-items-used guard goes
             away with the random pick: a new row can always take a
             freshly created item. */
          commitRecipe(id, function (r) { r.lines.push({ item: "", qty: 1, per: 6 }); }, "Recipe line added");
        } else {
          if (free.length < 2) { if (errEl) errEl.textContent = "Need two unused items for a pair — this craft already uses nearly everything."; return; }
          commitRecipe(id, function (r) { r.lines.push({ items: [free[0], free[1]], qty: 1, per: 6 }); }, "Recipe pair added");
        }
        return;
      }
      if (t.hasAttribute("data-new-item-cancel")) {
        pendingNewItem = null;
        renderRecipesSetting();
        return;
      }
      if (t.hasAttribute("data-new-item-create")) {
        var nameEl = card.querySelector("[data-new-item-name]");
        var unitEl = card.querySelector("[data-new-item-unit]");
        var name = nameEl ? nameEl.value.trim() : "";
        var row2 = document.querySelector('[data-recipe-row="' + id + '"]');
        var errEl2 = row2 ? row2.querySelector("[data-recipe-error]") : null;
        if (!name) { if (errEl2) errEl2.textContent = "Give the new item a name."; return; }
        var slug = slugify(name);
        /* Fix-round item 5: the slug check alone misses names whose id
           isn't their slug (e.g. "AY - by request" lives under
           english-ay-printout), so compare display names too. */
        if (Object.keys(L.ITEMS).indexOf(slug) >= 0 || Object.keys(L.ITEMS).some(function (id) { return L.ITEMS[id].trim().toLowerCase() === name.toLowerCase(); })) { if (errEl2) errEl2.textContent = "An item with that name already exists."; return; }
        var pend = pendingNewItem;
        var unit = unitEl ? unitEl.value.trim() : "";
        commitRecipe(id, function (r) {
          var s = settings();
          s.customItems = s.customItems || [];
          s.customItems.push({ id: slug, name: name, unit: unit });
          var ln = r.lines[pend.lineIdx];
          if (ln && Array.isArray(ln.items)) ln.items[pend.slot] = slug;
          else if (ln) ln.item = slug;
        }, "Item added: " + name);
        pendingNewItem = null;
        return;
      }
    });
    card.addEventListener("change", function (e) {
      var t = e.target;
      var id = recipeRowId(t);
      if (!id) return;
      if (t.hasAttribute("data-recipe-name")) {
        var v = t.value.trim();
        applyRecipeEdit(id, function (r) { r.name = v; }, "Recipe renamed");
        return;
      }
      var lidx = recipeLineIdx(t);
      if (lidx < 0) return;
      if (t.hasAttribute("data-line-item") || t.hasAttribute("data-line-item2")) {
        if (t.value === "__new__") {
          pendingNewItem = { recipeId: id, lineIdx: lidx, slot: t.hasAttribute("data-line-item2") ? 1 : 0 };
          renderRecipesSetting();
          return;
        }
        var slot = t.hasAttribute("data-line-item2") ? 1 : 0;
        var val = t.value;
        applyRecipeEdit(id, function (r) {
          var ln = r.lines[lidx];
          if (Array.isArray(ln.items)) ln.items[slot] = val;
          else ln.item = val;
        }, "Recipe line updated");
        return;
      }
      if (t.hasAttribute("data-line-qty")) {
        var q = Number(t.value);
        applyRecipeEdit(id, function (r) { r.lines[lidx].qty = q; }, "Recipe line updated");
        return;
      }
      if (t.hasAttribute("data-line-per")) {
        var p = Number(t.value);
        applyRecipeEdit(id, function (r) { r.lines[lidx].per = p; }, "Recipe line updated");
        return;
      }
    });
    card.addEventListener("input", function (e) {
      var t = e.target;
      if (!t.hasAttribute("data-new-item-name")) return;
      var warn = card.querySelector("[data-label-fit]");
      if (!warn) return;
      var over = labelFitOver(t.value.trim());
      if (over > 0) {
        warn.textContent = "Too long for the label, about " + over + (over === 1 ? " character" : " characters") + " over \u2014 try trimming it.";
        warn.hidden = false;
      } else warn.hidden = true;
    });
    $("recipe-add-btn").addEventListener("click", function () {
      var name = $("recipe-add-name").value.trim();
      var code = $("recipe-add-code").value.trim().toUpperCase();
      var errEl = $("recipe-add-error");
      var fail = function (m) { errEl.textContent = m; };
      if (!name) { fail("Give the craft a name."); return; }
      if (!/^[A-Z]{2,4}$/.test(code)) { fail("Code must be 2–4 letters."); return; }
      var recipes = settings().recipes || [];
      if (recipes.some(function (r) { return r.code.toUpperCase() === code; })) { fail("That code is already used."); return; }
      /* Fix-round item 5: duplicate craft names blocked (case-insensitive)
         — the old code only blocked duplicate codes, so "blooming mirrors"
         sailed through next to "Blooming Mirrors". */
      if (recipes.some(function (r) { return r.name.trim().toLowerCase() === name.toLowerCase(); })) { fail("A craft with that name already exists."); return; }
      var base = slugify(name), slug = base, n = 2;
      var ids = recipes.map(function (r) { return r.id; });
      while (ids.indexOf(slug) >= 0) slug = base + "-" + (n++);
      recipes.push({ id: slug, code: code, name: name, hidden: false, lines: [] });
      saveData("Recipe added: " + name).then(function () {
        $("recipe-add-name").value = "";
        $("recipe-add-code").value = "";
        errEl.textContent = "";
        syncCatalog();
        renderAll();
      });
    });
  }
  function recipeLineItems(recipe) {
    var ids = [];
    (recipe.lines || []).forEach(function (ln) {
      if (Array.isArray(ln.items)) ids.push.apply(ids, ln.items);
      else if (ln.item) ids.push(ln.item);
    });
    return ids;
  }

  /* ---------- wiring ---------- */
  function renderAll() {
    renderSettings();
    renderBoxSettings();
    renderBinSettings();
    renderBulkTabSetting();
    renderReorderSettings();
    renderNamesSetting();
    renderRecipesSetting();
    renderPack();
    renderBulk();
    renderInventory();
    renderHistory();
  }
  function init() {
    loadPackQueue();
    if (DEMO) {
      state.editor = { token: "", owner: DEFAULT_OWNER, repo: DEFAULT_REPO, login: "demo", kind: "demo" };
      var ghCard = $("settings-conn-status") && $("settings-conn-status").closest(".card");
      if (ghCard) ghCard.hidden = true;
      var rb = $("demo-reset");
      if (rb) rb.addEventListener("click", function () {
        try {
          var drop = [];
          for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i);
            if (k && k.indexOf("alooma-demo.") === 0) drop.push(k);
          }
          drop.forEach(function (k) { localStorage.removeItem(k); });
        } catch (e) {}
        location.reload();
      });
    } else {
      try {
        var saved = localStorage.getItem(LS_KEY);
        if (saved) state.editor = JSON.parse(saved);
      } catch (e) { state.editor = null; }
    }

    document.querySelectorAll("#tabs button").forEach(function (b) {
      b.addEventListener("click", function () { requestTab(b.getAttribute("data-tab")); });
    });
    $("conn-badge").addEventListener("click", function () { if (!state.editor) requestTab("settings"); });
    /* Item 5: large orders ask on blur/submit, never per keystroke
       (threshold 240, was 96). The blur-vs-tap race: tapping an action
       button blurs the field (the sheet opens) and the tap's click then
       lands on the sheet backdrop, dismissing it as cancel. So the
       large sheet is sticky (backdrop taps cannot dismiss it) and every
       action that submits the kits field gates on it too. Stepper taps
       set a flag (mousedown + touchstart both fire before blur) so
       stepper moves never trigger the confirm; the submit gate still
       catches a stepper-set large value. Go back restores the
       focus-time value; confirming remembers the amount so retyping
       the same amount doesn't ask again. */
    var blurFromStepper = false;
    ["pack-minus", "pack-plus", "bulk-minus", "bulk-plus"].forEach(function (id) {
      var b = $(id);
      if (!b) return;
      b.addEventListener("mousedown", function () { blurFromStepper = true; });
      b.addEventListener("touchstart", function () { blurFromStepper = true; });
    });
    function largeNeedsCheck(which) {
      var raw = which === "pack" ? $("pack-kits").value : $("bulk-kits").value;
      var n = strictKits(raw);
      var confirmed = which === "pack" ? packLargeConfirmed : bulkLargeConfirmed;
      if (!Number.isInteger(n) || n <= 240 || n === confirmed) return null;
      return { n: n, raw: raw, prev: which === "pack" ? packPrevKits : bulkPrevKits };
    }
    function openLargeConfirm(which, chk, onYes) {
      var isPack = which === "pack";
      openSheet({
        title: "Large order",
        summary: chk.n + " kits is unusually large — is that the right amount?",
        primary: "Yes, use " + chk.n + " kits",
        cancelLabel: "Go back",
        stickyBackdrop: true,
        onConfirm: function () {
          if (isPack) { packLargeConfirmed = chk.n; packPrevKits = chk.raw; renderPack(); }
          else { bulkLargeConfirmed = chk.n; bulkPrevKits = chk.raw; renderBulk(); }
          if (onYes) onYes();
        },
        onCancel: function () {
          if (isPack) { $("pack-kits").value = chk.prev; packPrevKits = chk.prev; renderPack(); }
          else { $("bulk-kits").value = chk.prev; bulkPrevKits = chk.prev; renderBulk(); }
        }
      });
    }
    function gateLarge(which, proceed) {
      var chk = largeNeedsCheck(which);
      if (!chk) { proceed(); return; }
      openLargeConfirm(which, chk, proceed);
    }
    function blurLarge(which) {
      if (blurFromStepper) { blurFromStepper = false; return; }
      var chk = largeNeedsCheck(which);
      if (chk) openLargeConfirm(which, chk, null);
    }
    $("pack-kits").addEventListener("focus", function () { packPrevKits = $("pack-kits").value; });
    $("pack-kits").addEventListener("input", function () {
      if (queueHandIdx >= 0) endQueueWalk();
      packKitsTouched = true;
      renderPack();
    });
    $("pack-kits").addEventListener("blur", function () { blurLarge("pack"); });
    function wireStepper(inputId, minusId, plusId, renderFn) {
      $(minusId).addEventListener("click", function () {
        var v = parseInt($(inputId).value, 10);
        $(inputId).value = Number.isInteger(v) ? Math.max(6, v - 6) : 6;
        renderFn();
      });
      $(plusId).addEventListener("click", function () {
        var v = parseInt($(inputId).value, 10);
        $(inputId).value = Number.isInteger(v) ? v + 6 : 6;
        renderFn();
      });
    }
    document.querySelectorAll(".kits-chip[data-for]").forEach(function (chip) {
      chip.addEventListener("click", function () {
        var target = chip.getAttribute("data-for");
        $(target + "-kits").value = chip.getAttribute("data-kits");
        if (target === "pack") { if (queueHandIdx >= 0) endQueueWalk(); packKitsTouched = true; renderPack(); } else renderBulk();
      });
    });
    /* Brief 5a: "+" swaps the chips for a manual number box; "Chips" swaps back. */
    $("pack-kits-plus").addEventListener("click", function () { packKitsManual = true; renderPack(); $("pack-kits").focus(); });
    $("pack-kits-chips").addEventListener("click", function () { packKitsManual = false; renderPack(); });
    $("btn-check-all").addEventListener("click", function () {
      var boxes = $("pack-table").querySelectorAll("tbody input[type=checkbox]");
      var allChecked = boxes.length > 0 && Array.prototype.every.call(boxes, function (cb) { return cb.checked; });
      var setAll = function (val) {
        boxes.forEach(function (cb) {
          cb.checked = val;
          cb.closest("tr").classList.toggle("checked-row", val);
        });
        updatePackProgress();
      };
      if (allChecked) { setAll(false); return; } /* unchecking is safe — no confirm */
      /* v2 A5: checking everything in one tap is the risky direction — ask first */
      openSheet({
        title: "Check all",
        summary: "Mark all " + boxes.length + " packed?",
        primary: "Mark all",
        onConfirm: function () { setAll(true); }
      });
    });
    $("inv-search").addEventListener("input", function (ev) { invQuery = ev.target.value.trim().toLowerCase(); applyInvFilters(); filterEntryList($("delivery-entry-list")); filterEntryList($("count-entry-list")); });
    $("btn-filter-all").addEventListener("click", function () { invFilter = "all"; applyInvFilters(); });
    $("btn-lowfilter").addEventListener("click", function () { invFilter = "low"; applyInvFilters(); });
    $("btn-outfilter").addEventListener("click", function () { invFilter = "out"; applyInvFilters(); });
    $("btn-binfilter").addEventListener("click", function () { invSortBin = !invSortBin; renderInventory(); });
    $("btn-pack-sort").addEventListener("click", function () { packSortBin = !packSortBin; renderPack(); });
    $("set-bins-on").addEventListener("change", function () {
      if (!requireEditor()) { renderBinSettings(); return; }
      settings().features.bins = $("set-bins-on").checked;
      if (!settings().features.bins) { invSortBin = false; packSortBin = false; }
      saveData("Bin locations " + (settings().features.bins ? "on" : "off")).then(function () { renderAll(); });
    });
    $("set-bulk-on").addEventListener("change", function () {
      if (!requireEditor()) { renderBulkTabSetting(); return; }
      if (!settings().features) settings().features = {};
      settings().features.bulkTab = $("set-bulk-on").checked;
      saveData("Bulk tab " + (settings().features.bulkTab ? "on" : "off")).then(function () { renderAll(); });
    });
    $("set-reorder-qty").addEventListener("change", function () {
      if (!requireEditor()) { renderReorderSettings(); return; }
      var raw = $("set-reorder-qty").value.trim();
      if (raw === "") {
        settings().reorderQty = null;
        saveData("Reorder quantity cleared").then(function () { renderAll(); });
        return;
      }
      var v = Number(raw);
      if (!Number.isInteger(v) || v < 1) {
        toast("Reorder quantity must be a whole number of 1 or more.");
        renderReorderSettings();
        return;
      }
      settings().reorderQty = v;
      saveData("Reorder quantity " + v).then(function () { renderAll(); });
    });
    $("set-hide-reorder-qtys").addEventListener("change", function () {
      if (!requireEditor()) { renderReorderSettings(); return; }
      settings().hideReorderQtys = $("set-hide-reorder-qtys").checked;
      saveData("Printed reorder list quantities " + (settings().hideReorderQtys ? "hidden" : "shown")).then(function () { renderAll(); });
    });
    /* Names save per device on change only (see renderNamesSetting) — no
       server save, and no editor gate: the fields are editor-only in the
       markup, and a viewer never sees them. */
    $("set-packed-by").addEventListener("change", saveNamesSetting);
    $("set-counted-by").addEventListener("change", saveNamesSetting);
    bindRecipeEditor();
    $("btn-print-menu").addEventListener("click", function () {
      var menu = $("print-menu");
      var open = menu.hidden;
      menu.hidden = !open;
      $("btn-print-menu").setAttribute("aria-expanded", open ? "true" : "false");
      if (open) positionPrintMenu();
    });
    /* The menu is position:fixed, placed from the button's rect at open
       time. It used to be absolute inside the chip row — but that row
       scrolls (overflow-x: auto makes overflow-y clip too), so for
       view-only devices, where the button lives in the chip row, the
       open menu was clipped to a sliver of the row and never showed.
       Fixed positioning escapes any clipping ancestor, for both roles. */
    var printMenuOpenedAt = 0;
    function positionPrintMenu() {
      var btn = $("btn-print-menu").getBoundingClientRect();
      var menu = $("print-menu");
      menu.style.top = (btn.bottom + 6) + "px";
      menu.style.right = Math.max(8, window.innerWidth - btn.right) + "px";
      printMenuOpenedAt = Date.now();
    }
    function closePrintMenu() {
      if (!$("print-menu").hidden) { $("print-menu").hidden = true; $("btn-print-menu").setAttribute("aria-expanded", "false"); }
    }
    window.addEventListener("resize", closePrintMenu);
    /* A scroll closes the menu (it would hang detached from its button) —
       but scroll events are delivered a frame late, and the click that
       opens the menu scrolls it into view first at phone widths; without
       the grace period that late event instantly closed the just-opened
       menu (diagnosed by hit-test in the layout suite). */
    window.addEventListener("scroll", function () {
      if (Date.now() - printMenuOpenedAt > 350) closePrintMenu();
    }, true);
    $("print-menu").addEventListener("click", function () {
      $("print-menu").hidden = true;
      $("btn-print-menu").setAttribute("aria-expanded", "false");
    });
    document.addEventListener("click", function (ev) {
      var wrap = document.querySelector(".print-menu-wrap");
      if (wrap && !wrap.contains(ev.target)) {
        $("print-menu").hidden = true;
        $("btn-print-menu").setAttribute("aria-expanded", "false");
      }
    });
    /* Desktop brief item 1: Esc closes the topmost layer (sheet, then menu) */
    document.addEventListener("keydown", function (ev) {
      if (ev.key !== "Escape") return;
      if (!$("sheet-backdrop").hidden) { dismissSheet(); return; }
      if (!$("print-menu").hidden) {
        $("print-menu").hidden = true;
        $("btn-print-menu").setAttribute("aria-expanded", "false");
      }
    });
    /* An action toast's UNDO button is clickable, so it can sit on top of
       another control and swallow its click (at 800x600 it covered the
       Bulk Record button's centre and the batch sheet never opened —
       diagnosed by hit-test in the UI suite). The toast therefore yields
       to the user's next real action: a press on any other control
       dismisses it first. Plain toasts have no button and never block;
       Undo also lives on every History entry, so nothing is lost. */
    document.addEventListener("pointerdown", function (ev) {
      var t = $("toast");
      if (t && !t.hidden && t.querySelector("button") && !t.contains(ev.target) &&
          ev.target.closest("button, input, select, textarea, a, [role='button']")) t.hidden = true;
    }, true);
    $("sheet-primary").addEventListener("click", function () {
      var cb = sheetCb;
      if (!cb) { closeSheet(); return; }
      var val = null;
      if (!$("sheet-input-wrap").hidden) val = parseInt($("sheet-input").value, 10);
      closeSheet();
      cb(val);
    });
    $("sheet-cancel").addEventListener("click", dismissSheet);
    /* Item 5: a sticky sheet (the large-order confirm) ignores backdrop
       taps — otherwise the very tap that blurred the field would dismiss
       the sheet it just opened, as a cancel. Escape and tab switches
       still dismiss. */
    $("sheet-backdrop").addEventListener("click", function (ev) { if (ev.target === $("sheet-backdrop") && !sheetSticky) dismissSheet(); });
    /* Brief 5c: the single-craft action row. Queue enters Queue mode with
       this pick as the first line; Print prints and completes it now;
       Hand pack opens the checklist for this one craft. */
    $("btn-pack-queue").addEventListener("click", function () {
      var cur = currentPack(); if (!cur || !cur.pack.length) return;
      gateLarge("pack", function () {
        packQueue.push({ craftId: cur.craft.id, kits: cur.kits });
        persistPackQueue();
        state.packCraft = null; $("pack-kits").value = ""; packMode = null; packKitsTouched = false;
        queueMode = true;
        renderPack();
      });
    });
    $("btn-pack-print").addEventListener("click", function () { gateLarge("pack", printSingle); });
    $("btn-pack-hand").addEventListener("click", function () { var cur = currentPack(); if (!cur || !cur.pack.length) return; gateLarge("pack", function () { packMode = "hand"; renderPack(); }); });
    $("bulk-kits").addEventListener("focus", function () { bulkPrevKits = $("bulk-kits").value; });
    $("bulk-kits").addEventListener("input", function () {
      renderBulk();
    });
    $("bulk-kits").addEventListener("blur", function () { blurLarge("bulk"); });
    wireStepper("bulk-kits", "bulk-minus", "bulk-plus", renderBulk);
    $("btn-bulk-add").addEventListener("click", function () { gateLarge("bulk", addBulkLine); });
    $("btn-bulk-record").addEventListener("click", recordAllBulk);
    $("bulk-lines").addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-remove]");
      if (!b) return;
      bulkLines.splice(parseInt(b.getAttribute("data-remove"), 10), 1);
      renderBulkLines();
    });
    $("btn-gh-login").addEventListener("click", startDeviceLogin);
    $("btn-gh-login-cancel").addEventListener("click", function () { stopDeviceLogin(); $("connect-error").textContent = ""; });
    $("btn-complete-pack").addEventListener("click", function () {
      if (queueHandIdx >= 0) completeQueueLine(queueHandIdx, true);
      else completePacking();
    });
    /* Multi-craft queue buttons (brief item 1) */
    $("btn-queue-add").addEventListener("click", function () {
      var cur = currentPack(); if (!cur) return;
      gateLarge("pack", function () {
        /* No warning for adding the same craft twice — the duplicate pop-up
           fires at Print all / Hand pack all, not while adding. */
        packQueue.push({ craftId: cur.craft.id, kits: cur.kits });
        persistPackQueue();
        /* Bulk-like: the picker clears for the next line. Retest item 3:
           a manual-count Add also closes the manual box, so the picker
           resets to the default chips. */
        state.packCraft = null; $("pack-kits").value = ""; packMode = null; packKitsTouched = false; packKitsManual = false;
        renderPack();
        /* Retest item 2: after Add, back to the TOP — the craft picker
           and kit chips — not down to the new line. */
        var top = $("pack-crafts");
        if (top) top.scrollIntoView({ block: "start" });
      });
    });
    $("btn-queue-print").addEventListener("click", function () { startQueue(printQueueAll); });
    $("btn-queue-hand").addEventListener("click", function () { startQueue(startHandPackAll); });
    $("btn-queue-clear").addEventListener("click", clearQueue);
    $("btn-queue-done").addEventListener("click", function () {
      /* Done keeps the saved queue — it only leaves Queue mode. It also
         clears the pick, walk or not: otherwise leaving Queue mode
         with a pick selected shows the single-actions row on top of
         the saved row — five buttons at once (Polish item 5). Mid-walk,
         Done ends the walk and clears the loaded line's table. The
         touched/manual flags reset with the pick, mirroring the
         queue-add clear, so no stale kits error survives Done. */
      if (queueHandIdx >= 0) endQueueWalk();
      state.packCraft = null; $("pack-kits").value = ""; packMode = null;
      packKitsTouched = false; packKitsManual = false;
      queueMode = false;
      renderPack();
    });
    $("btn-bulk-clear").addEventListener("click", clearBulk);
    $("btn-print-inventory").addEventListener("click", function () { printInventory("report"); });
    $("btn-print-count").addEventListener("click", function () { printInventory("count"); });
    $("btn-reorder").addEventListener("click", function () {
      var p = $("reorder-panel"); p.hidden = !p.hidden;
      if (!p.hidden) renderReorderPanel();
    });
    $("btn-close-reorder").addEventListener("click", function () { $("reorder-panel").hidden = true; });
    $("btn-print-reorder").addEventListener("click", printReorder);
    $("btn-enter-counts").addEventListener("click", function () {
      var p = $("count-entry"); p.hidden = !p.hidden;
      if (!p.hidden) renderCountEntry();
    });
    $("btn-retry-load").addEventListener("click", function () { loadData().then(renderAll); });
    setInterval(refreshSyncStatus, 30000);
    $("btn-apply-counts").addEventListener("click", applyCounts);
    $("btn-cancel-counts").addEventListener("click", function () { $("count-entry").hidden = true; });
    $("btn-delivery").addEventListener("click", function () {
      var p = $("delivery-entry"); p.hidden = !p.hidden;
      if (!p.hidden) renderDeliveryEntry();
    });
    $("btn-apply-delivery").addEventListener("click", applyDelivery);
    $("btn-cancel-delivery").addEventListener("click", function () { $("delivery-entry").hidden = true; });
    $("set-boxes-on").addEventListener("change", function () {
      if (!requireEditor()) { renderBoxSettings(); return; }
      settings().features.boxes = $("set-boxes-on").checked;
      saveData("Default boxes " + (settings().features.boxes ? "on" : "off")).then(function () { renderAll(); });
    });
    $("rule-boxes").addEventListener("change", function () {
      var name = $("rule-boxes").value;
      if (name && rulePickedBoxes.indexOf(name) < 0) rulePickedBoxes.push(name);
      $("rule-boxes").value = "";
      renderRulePicked();
    });
    $("btn-rule-add").addEventListener("click", function () {
      if (!requireEditor()) return;
      var err = $("rule-error"); err.textContent = "";
      var craftId = $("rule-craft").value;
      var kits = parseInt($("rule-kits").value, 10);
      if (!L.validKits(kits)) { err.textContent = "Kit count must be a multiple of 6 — 6, 12, 18, 24…"; return; }
      if (!rulePickedBoxes.length) { err.textContent = "Pick at least one box from the box menu first."; return; }
      var ruleBoxes = rulePickedBoxes.slice();
      settings().boxRules = settings().boxRules.filter(function (r) { return !(r.craftId === craftId && r.kits === kits); });
      settings().boxRules.push({ craftId: craftId, kits: kits, boxes: ruleBoxes });
      rulePickedBoxes = [];
      $("rule-kits").value = "";
      saveData("Box rule added").then(function () { toast("Rule added."); renderAll(); });
    });
    $("btn-box-add").addEventListener("click", addBoxFromField);
    $("new-box-name").addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") { ev.preventDefault(); addBoxFromField(); }
    });
    $("btn-boxes-change").addEventListener("click", function () {
      var cur = currentBoxes() || [];
      var chips = $("pack-boxes-chips"); chips.innerHTML = "";
      settings().boxes.forEach(function (b) {
        var chip = document.createElement("button");
        chip.type = "button";
        chip.className = "kits-chip" + (cur.indexOf(b) >= 0 ? " selected" : "");
        chip.textContent = b;
        chip.setAttribute("data-box", b);
        chip.addEventListener("click", function () { chip.classList.toggle("selected"); });
        chips.appendChild(chip);
      });
      $("pack-boxes-edit").hidden = false;
    });
    $("btn-boxes-done").addEventListener("click", function () {
      packBoxOverride = Array.prototype.map.call(
        document.querySelectorAll("#pack-boxes-chips .kits-chip.selected"),
        function (c) { return c.getAttribute("data-box"); }
      );
      $("pack-boxes-edit").hidden = true;
      renderPackBoxes();
    });
    $("btn-connect").addEventListener("click", connectDevice);
    $("btn-disconnect").addEventListener("click", disconnectDevice);
    $("btn-export").addEventListener("click", exportBackup);
    $("import-file").addEventListener("change", function (ev) {
      if (ev.target.files && ev.target.files[0]) importBackup(ev.target.files[0]);
      ev.target.value = "";
    });

    /* render the static shells first so the page is usable while data loads */
    if (!state.data) state.data = L.emptyData();
    /* Batch C item 15: a shared link (or a reload) carrying #tab opens on
       that tab; applyTabAccess in renderAll corrects it if the tab is
       hidden (Bulk off, view-only). The post-load re-apply covers the
       gap where the empty-data shell has bulkTab OFF but the loaded
       data has it ON. */
    var initialHashTab = null;
    var hm = window.location.hash.match(/^#(pack|bulk|inventory|history|settings)$/);
    if (hm) { initialHashTab = hm[1]; activateTab(initialHashTab); }
    renderAll();
    loadData().then(function () {
      renderAll();
      if (!userNavigated && initialHashTab) {
        var b = document.querySelector('[data-tab="' + initialHashTab + '"]');
        if (b && !b.hidden && initialHashTab !== currentTab) activateTab(initialHashTab);
      }
      flushQueue();
    });
    /* v3 E4: connectivity changes drive the queue */
    window.addEventListener("online", function () { state.offline = false; refreshSyncStatus(); flushQueue(); });
    window.addEventListener("offline", function () { state.offline = true; refreshSyncStatus(); });
    /* A3: closing/reloading with anything chosen or unsaved shows the
       browser's own generic prompt (its wording can't be customized). */
    window.addEventListener("beforeunload", function (ev) {
      if (hasUnsaved()) {
        ev.preventDefault();
        ev.returnValue = "";
      }
    });

    /* Batch C item 15: Back/forward between tabs routes through the same
       A3 leave rule as a tab tap. A prompt opened this way gets Stay =
       forward-restore (in requestTab's onConfirm) and Discard = switch
       with no new history entry (history is already AT the target
       entry; activateTab's replaceState is a no-op). A sheet already
       open is closed first — except the leave prompt itself, which owns
       the decision already — and Stay restores it via saveSheetState. */
    window.addEventListener("hashchange", function () {
      if (suppressHashNav) { suppressHashNav = false; return; }
      userNavigated = true;
      var m = window.location.hash.match(/^#(pack|bulk|inventory|history|settings)$/);
      if (!m) return;
      var name = m[1];
      if (name === currentTab) return;
      var btn = document.querySelector('[data-tab="' + name + '"]');
      if (!btn || btn.hidden) { syncTabHash(currentTab); return; }
      var saved = saveSheetState();
      if (saved && saved.title === "Unsaved changes") return;
      if (!$("sheet-backdrop").hidden) dismissSheet();
      if (hasUnsaved()) {
        leaveFromHash = true;
        requestTab(name);
        return;
      }
      activateTab(name);
    });
    if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    }
  }
  document.addEventListener("DOMContentLoaded", init);
})();
