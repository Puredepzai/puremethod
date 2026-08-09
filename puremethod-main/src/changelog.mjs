import { changelogData } from "./changelog-data.mjs";

const STORAGE_KEY = "noblur-last-seen-version";

export function getLatestVersion() {
    if (!changelogData || changelogData.length === 0) {
        return null;
    }
    return changelogData[0].version;
}

export function hasNewVersion() {
    const latest = getLatestVersion();
    if (!latest) return false;

    try {
        const lastSeen = localStorage.getItem(STORAGE_KEY);
        return lastSeen !== latest;
    } catch {
        return true;
    }
}

function markAsSeen(version) {
    try {
        localStorage.setItem(STORAGE_KEY, version);
    } catch {}
}

function renderPanel(latest) {
    const panel = document.createElement("div");
    panel.className = "changelog-panel changelog-panel-hidden";

    const header = document.createElement("div");
    header.className = "changelog-header";

    const title = document.createElement("span");
    title.className = "changelog-title";
    title.textContent = "WHAT'S NEW";

    const closeBtn = document.createElement("span");
    closeBtn.className = "changelog-close";
    closeBtn.textContent = "×";
    closeBtn.setAttribute("aria-label", "Close changelog");
    closeBtn.setAttribute("role", "button");
    closeBtn.setAttribute("tabindex", "0");

    header.appendChild(title);
    header.appendChild(closeBtn);

    const content = document.createElement("div");
    content.className = "changelog-content";

    const versionDiv = document.createElement("div");
    versionDiv.className = "changelog-version";

    const versionBadge = document.createElement("span");
    versionBadge.className = "changelog-version-badge";
    versionBadge.textContent = `v${latest.version}`;

    const dateSpan = document.createElement("span");
    dateSpan.className = "changelog-date";
    dateSpan.textContent = latest.date;

    versionDiv.appendChild(versionBadge);
    versionDiv.appendChild(dateSpan);

    const list = document.createElement("ul");
    list.className = "changelog-list";

    for (const change of latest.changes) {
        const li = document.createElement("li");
        li.textContent = change;
        list.appendChild(li);
    }

    content.appendChild(versionDiv);
    content.appendChild(list);

    panel.appendChild(header);
    panel.appendChild(content);

    return panel;
}

function renderBadge(isNew, version) {
    const badge = document.createElement("span");
    badge.className = "changelog-badge";
    badge.setAttribute("role", "button");
    badge.setAttribute("aria-label", "View changelog");
    badge.setAttribute("aria-expanded", "false");
    badge.setAttribute("tabindex", "0");

    if (isNew) {
        badge.textContent = "NEW";
        badge.classList.add("changelog-badge-new");
    } else {
        badge.textContent = `v${version}`;
        badge.classList.add("changelog-badge-version");
    }

    return badge;
}

function togglePanel(panel, badge) {
    const isOpen = !panel.classList.contains("changelog-panel-hidden");

    if (isOpen) {
        panel.classList.add("changelog-panel-hidden");
        badge.setAttribute("aria-expanded", "false");
    } else {
        panel.classList.remove("changelog-panel-hidden");
        badge.setAttribute("aria-expanded", "true");

        const latest = getLatestVersion();
        if (latest) {
            markAsSeen(latest);
            badge.textContent = `v${latest}`;
            badge.classList.remove("changelog-badge-new");
            badge.classList.add("changelog-badge-version");
        }
    }
}

export function initChangelog(container) {
    const latest = getLatestVersion();
    if (!latest) return;

    const isNew = hasNewVersion();
    const badge = renderBadge(isNew, latest);
    const panel = renderPanel(changelogData[0]);

    container.appendChild(badge);
    document.body.appendChild(panel);

    badge.addEventListener("click", () => togglePanel(panel, badge));
    badge.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            togglePanel(panel, badge);
        }
    });

    const closeBtn = panel.querySelector(".changelog-close");
    closeBtn.addEventListener("click", () => togglePanel(panel, badge));
    closeBtn.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            togglePanel(panel, badge);
        }
    });

    document.addEventListener("keydown", (e) => {
        if (
            e.key === "Escape" &&
            !panel.classList.contains("changelog-panel-hidden")
        ) {
            togglePanel(panel, badge);
        }
    });

    document.addEventListener("click", (e) => {
        if (!panel.classList.contains("changelog-panel-hidden")) {
            const clickedOutside =
                !panel.contains(e.target) && e.target !== badge;
            if (clickedOutside) {
                togglePanel(panel, badge);
            }
        }
    });
}
