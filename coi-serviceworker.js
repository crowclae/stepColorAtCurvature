/*! coi-serviceworker v0.1.7 - Guido Zuidhof, licensed under MIT */
// Injects Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers
// so that SharedArrayBuffer (required by opencascade.js) works on GitHub Pages.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function isPassThrough(request) {
    const url = new URL(request.url);
    // chrome-extension や data: は通さない
    if (url.origin !== self.location.origin) return true;
    return false;
}

self.addEventListener("fetch", function (event) {
    const request = event.request;
    if (request.cache === "only-if-cached" && request.mode !== "same-origin") return;

    if (isPassThrough(request)) return;

    event.respondWith(
        fetch(request)
            .then((response) => {
                if (response.status === 0) return response;

                const newHeaders = new Headers(response.headers);
                newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");
                newHeaders.set("Cross-Origin-Embedder-Policy", "require-corp");
                newHeaders.set("Cross-Origin-Resource-Policy", "cross-origin");

                return new Response(response.body, {
                    status: response.status,
                    statusText: response.statusText,
                    headers: newHeaders,
                });
            })
            .catch((e) => {
                console.error(e);
                return new Response("Network error", {
                    status: 408,
                    headers: { "Content-Type": "text/plain" },
                });
            })
    );
});
