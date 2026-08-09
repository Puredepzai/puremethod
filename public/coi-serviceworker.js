let coepCredentialless = false;
if (typeof window === "undefined") {
    self.addEventListener("install", () => self.skipWaiting());
    self.addEventListener("activate", (event) =>
        event.waitUntil(self.clients.claim()),
    );

    self.addEventListener("message", (ev) => {
        if (!ev.data) {
            return;
        }
        if (ev.data.type === "deregister") {
            self.registration
                .unregister()
                .then(() => {
                    return self.clients.matchAll();
                })
                .then((clients) => {
                    for (const client of clients) {
                        client.navigate(client.url);
                    }
                });
        } else if (ev.data.type === "coepCredentialless") {
            coepCredentialless = ev.data.value;
        }
    });

    self.addEventListener("fetch", (event) => {
        const r = event.request;
        if (!r.url.startsWith(self.location.origin)) {
            return;
        }
        if (
            r.destination === "worker" ||
            r.destination === "sharedworker" ||
            r.url.includes("worker")
        ) {
            return;
        }
        if (r.cache === "only-if-cached" && r.mode !== "same-origin") {
            return;
        }

        const request =
            coepCredentialless && r.mode === "no-cors"
                ? new Request(r, {
                      credentials: "omit",
                  })
                : r;
        event.respondWith(
            fetch(request)
                .then((response) => {
                    if (response.status === 0) {
                        return response;
                    }

                    const newHeaders = new Headers(response.headers);
                    newHeaders.set(
                        "Cross-Origin-Embedder-Policy",
                        coepCredentialless ? "credentialless" : "require-corp",
                    );
                    if (!coepCredentialless) {
                        newHeaders.set(
                            "Cross-Origin-Resource-Policy",
                            "cross-origin",
                        );
                    }
                    newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");

                    return new Response(response.body, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: newHeaders,
                    });
                })
                .catch((e) => console.error(e)),
        );
    });
} else {
    (() => {
        const coi = {
            shouldRegister: () =>
                !["localhost", "127.0.0.1", "::1"].some((h) =>
                    window.location.hostname.includes(h),
                ),
            shouldDeregister: () =>
                ["localhost", "127.0.0.1", "::1"].some((h) =>
                    window.location.hostname.includes(h),
                ),
            coepCredentialless: () => !(window.chrome || window.netscape),
            doReload: () => window.location.reload(),
            quiet: false,
            ...window.coi,
        };

        const n = navigator;

        if (coi.shouldDeregister()) {
            if (n.serviceWorker) {
                n.serviceWorker.getRegistrations().then((registrations) => {
                    let unregistered = false;
                    for (const registration of registrations) {
                        registration.unregister();
                        unregistered = true;
                    }
                    if (unregistered) {
                        coi.doReload();
                    }
                });
            }
            return;
        }

        if (n.serviceWorker?.controller) {
            n.serviceWorker.controller.postMessage({
                type: "coepCredentialless",
                value: coi.coepCredentialless(),
            });
        }

        if (window.crossOriginIsolated !== false || !coi.shouldRegister())
            return;

        if (!window.isSecureContext) {
            !coi.quiet &&
                console.log(
                    "COOP/COEP Service Worker not registered, a secure context is required.",
                );
            return;
        }

        if (n.serviceWorker) {
            n.serviceWorker.register(window.document.currentScript.src).then(
                (registration) => {
                    !coi.quiet &&
                        console.log(
                            "COOP/COEP Service Worker registered",
                            registration.scope,
                        );

                    registration.addEventListener("updatefound", () => {
                        !coi.quiet &&
                            console.log(
                                "Reloading page to make use of updated COOP/COEP Service Worker.",
                            );
                        coi.doReload();
                    });

                    if (registration.active && !n.serviceWorker.controller) {
                        !coi.quiet &&
                            console.log(
                                "Reloading page to make use of COOP/COEP Service Worker.",
                            );
                        coi.doReload();
                    }
                },
                (err) => {
                    !coi.quiet &&
                        console.error(
                            "COOP/COEP Service Worker failed to register:",
                            err,
                        );
                },
            );
        }
    })();
}
