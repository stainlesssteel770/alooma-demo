/* Alooma packing helper — catalog + quantity logic.
   Shared by the browser app and the node tests.
   Quantities are stored as "qty per 6 kits" (q6) because every order is a
   multiple of 6 kits. Special rules:
   - "tier18": 1 per 3 batches (18 kits): 6-18 kits = 1, 24-36 = 2, 42-54 = 3
     (ceil(kits/18)). Used for the Heat gun and Wood burning cream
     (owner-confirmed 2026-10-22, corrected same day: "until and including
     18 is 1, 24 until and including 36 is 2").
   - "trayA"/"trayB": JCA clay trays alternate. Total trays = kits/6, split
     A,B,A,B... (6 kits: A1 B0, 12: A1 B1, 18: A2 B1, 24: A2 B2, 30: A3 B2).
*/
(function (root) {
  "use strict";

  var ITEMS = {
    /* Blooming Mirrors */
    "tree-mirror": "Tree Mirror",
    "colored-clay-tool-tray": "Clay Tray + 6 Picks",
    "white-clay": "White Clay",
    "grass-pack-of-6": "Grass (pack of 6)",
    "double-sided-tape": "Double Sided tape",
    "bm-name-labels": "BM Name Labels",
    "bm-placemat": "BM Placemat",
    "grass-template": "Grass Template",
    "bm-instructions": "BM Instructions",
    /* Tambourines */
    "tambourines": "Tambourines",
    "tamb-embellishment-tray-large": "Tam Decor Tray",
    "embellishment-containers": "Tam Decor Stack",
    "wooden-mini-spoons": "Wooden mini Spoons",
    "wooden-picks": "Wooden Picks",
    "tamb-placemats": "Tamb Placemats",
    "jerusalem-printouts": "Jerusalem Printouts",
    "tamb-instructions": "Tam Instructions",
    /* Judaic Clay-Art */
    "jca-frame": "Frame",
    "clay-tray-a": "Clay Tray A",
    "clay-tray-b": "Clay Tray B",
    "jca-embellishment-tray": "JCA Embellishment Tray",
    "bag-with-tools": "Bag with Tools",
    "jca-placemats": "JCA Placemats",
    "parchment-paper": "1/2 Parchment Paper",
    "jca-templates": "Templates",
    "jca-instructions": "JCA Instructions",
    /* Hafrashat Challah */
    "wood-board": "Wood board",
    "tray-set": "Tray set (includes 2)",
    "miniatures-bread-bag": "Miniatures bread bag",
    "wood-burning-cream": "Wood burning cream",
    "hc-placemat": "HC Placemat",
    "hc-instructions": "HC Instructions",
    "heat-gun": "Heat gun",
    /* The Cakery */
    "heart-jewelry-box": "Heart Jewelry Box",
    "cake-box": "Cake box",
    "circle-cardboard": "Circle cardboard",
    "parchment-circle": "Parchment (circle)",
    "plastic-pet-bowl": "Plastic pet bowl",
    "cream-circle-tray": "Cream circle tray",
    "sprinkles-pack": "Sprinkles (pack)",
    "faux-cherries-bag": "Faux cherries bag",
    "glue-dots": "Glue dots",
    "popsicle-stick": "Popsicle stick",
    "ck-placemat": "CK Placemat",
    "printed-posters": "Printed Posters (set of 3)",
    "poster-stands": "Poster stands (for quotes)",
    "ck-name-labels": "CK Name labels",
    "apron": "Apron",
    "gloves": "Gloves",
    "ck-instructions": "CK Instructions",
    /* Miniature Interiors */
    "mi-frames": "Frames",
    "white-block-pack": "White Block (pack of 6)",
    "miniatures-tray-1": "Miniatures tray #1",
    "tools-supplies-tray-2": "Supplies tray #2",
    "scrapbook-paper-pack": "Scrapbook pack",
    "mi-name-label": "MI Name label",
    "mi-placemats": "MI Placemats",
    "mi-instructions": "MI Instructions",
    "english-ay-printout": "AY - by request",
    /* Shared (counted once in inventory, used by several crafts) */
    "scissors": "Scissors",
    "tacky-glue": "Tacky Glue",
    "permanent-markers": "Permanent Markers"
  };

  function line(item, q6) { return { item: item, q6: q6 }; }
  function tier(item) { return { item: item, rule: "tier18" }; }

  var CRAFTS = [
    {
      id: "bm", code: "BM", name: "Blooming Mirrors",
      items: [
        line("tree-mirror", 6),
        line("colored-clay-tool-tray", 1),
        line("white-clay", 6),
        line("grass-pack-of-6", 1),
        line("double-sided-tape", 2),
        line("tacky-glue", 3),
        line("scissors", 3),
        line("bm-name-labels", 6),
        line("permanent-markers", 1),
        line("bm-placemat", 6),
        line("grass-template", 6),
        line("bm-instructions", 6)
      ]
    },
    {
      id: "tam", code: "TAM", name: "Tambourines",
      items: [
        line("tambourines", 6),
        line("tamb-embellishment-tray-large", 1),
        line("embellishment-containers", 1),
        line("wooden-mini-spoons", 6),
        line("wooden-picks", 6),
        line("scissors", 3),
        line("tacky-glue", 6),
        line("tamb-placemats", 6),
        line("jerusalem-printouts", 6),
        line("tamb-instructions", 6)
      ]
    },
    {
      id: "jca", code: "JCA", name: "Judaic Clay-Art",
      items: [
        line("jca-frame", 6),
        { item: "clay-tray-a", rule: "trayA" },
        { item: "clay-tray-b", rule: "trayB" },
        line("jca-embellishment-tray", 1),
        line("bag-with-tools", 1),
        line("jca-placemats", 6),
        line("parchment-paper", 6),
        line("jca-templates", 6),
        line("jca-instructions", 2)
      ]
    },
    {
      id: "hcb", code: "HCB", name: "Hafrashat Challah",
      items: [
        line("wood-board", 6),
        line("tray-set", 1),
        line("miniatures-bread-bag", 6),
        tier("wood-burning-cream"),
        line("hc-placemat", 6),
        line("hc-instructions", 6),
        tier("heat-gun")
      ]
    },
    {
      id: "cak", code: "CAK", name: "The Cakery",
      items: [
        line("heart-jewelry-box", 6),
        line("cake-box", 6),
        line("circle-cardboard", 6),
        line("parchment-circle", 6),
        line("plastic-pet-bowl", 6),
        line("cream-circle-tray", 1),
        line("sprinkles-pack", 1),
        line("faux-cherries-bag", 1),
        line("scissors", 2),
        line("glue-dots", 1),
        line("popsicle-stick", 6),
        line("ck-placemat", 6),
        line("printed-posters", 1),
        line("poster-stands", 3),
        line("ck-name-labels", 6),
        line("permanent-markers", 1),
        line("apron", 6),
        line("gloves", 6),
        line("ck-instructions", 6)
      ]
    },
    {
      id: "mi", code: "MI", name: "Miniature Interiors",
      items: [
        line("mi-frames", 6),
        line("white-block-pack", 1),
        line("miniatures-tray-1", 1),
        line("tools-supplies-tray-2", 1),
        line("scrapbook-paper-pack", 1),
        line("scissors", 3),
        line("mi-name-label", 6),
        line("permanent-markers", 1),
        line("mi-placemats", 6),
        line("mi-instructions", 6),
        line("english-ay-printout", 6)
      ]
    }
  ];

  /* ---------- Active catalog (recipe editor, sub-batch a) ----------
     The ITEMS/CRAFTS above stay verbatim as the built-in defaults. The app
     sets the active catalog from synced data (settings.recipes /
     settings.customItems) after every load; everything below reads the
     active catalog through curCrafts()/curItems(), so call signatures
     don't change. setCatalog(null) restores the built-ins (used by tests).
     New line shapes (recipes use `lines`, defaults use `items`):
     - per-N: { item, qty, per } (per defaults to 6).
     - alternating pair: { items: [a, b], qty, per: 6 } — one editor row,
       two pack entries; total = kits/6 * qty, first ceil(total/2),
       second floor(total/2). This is how JCA's trays convert. */
  var activeCrafts = CRAFTS;
  var activeItems = ITEMS; /* id -> display-name string, exactly as before */
  var activeUnits = {};    /* custom item id -> unit string; built-ins "" */
  function curCrafts() { return activeCrafts; }
  function curItems() { return activeItems; }
  function craftLines(c) { return c.lines || c.items; }
  function itemName(id) { var n = activeItems[id]; return typeof n === "string" ? n : ""; }
  function itemUnit(id) { return activeUnits[id] || ""; }
  function convertLine(ln) {
    if (ln.rule === "tier18") return { item: ln.item, qty: 1, per: 18 };
    return { item: ln.item, qty: ln.q6, per: 6 };
  }
  function builtInRecipes() {
    return CRAFTS.map(function (c) {
      var lines = [];
      for (var i = 0; i < c.items.length; i++) {
        var ln = c.items[i];
        if (ln.rule === "trayA") {
          var nxt = c.items[i + 1];
          if (nxt && nxt.rule === "trayB") {
            lines.push({ items: [ln.item, nxt.item], qty: 1, per: 6 });
            i++; /* the trayB line is consumed by the pair */
          } else {
            lines.push({ item: ln.item, qty: 1, per: 6 }); /* unreachable for the defaults; defensive */
          }
        } else if (ln.rule === "trayB") {
          lines.push({ item: ln.item, qty: 1, per: 6 }); /* unpaired trayB; defensive */
        } else {
          lines.push(convertLine(ln));
        }
      }
      return { id: c.id, code: c.code, name: c.name, hidden: false, lines: lines };
    });
  }
  function isValidLine(ln) {
    if (!ln || typeof ln !== "object") return false;
    if (Array.isArray(ln.items)) {
      return ln.items.length === 2 && typeof ln.items[0] === "string" && typeof ln.items[1] === "string" &&
        ln.items[0] !== ln.items[1] && Number.isInteger(ln.qty) && ln.qty > 0;
    }
    return typeof ln.item === "string" && !!ln.item &&
      Number.isInteger(ln.qty) && ln.qty > 0 &&
      (ln.per === undefined || (Number.isInteger(ln.per) && ln.per > 0));
  }
  function normalizeRecipes(input) {
    if (!Array.isArray(input) || !input.length) return builtInRecipes();
    var out = [], seenIds = {}, seenCodes = {};
    input.forEach(function (r) {
      if (!r || typeof r.id !== "string" || !r.id || seenIds[r.id]) return;
      if (typeof r.name !== "string" || !r.name.trim()) return;
      if (typeof r.code !== "string" || !/^[A-Za-z]{2,4}$/.test(r.code)) return;
      if (seenCodes[r.code.toUpperCase()]) return;
      if (!Array.isArray(r.lines)) return;
      var lines = [];
      r.lines.forEach(function (ln) {
        if (!isValidLine(ln)) return;
        if (Array.isArray(ln.items)) lines.push({ items: [ln.items[0], ln.items[1]], qty: ln.qty, per: 6 });
        else lines.push({ item: ln.item, qty: ln.qty, per: ln.per || 6 });
      });
      seenIds[r.id] = true;
      seenCodes[r.code.toUpperCase()] = true;
      out.push({ id: r.id, code: r.code.toUpperCase(), name: r.name, hidden: !!r.hidden, lines: lines });
    });
    return out.length ? out : builtInRecipes();
  }
  function normalizeCustomItems(input) {
    if (!Array.isArray(input)) return [];
    var out = [], seen = {};
    input.forEach(function (it) {
      if (!it || typeof it.id !== "string" || !it.id || seen[it.id]) return;
      if (typeof it.name !== "string" || !it.name.trim()) return;
      if (it.id in ITEMS) return; /* cannot shadow a built-in id */
      seen[it.id] = true;
      out.push({ id: it.id, name: it.name, unit: typeof it.unit === "string" ? it.unit : "" });
    });
    return out;
  }
  function setCatalog(recipes, customItems) {
    var customs = normalizeCustomItems(customItems);
    activeCrafts = normalizeRecipes(recipes);
    activeItems = Object.assign({}, ITEMS);
    activeUnits = {};
    customs.forEach(function (it) { activeItems[it.id] = it.name; activeUnits[it.id] = it.unit; });
  }
  function resetCatalog() {
    activeCrafts = CRAFTS;
    activeItems = ITEMS;
    activeUnits = {};
  }
  /* Fix-round item 18: the old MAX_LINES_ONE_LABEL = 9 constant is
     deleted — stale since the pack-sheet padding trim (BM's 12 lines
     fit one label now), and nothing referenced it. Spill stays the
     fallback for genuinely oversize sheets. */

  function craftById(id) {
    var crafts = curCrafts();
    for (var i = 0; i < crafts.length; i++) if (crafts[i].id === id) return crafts[i];
    return null;
  }

  function validKits(kits) {
    return Number.isInteger(kits) && kits > 0 && kits % 6 === 0;
  }

  /* Quantity of one recipe line for an order of `kits` kits.
     Fix 1 (approved): per-6 lines keep TODAY'S formula verbatim
     (qty * (kits/6), fractional for non-multiple manual counts); ceil
     applies ONLY to per!=6 lines (reproduces tier18 exactly). Old shapes
     (q6 / tier18 / trayA / trayB) keep working for the built-in defaults.
     For a pair line, lineQty returns the COMBINED total; use pairQtys
     for the A/B split. */
  function lineQty(ln, kits) {
    if (Array.isArray(ln.items)) return (kits / 6) * ln.qty;
    if (typeof ln.qty === "number") {
      var per = (Number.isInteger(ln.per) && ln.per > 0) ? ln.per : 6;
      if (per === 6) return ln.qty * (kits / 6);
      return Math.ceil(kits / per) * ln.qty;
    }
    if (ln.rule === "tier18") return Math.ceil(kits / 18);
    if (ln.rule === "trayA") return Math.ceil(kits / 6 / 2);
    if (ln.rule === "trayB") return Math.floor(kits / 6 / 2);
    return ln.q6 * (kits / 6);
  }

  /* A/B split of an alternating-pair line: [first, second]. */
  function pairQtys(ln, kits) {
    var total = (kits / 6) * ln.qty;
    return [Math.ceil(total / 2), Math.floor(total / 2)];
  }

  /* Full pack list for a craft + kit count: [{item, name, qty, per}] in
     recipe order, where per is the kits-per-one rate (6 normally, 18
     for tier18 lines). Pair lines expand to two entries (A then B),
     so converted JCA packs exactly like the old trayA/trayB lines did. */
  function computePack(craftId, kits) {
    var craft = craftById(craftId);
    if (!craft) throw new Error("Unknown craft: " + craftId);
    if (!validKits(kits)) throw new Error("Kits must be a positive multiple of 6 (got " + kits + ")");
    var items = curItems(), out = [];
    craftLines(craft).forEach(function (ln) {
      if (Array.isArray(ln.items)) {
        var q = pairQtys(ln, kits);
        out.push({ item: ln.items[0], name: items[ln.items[0]], qty: q[0], per: 6 });
        out.push({ item: ln.items[1], name: items[ln.items[1]], qty: q[1], per: 6 });
      } else {
        /* Fix-round item 17: carry the rate so sheets can show 1/18
           instead of a bare 1 for tier18 lines. */
        var per = 6;
        if (typeof ln.qty === "number") per = (Number.isInteger(ln.per) && ln.per > 0) ? ln.per : 6;
        else if (ln.rule === "tier18") per = 18;
        out.push({ item: ln.item, name: items[ln.item], qty: lineQty(ln, kits), per: per });
      }
    });
    return out;
  }

  function sku(craftId, kits) {
    var craft = craftById(craftId);
    return craft.code + "-" + kits;
  }

  /* Which crafts use each item (for inventory grouping). Pair lines
     count for both of their items. */
  function itemCrafts() {
    var map = {};
    curCrafts().forEach(function (c) {
      craftLines(c).forEach(function (ln) {
        var ids = Array.isArray(ln.items) ? ln.items : [ln.item];
        ids.forEach(function (id) { (map[id] = map[id] || []).push(c.id); });
      });
    });
    return map;
  }

  /* Inventory groups: items used by >1 craft go under "shared"; the rest
     under their only craft. Returns [{id, name, items:[itemId...]}] in
     craft order with Shared last, plus a trailing "Added items" group for
     catalog items no craft uses yet (new items, before any recipe uses
     them). Hidden crafts still count as using their items. */
  function inventoryGroups() {
    var usage = itemCrafts();
    var groups = curCrafts().map(function (c) {
      var ids = [];
      craftLines(c).forEach(function (ln) {
        var lineIds = Array.isArray(ln.items) ? ln.items : [ln.item];
        lineIds.forEach(function (id) { if (ids.indexOf(id) < 0) ids.push(id); });
      });
      return {
        id: c.id, name: c.name,
        items: ids.filter(function (id) { return usage[id].length === 1; })
      };
    });
    var shared = Object.keys(curItems()).filter(function (id) { return usage[id] && usage[id].length > 1; });
    /* keep shared items in a stable, sensible order */
    var sharedOrder = ["scissors", "tacky-glue", "permanent-markers"];
    shared.sort(function (a, b) {
      var oa = sharedOrder.indexOf(a), ob = sharedOrder.indexOf(b);
      return (oa < 0 ? 999 : oa) - (ob < 0 ? 999 : ob);
    });
    groups.push({ id: "shared", name: "Shared items", items: shared });
    var added = Object.keys(curItems()).filter(function (id) { return !usage[id]; });
    if (added.length) groups.push({ id: "added", name: "Added items", items: added });
    return groups;
  }

  function emptyData() {
    var inv = {};
    Object.keys(curItems()).forEach(function (id) { inv[id] = { qty: 0, threshold: null }; });
    return { version: 1, inventory: inv, history: [] };
  }

  /* ---------- Settings (Batch C): lives in data.json under "settings" so
     every device sees the same rules. Old data files have no settings
     section — normalizeSettings fills defaults with both features OFF,
     so nothing changes until a feature is switched on in Settings. */
  var BOX_IDS = ["A", "B", "C"]; /* legacy ids — only used to migrate old settings */
  function defaultSettings() {
    return {
      features: { boxes: false, bins: false },
      boxes: ["Box A", "Box B", "Box C"],
      boxRules: [],
      bins: {},
      recipes: builtInRecipes(),
      customItems: []
    };
  }
  function normalizeSettings(s) {
    var d = defaultSettings();
    if (!s || typeof s !== "object") return d;
    if (!s.features || typeof s.features !== "object") s.features = d.features;
    if (typeof s.features.boxes !== "boolean") s.features.boxes = false;
    if (typeof s.features.bins !== "boolean") s.features.bins = false;
    /* Boxes are a free-form list of names (the user adds as many as he has).
       Migrate the original fixed shape {A:{name,size},B:...,C:...}: the list
       becomes the names, and rules that referenced letters get the names. */
    var idToName = null;
    if (Array.isArray(s.boxes)) {
      var clean = [];
      s.boxes.forEach(function (b) {
        if (typeof b === "string" && b.trim() && clean.indexOf(b.trim()) < 0) clean.push(b.trim());
      });
      s.boxes = clean;
    } else if (s.boxes && typeof s.boxes === "object") {
      idToName = {};
      var names = [];
      BOX_IDS.forEach(function (b) {
        var nm = (s.boxes[b] && typeof s.boxes[b].name === "string" && s.boxes[b].name.trim()) || ("Box " + b);
        idToName[b] = nm;
        if (names.indexOf(nm) < 0) names.push(nm);
      });
      s.boxes = names;
    } else {
      s.boxes = d.boxes.slice();
    }
    /* Recipes + custom items (editor sub-batch a): normalized here so stored
       data is always clean. Box rules below validate against THESE recipes
       (not the active catalog), so a merged rule for a new craft survives
       even when the catalog hasn't been set from this data yet. Old data
       without recipes normalizes to the built-ins, so old rules keep working. */
    s.recipes = normalizeRecipes(s.recipes);
    s.customItems = normalizeCustomItems(s.customItems);
    var knownCrafts = {};
    s.recipes.forEach(function (r) { knownCrafts[r.id] = true; });
    if (!Array.isArray(s.boxRules)) s.boxRules = [];
    s.boxRules = s.boxRules.filter(function (r) {
      return r && knownCrafts[r.craftId] && validKits(r.kits) && Array.isArray(r.boxes) && r.boxes.length > 0;
    }).map(function (r) {
      var mapped = [];
      r.boxes.forEach(function (b) {
        var nm = idToName && idToName[b] ? idToName[b] : b;
        if (typeof nm === "string" && s.boxes.indexOf(nm) >= 0 && mapped.indexOf(nm) < 0) mapped.push(nm);
      });
      return { craftId: r.craftId, kits: r.kits, boxes: mapped };
    }).filter(function (r) { return r.boxes.length > 0; });
    if (!s.bins || typeof s.bins !== "object") s.bins = {};
    return s;
  }
  /* Boxes for an exact craft+kits match, or null. Only when the feature is on. */
  function boxRuleFor(settings, craftId, kits) {
    if (!settings || !settings.features || !settings.features.boxes) return null;
    var rules = settings.boxRules || [];
    for (var i = 0; i < rules.length; i++) {
      if (rules[i].craftId === craftId && rules[i].kits === kits) return rules[i].boxes.slice();
    }
    return null;
  }
  function boxLabel(settings, boxName) {
    return typeof boxName === "string" ? boxName : "Box " + boxName;
  }

  /* Bin locations (Batch C2): placeholders B01, B02... in inventory
     order until an item's bin is set in Inventory. */
  function defaultBins() {
    var map = {}, n = 0;
    inventoryGroups().forEach(function (g) {
      g.items.forEach(function (id) {
        n++;
        map[id] = "B" + (n < 10 ? "0" : "") + n;
      });
    });
    return map;
  }
  function binFor(settings, itemId) {
    if (settings && settings.bins && typeof settings.bins[itemId] === "string" && settings.bins[itemId]) {
      return settings.bins[itemId];
    }
    return defaultBins()[itemId] || "";
  }
  function boxesText(settings, boxNames) {
    return (boxNames || []).join(" + ");
  }

  /* Apply a history entry's effects to an inventory object (mutates inv). */
  function applyEffects(inv, effects, sign) {
    effects.forEach(function (e) {
      if (!inv[e.item]) inv[e.item] = { qty: 0, threshold: null };
      inv[e.item].qty += sign * e.delta;
    });
  }

  var api = {
    craftById: craftById, validKits: validKits,
    lineQty: lineQty, pairQtys: pairQtys, computePack: computePack, sku: sku,
    itemCrafts: itemCrafts, inventoryGroups: inventoryGroups,
    emptyData: emptyData, applyEffects: applyEffects,
    BOX_IDS: BOX_IDS, defaultSettings: defaultSettings,
    normalizeSettings: normalizeSettings, boxRuleFor: boxRuleFor,
    boxLabel: boxLabel, boxesText: boxesText,
    defaultBins: defaultBins, binFor: binFor,
    setCatalog: setCatalog, resetCatalog: resetCatalog,
    builtInRecipes: builtInRecipes, normalizeRecipes: normalizeRecipes,
    normalizeCustomItems: normalizeCustomItems,
    itemName: itemName, itemUnit: itemUnit
  };
  /* ITEMS/CRAFTS stay live views of the ACTIVE catalog: the app and the
     tests read L.ITEMS / L.CRAFTS everywhere, and those reads must see
     custom crafts/items once a catalog is set. (Defaults are still the
     values before any setCatalog call, so existing suites are unaffected.) */
  Object.defineProperty(api, "ITEMS", { get: function () { return activeItems; } });
  Object.defineProperty(api, "CRAFTS", { get: function () { return activeCrafts; } });
  root.ALOOMA = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
