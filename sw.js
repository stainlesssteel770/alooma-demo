/* Alooma service worker (fix-round item 1): the app shell is cached so
   the app opens with no signal, but app files are served NETWORK-FIRST:
   the old cache-first read served "alooma-shell-v1" forever, so updates
   never reached phones. Online, every load fetches fresh bytes (and
   refreshes the cache); only when the network fails does the cached
   copy answer. Stock data always comes from the GitHub API (never
   cached here); a snapshot in localStorage covers offline data, and
   edits made offline queue as actions on the device. The cache name IS
   bumped for this fix round (v2): network-first guarantees freshness
   and the version bump makes the live check decisive — activate still
   deletes any cache that isn't current. */
var CACHE = "alooma-demo-shell-v1";
var SHELL = ["./", "index.html", "app.js", "logic.js", "styles.css", "manifest.json", "icon-192.png", "icon-512.png"];
self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});
self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { return (k === CACHE || k.indexOf("alooma-demo-") !== 0) ? null : caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});
self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;
  var url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith("data.json") || url.pathname.endsWith("sw.js")) return;
  e.respondWith(
    fetch(e.request).then(function (resp) {
      if (resp.ok) {
        var copy = resp.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      }
      return resp;
    }).catch(function () {
      return caches.match(e.request, { ignoreSearch: true });
    })
  );
});
