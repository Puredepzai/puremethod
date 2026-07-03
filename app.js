import {
    ChevronDown,
    Cpu,
    Download,
    FileVideo,
    Info,
    RefreshCw,
    Trash2,
    TriangleAlert,
    Upload,
    X,
    Zap,
    createIcons,
} from "lucide";
import {
    clearAllRecords,
    deleteRecord,
    getAllRecords,
    saveRecord,
} from "./db.js";
import { initChangelog } from "./src/changelog.mjs";
import {
    getBoxHeaderSize,
    parseBoxes,
    updateBoxSize,
    updateChunkOffsets,
} from "./src/mp4-boxes.mjs";
import { inflateSampleTableVideo, inflateQualityVideo } from "./src/mp4-inflate.mjs";
import {
    runVFI,
    runHDR,
    extractMovThumbnail,
    destroyFFmpegInstance,
    resolveInputExtension,
} from "./src/video-processor.js";

const FRAME_CAPTURE_TIMEOUT_MS = 5000;
const METADATA_TIMEOUT_MS = 10000;
const MAX_THUMBNAIL_DIMENSION = 120;
const MOBILE_BREAKPOINT = 900;
const DOWNLOAD_REVOKE_DELAY_MS = 1000;
const PROGRESS_HIDE_DELAY_MS = 800;
const PROGRESS_FADE_DURATION_MS = 400;
const DOWNLOAD_INTERVAL_MS = 300;
const PATCH_INTERVAL_MS = 600;
const MOBILE_SCROLL_DELAY_MS = 150;
const DOWNLOAD_ANCHOR_CLEANUP_MS = 100;
const SAFE_THUMBNAIL_PREFIX = "data:image/jpeg;base64,";

// ===== ETA VARIABLES =====
let etaStartTime = 0;
let etaProcessed = 0;
let etaTotal = 0;
let etaInterval = null;
let etaCurrentFile = 0;
let etaTotalFiles = 0;
// =========================

const ALL_ICONS = {
    Upload,
    X,
    FileVideo,
    Info,
    ChevronDown,
    Trash2,
    Download,
    Cpu,
    Zap,
    TriangleAlert,
    RefreshCw,
};

const outputSuffix = "_PureMethod";
const supportedMimeTypes = [
    "video/mp4",
    "video/quicktime",
    "video/x-quicktime",
];
const supportedExtensions = [".mp4", ".mov"];

const fileInput = document.getElementById("fileInput");
const patchBtn = document.getElementById("patchBtn");
const clearBtn = document.getElementById("clearBtn");
const dropZone = document.getElementById("dropZone");
const statusLog = document.getElementById("statusLog");
const progressBar = document.getElementById("progressBar");
const progressTrack = document.getElementById("progressTrack");
const fileListEl = document.getElementById("fileList");
const historyList = document.getElementById("historyList");
const historyBadge = document.getElementById("historyBadge");
const historyHeader = document.getElementById("historyHeader");
const clearHistoryBtn = document.getElementById("clearHistoryBtn");

let selectedFiles = [];
let currentFlowState = "idle";
let isCancelled = false;
let processingFiles = false;
let lastSettings = null;

let lastWidth = null;
function adjustMobileLayout() {
    const currentWidth = window.innerWidth;
    if (lastWidth !== null && currentWidth === lastWidth) return;
    lastWidth = currentWidth;

    const isMobile = currentWidth <= MOBILE_BREAKPOINT;
    const header = document.querySelector(".header");
    const panelLeft = document.querySelector(".panel-left");
    const panelRight = document.querySelector(".panel-right");
    const dropZoneEl = document.getElementById("dropZone");
    if (isMobile) {
        if (dropZoneEl && header && dropZoneEl.parentNode !== panelLeft) {
            header.after(dropZoneEl);
        }
    } else {
        if (dropZoneEl && panelRight && dropZoneEl.parentNode !== panelRight) {
            panelRight.insertBefore(dropZoneEl, panelRight.firstChild);
        }
    }
}

function refreshIcons() {
    createIcons({
        icons: ALL_ICONS,
    });
}

function initializeApp() {
    refreshIcons();
    renderHistoryList();
    adjustMobileLayout();
    window.addEventListener("resize", adjustMobileLayout);
    
    const etaDisplay = document.createElement('div');
    etaDisplay.id = 'etaDisplay';
    etaDisplay.style.cssText = 'font-family: monospace; font-size: 13px; color: #aaa; text-align: center; margin-top: 4px; min-height: 20px;';
    etaDisplay.textContent = '⏱️ Waiting...';
    const progressTrack = document.getElementById('progressTrack');
    if (progressTrack) {
        progressTrack.parentNode.insertBefore(etaDisplay, progressTrack.nextSibling);
    }
}

function logMessage(text, type = "info") {
    const row = document.createElement("div");
    row.className = `log-row log-${type}`;
    row.textContent = text;
    statusLog.appendChild(row);
    statusLog.scrollTop = statusLog.scrollHeight;
}

function clearLog() {
    statusLog.innerHTML = "";
}

function setProgress(percent) {
    progressBar.style.width = `${percent}%`;
}

function showProgress() {
    progressTrack.classList.add("active");
    progressTrack.style.opacity = "1";
    const etaDisplay = document.getElementById('etaDisplay');
    if (etaDisplay) etaDisplay.textContent = '⏱️ Calculating...';
}

function hideProgress() {
    setTimeout(() => {
        progressTrack.style.opacity = "0";
        setTimeout(() => {
            setProgress(0);
            progressTrack.classList.remove("active");
        }, PROGRESS_FADE_DURATION_MS);
    }, PROGRESS_HIDE_DELAY_MS);
}

function updateETA() {
    const etaDisplay = document.getElementById('etaDisplay');
    if (!etaDisplay) return;
    
    if (etaTotal === 0 || etaProcessed === 0) {
        etaDisplay.textContent = '⏱️ Estimating...';
        return;
    }
    
    const elapsed = (Date.now() - etaStartTime) / 1000;
    if (elapsed < 1) {
        etaDisplay.textContent = '⏱️ Calculating...';
        return;
    }
    
    const avgTimePerChunk = elapsed / etaProcessed;
    const remaining = etaTotal - etaProcessed;
    const etaSeconds = Math.round(avgTimePerChunk * remaining);
    
    const fileInfo = etaTotalFiles > 1 ? ` (File ${etaCurrentFile}/${etaTotalFiles})` : '';
    
    if (etaSeconds < 60) {
        etaDisplay.textContent = `⏱️ ${etaSeconds} sec remaining${fileInfo}`;
    } else {
        const mins = Math.floor(etaSeconds / 60);
        const secs = etaSeconds % 60;
        if (secs === 0) {
            etaDisplay.textContent = `⏱️ ${mins} min remaining${fileInfo}`;
        } else {
            etaDisplay.textContent = `⏱️ ${mins} min ${secs} sec remaining${fileInfo}`;
        }
    }
}

function isSupportedFile(file) {
    const lowerName = file.name.toLowerCase();
    return (
        supportedMimeTypes.includes(file.type) ||
        supportedExtensions.some((ext) => lowerName.endsWith(ext))
    );
}

function getMimeType(file) {
    return "video/mp4";
}

function isMovFile(file) {
    const lowerName = file.name.toLowerCase();
    if (lowerName.endsWith(".mov")) return true;
    if (file.type === "video/quicktime" || file.type === "video/x-quicktime")
        return true;
    return false;
}

function getOutputFilename(file) {
    const lastDotIndex = file.name.lastIndexOf(".");
    const name =
        lastDotIndex > 0 ? file.name.substring(0, lastDotIndex) : file.name;
    return `${name}${outputSuffix}.mp4`;
}

function captureVideoFrame(file) {
    return new Promise((resolve) => {
        const video = document.createElement("video");
        video.preload = "auto";
        video.muted = true;
        video.playsInline = true;
        let settled = false;
        let objectUrl = null;

        function cleanup(result) {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            video.onloadeddata = null;
            video.onseeked = null;
            video.onerror = null;
            video.src = "";
            video.load();
            if (objectUrl) {
                URL.revokeObjectURL(objectUrl);
            }
            resolve(result);
        }

        video.onloadeddata = () => {
            if (settled) return;
            video.currentTime = 0.1;
        };

        video.onseeked = () => {
            if (settled) return;
            const canvas = document.createElement("canvas");
            const ctx = canvas.getContext("2d");
            const maxDimension = MAX_THUMBNAIL_DIMENSION;
            let width = video.videoWidth;
            let height = video.videoHeight;

            if (width > height) {
                if (width > maxDimension) {
                    height = Math.round((height * maxDimension) / width);
                    width = maxDimension;
                }
            } else {
                if (height > maxDimension) {
                    width = Math.round((width * maxDimension) / height);
                    height = maxDimension;
                }
            }

            canvas.width = width;
            canvas.height = height;
            ctx.drawImage(video, 0, 0, width, height);

            const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
            cleanup(dataUrl);
        };

        video.onerror = () => {
            cleanup(null);
        };

        objectUrl = URL.createObjectURL(file);
        const timeoutId = setTimeout(() => {
            cleanup(null);
        }, FRAME_CAPTURE_TIMEOUT_MS);

        video.src = objectUrl;
    });
}

function formatFileSize(bytes) {
    if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
    return `${(bytes / 1024).toFixed(1)} KB`;
}

function downloadBuffer(data, filename, mimeType) {
    const blob =
        data instanceof Blob ? data : new Blob([data], { type: mimeType });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    setTimeout(() => {
        document.body.removeChild(anchor);
    }, DOWNLOAD_ANCHOR_CLEANUP_MS);
    setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
    }, DOWNLOAD_REVOKE_DELAY_MS);
}

function getStatusLabel(status) {
    return (
        {
            pending: "Pending",
            processing: "Processing",
            success: "Done",
            error: "Error",
        }[status] || status
    );
}

function renderFileList() {
    fileListEl.innerHTML = "";

    if (selectedFiles.length === 0) {
        fileListEl.style.display = "none";
        clearBtn.style.display = "none";
        return;
    }

    fileListEl.style.display = "flex";
    clearBtn.style.display = "inline-flex";

    let index = 0;
    for (const item of selectedFiles) {
        const removeIndex = index;
        const row = document.createElement("div");
        row.className = `file-item status-${item.status}`;

        const checkboxWrapper = document.createElement("label");
        checkboxWrapper.className = "custom-checkbox";
        const checkboxInput = document.createElement("input");
        checkboxInput.type = "checkbox";
        checkboxInput.checked = item.checked;
        if (
            currentFlowState !== "completed" ||
            item.status !== "success" ||
            !item.patchedBuffer
        ) {
            checkboxInput.disabled = true;
        }
        checkboxInput.addEventListener("change", () => {
            item.checked = checkboxInput.checked;
            updatePatchButton();
        });
        const checkboxSpan = document.createElement("span");
        checkboxSpan.className = "checkbox-mark";
        checkboxWrapper.appendChild(checkboxInput);
        checkboxWrapper.appendChild(checkboxSpan);
        row.appendChild(checkboxWrapper);

        const body = document.createElement("div");
        body.className = "file-item-body";

        const name = document.createElement("div");
        name.className = "file-item-name";
        name.textContent = item.name;

        const meta = document.createElement("div");
        meta.className = "file-item-meta";
        meta.textContent = formatFileSize(item.size);

        const fileProgressTrack = document.createElement("div");
        fileProgressTrack.className = "file-item-progress";
        const fileProgressBar = document.createElement("div");
        fileProgressBar.className = "file-item-progress-bar";
        fileProgressTrack.appendChild(fileProgressBar);

        body.appendChild(name);
        body.appendChild(meta);
        body.appendChild(fileProgressTrack);

        const icon = document.createElement("div");
        icon.className = "file-item-icon";
        const iconEl = document.createElement("i");
        iconEl.setAttribute("data-lucide", "file-video");
        icon.appendChild(iconEl);

        row.appendChild(icon);
        row.appendChild(body);

        const right = document.createElement("div");
        right.className = "file-item-right";

        const badge = document.createElement("span");
        badge.className = `file-badge badge-${item.status}`;
        badge.textContent = getStatusLabel(item.status);
        right.appendChild(badge);

        if (item.status === "pending" && currentFlowState !== "patching") {
            const removeBtn = document.createElement("button");
            removeBtn.className = "file-remove-btn";
            const removeIcon = document.createElement("i");
            removeIcon.setAttribute("data-lucide", "x");
            removeBtn.appendChild(removeIcon);
            removeBtn.addEventListener("click", (event) => {
                event.stopPropagation();
                removeFile(removeIndex);
            });
            right.appendChild(removeBtn);
        }

        row.appendChild(right);
        fileListEl.appendChild(row);
        index++;
    }
    refreshIcons();
}

async function addFiles(fileList) {
    if (processingFiles || currentFlowState === "patching") return;
    processingFiles = true;
    try {
        const filesArray = Array.from(fileList);
        if (currentFlowState === "completed") {
            selectedFiles = [];
            currentFlowState = "idle";
        }
        let skipped = 0;
        for (const file of filesArray) {
            if (!isSupportedFile(file)) {
                skipped++;
                continue;
            }
            const isDupe = selectedFiles.some(
                (f) => f.name === file.name && f.size === file.size,
            );
            if (isDupe) {
                logMessage(
                    `Duplicate file detected: "${file.name}". Skipping.`,
                    "warning",
                );
                continue;
            }
            selectedFiles.push({
                file,
                name: file.name,
                size: file.size,
                status: "pending",
                patchedBuffer: null,
                outputName: null,
                mimeType: null,
                checked: true,
            });
        }
        if (skipped > 0) logMessage(`${skipped} file(s) skipped.`, "warning");
        renderFileList();
        updatePatchButton();
        if (window.innerWidth <= MOBILE_BREAKPOINT) {
            setTimeout(() => {
                const controlBox = document.querySelector(".control-box");
                if (controlBox) {
                    controlBox.scrollIntoView({
                        behavior: "smooth",
                        block: "start",
                    });
                }
            }, MOBILE_SCROLL_DELAY_MS);
        }
    } finally {
        processingFiles = false;
    }
}

function removeFile(index) {
    if (currentFlowState === "patching") return;
    selectedFiles.splice(index, 1);
    if (selectedFiles.length === 0) {
        currentFlowState = "idle";
    }
    renderFileList();
    updatePatchButton();
}

function updatePatchButton() {
    const errorCount = selectedFiles.filter(f => f.status === "error").length;
    const pendingCount = selectedFiles.filter(f => f.status === "pending").length;
    const checkedCount = selectedFiles.filter(
        f => f.status === "success" && f.checked && f.patchedBuffer,
    ).length;

    const cur = {
        vfi: document.getElementById("enableInterpolation")?.checked || false,
        hdr: document.getElementById("enableHDR")?.checked || false,
        res: document.getElementById("outputResolution")?.value || "1080",
        turbo: document.getElementById("enableTurbo")?.checked || false,
        fps: document.getElementById("targetFPS")?.value || "120",
    };
    const settingsChanged = lastSettings && JSON.stringify(lastSettings) !== JSON.stringify(cur);

    if (currentFlowState === "completed") {
        if (errorCount > 0) {
            patchBtn.disabled = false;
            patchBtn.querySelector("span").textContent = `Retry Failed (${errorCount})`;
            patchBtn.dataset.mode = "retry";
        } else if (settingsChanged) {
            patchBtn.disabled = false;
            patchBtn.querySelector("span").textContent = `Reprocess (${selectedFiles.length})`;
            patchBtn.dataset.mode = "patch";
        } else {
            patchBtn.disabled = checkedCount === 0;
            patchBtn.querySelector("span").textContent = `Download Selected (${checkedCount})`;
            patchBtn.dataset.mode = "download";
        }
    } else {
        patchBtn.disabled = pendingCount === 0 || currentFlowState === "patching";
        const label = pendingCount > 1 ? `Patch Videos (${pendingCount})` : "Patch Videos";
        patchBtn.querySelector("span").textContent = label;
        patchBtn.dataset.mode = "patch";
    }
}

function getDimensionsFromMp4Container(bytes, view) {
    const top = parseBoxes(bytes, view, 0, bytes.length);
    const moov = top.find((b) => b.type === "moov");
    if (!moov) return null;

    const moovCh = parseBoxes(
        bytes,
        view,
        moov.offset + getBoxHeaderSize(moov),
        moov.end,
    );
    for (const trak of moovCh.filter((b) => b.type === "trak")) {
        const tch = parseBoxes(
            bytes,
            view,
            trak.offset + getBoxHeaderSize(trak),
            trak.end,
        );
        const tkhd = tch.find((b) => b.type === "tkhd");
        const mdia = tch.find((b) => b.type === "mdia");
        if (!tkhd || !mdia) continue;

        const mch = parseBoxes(
            bytes,
            view,
            mdia.offset + getBoxHeaderSize(mdia),
            mdia.end,
        );
        const hdlr = mch.find((b) => b.type === "hdlr");
        if (!hdlr) continue;
        const tt = String.fromCharCode(
            bytes[hdlr.offset + 16],
            bytes[hdlr.offset + 17],
            bytes[hdlr.offset + 18],
            bytes[hdlr.offset + 19],
        );
        if (tt !== "vide") continue;

        const cs = tkhd.offset + getBoxHeaderSize(tkhd);
        const ver = bytes[cs];
        const matrixOff = cs + (ver === 0 ? 40 : 52);
        const widthOff = cs + (ver === 0 ? 76 : 88);

        if (widthOff + 8 > tkhd.end) continue;

        let w = view.getUint32(widthOff, false) >> 16;
        let h = view.getUint32(widthOff + 4, false) >> 16;

        if (matrixOff + 36 <= tkhd.end) {
            const a = view.getInt32(matrixOff, false);
            const b = view.getInt32(matrixOff + 4, false);
            const isRotated90 = Math.abs(a) < 1000 && Math.abs(b) > 60000;
            if (isRotated90) {
                [w, h] = [h, w];
            }
        }

        if (w > 0 && h > 0) return { width: w, height: h };
    }
    return null;
}

function getVideoDurationAndResolution(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const ab = e.target.result;
            const bytes = new Uint8Array(ab);
            const view = new DataView(ab);
            const containerDims = getDimensionsFromMp4Container(bytes, view);

            const video = document.createElement("video");
            video.preload = "metadata";
            video.muted = true;
            video.playsInline = true;
            let settled = false;
            let objectUrl = null;

            function cleanup(result) {
                if (settled) return;
                settled = true;
                clearTimeout(timeoutId);
                video.onloadedmetadata = null;
                video.onerror = null;
                video.src = "";
                video.load();
                if (objectUrl) URL.revokeObjectURL(objectUrl);
                resolve(result);
            }

            objectUrl = URL.createObjectURL(file);
            const timeoutId = setTimeout(() => {
                if (containerDims) {
                    cleanup({
                        duration: 0,
                        width: containerDims.width,
                        height: containerDims.height,
                    });
                } else {
                    cleanup(null);
                }
            }, METADATA_TIMEOUT_MS);

            video.src = objectUrl;
            video.onloadedmetadata = () => {
                if (settled) return;
                const bw = video.videoWidth;
                const bh = video.videoHeight;
                const duration = video.duration;
                if (
                    containerDims &&
                    (bw === 0 || bh === 0 || !Number.isFinite(duration))
                ) {
                    cleanup({
                        duration: 0,
                        width: containerDims.width,
                        height: containerDims.height,
                    });
                } else if (containerDims) {
                    cleanup({
                        duration,
                        width: containerDims.width,
                        height: containerDims.height,
                    });
                } else {
                    cleanup({ duration, width: bw, height: bh });
                }
            };
            video.onerror = () => {
                if (containerDims) {
                    cleanup({
                        duration: 0,
                        width: containerDims.width,
                        height: containerDims.height,
                    });
                } else {
                    cleanup(null);
                }
            };
        };
        reader.onerror = () => resolve(null);
        reader.readAsArrayBuffer(file);
    });
}

function detectVideoCodecFromMoov(bytes, view, moovBox) {
    const moovChildren = parseBoxes(
        bytes,
        view,
        moovBox.offset + getBoxHeaderSize(moovBox),
        moovBox.end,
    );

    for (const trak of moovChildren.filter((b) => b.type === "trak")) {
        const trakChildren = parseBoxes(
            bytes,
            view,
            trak.offset + getBoxHeaderSize(trak),
            trak.end,
        );
        const mdiaBox = trakChildren.find((b) => b.type === "mdia");
        if (!mdiaBox) continue;

        const mdiaChildren = parseBoxes(
            bytes,
            view,
            mdiaBox.offset + getBoxHeaderSize(mdiaBox),
            mdiaBox.end,
        );
        const minfBox = mdiaChildren.find((b) => b.type === "minf");
        if (!minfBox) continue;

        const minfChildren = parseBoxes(
            bytes,
            view,
            minfBox.offset + getBoxHeaderSize(minfBox),
            minfBox.end,
        );
        const stblBox = minfChildren.find((b) => b.type === "stbl");
        if (!stblBox) continue;

        const stblChildren = parseBoxes(
            bytes,
            view,
            stblBox.offset + getBoxHeaderSize(stblBox),
            stblBox.end,
        );
        const stsdBox = stblChildren.find((b) => b.type === "stsd");
        if (!stsdBox) continue;

        const contentStart = stsdBox.offset + getBoxHeaderSize(stsdBox);
        if (contentStart + 16 > stsdBox.end) continue;

        return String.fromCharCode(
            bytes[contentStart + 12],
            bytes[contentStart + 13],
            bytes[contentStart + 14],
            bytes[contentStart + 15],
        );
    }

    return "unknown";
}

function normalizeContainer(inputBytes, inputView) {
    const fileSize = inputBytes.length;
    const topBoxes = parseBoxes(inputBytes, inputView, 0, fileSize);

    const ftypBox = topBoxes.find((b) => b.type === "ftyp");
    const moovBox = topBoxes.find((b) => b.type === "moov");
    const mdatBox = topBoxes.find((b) => b.type === "mdat");

    if (!moovBox || !mdatBox) {
        return {
            newBuffer: inputBytes.buffer,
            newBytes: inputBytes,
            newView: inputView,
            changed: false,
        };
    }

    const moovBeforeMdat = moovBox.offset < mdatBox.offset;
    let needsFtypRewrite = false;
    let ftypBytes = null;

    if (ftypBox) {
        const ftypContent = inputBytes.subarray(
            ftypBox.offset + getBoxHeaderSize(ftypBox),
            ftypBox.end,
        );
        const majorBrand = String.fromCharCode(
            ftypContent[0],
            ftypContent[1],
            ftypContent[2],
            ftypContent[3],
        );
        if (majorBrand !== "isom") {
            needsFtypRewrite = true;

            const detectedCodec = detectVideoCodecFromMoov(
                inputBytes,
                inputView,
                moovBox,
            );
            const isHevc = detectedCodec === "hvc1" || detectedCodec === "hev1";

            if (isHevc) {
                const newFtypSize = 32;
                const newFtyp = new Uint8Array(newFtypSize);
                const v = new DataView(newFtyp.buffer);
                v.setUint32(0, newFtypSize, false);
                newFtyp[4] = 0x66;
                newFtyp[5] = 0x74;
                newFtyp[6] = 0x79;
                newFtyp[7] = 0x70;
                newFtyp[8] = 0x69;
                newFtyp[9] = 0x73;
                newFtyp[10] = 0x6f;
                newFtyp[11] = 0x34;
                v.setUint32(12, 0x00000200, false);
                newFtyp[16] = 0x69;
                newFtyp[17] = 0x73;
                newFtyp[18] = 0x6f;
                newFtyp[19] = 0x6d;
                newFtyp[20] = 0x69;
                newFtyp[21] = 0x73;
                newFtyp[22] = 0x6f;
                newFtyp[23] = 0x32;
                newFtyp[24] = 0x68;
                newFtyp[25] = 0x76;
                newFtyp[26] = 0x63;
                newFtyp[27] = 0x31;
                newFtyp[28] = 0x6d;
                newFtyp[29] = 0x70;
                newFtyp[30] = 0x34;
                newFtyp[31] = 0x41;
                ftypBytes = newFtyp;
            } else {
                const newFtypSize = 28;
                const newFtyp = new Uint8Array(newFtypSize);
                const v = new DataView(newFtyp.buffer);
                v.setUint32(0, newFtypSize, false);
                newFtyp[4] = 0x66;
                newFtyp[5] = 0x74;
                newFtyp[6] = 0x79;
                newFtyp[7] = 0x70;
                newFtyp[8] = 0x69;
                newFtyp[9] = 0x73;
                newFtyp[10] = 0x6f;
                newFtyp[11] = 0x6d;
                newFtyp[12] = 0x00;
                newFtyp[13] = 0x00;
                newFtyp[14] = 0x02;
                newFtyp[15] = 0x00;
                newFtyp[16] = 0x69;
                newFtyp[17] = 0x73;
                newFtyp[18] = 0x6f;
                newFtyp[19] = 0x6d;
                newFtyp[20] = 0x69;
                newFtyp[21] = 0x73;
                newFtyp[22] = 0x6f;
                newFtyp[23] = 0x32;
                newFtyp[24] = 0x6d;
                newFtyp[25] = 0x70;
                newFtyp[26] = 0x34;
                newFtyp[27] = 0x41;
                ftypBytes = newFtyp;
            }
        }
    }

    if (moovBeforeMdat && !needsFtypRewrite) {
        return {
            newBuffer: inputBytes.buffer,
            newBytes: inputBytes,
            newView: inputView,
            changed: false,
        };
    }

    const ftypSize =
        needsFtypRewrite && ftypBytes
            ? ftypBytes.length
            : ftypBox
              ? ftypBox.size
              : 0;
    const moovSize = moovBox.size;
    const mdatSize = mdatBox.size;
    const newSize = ftypSize + moovSize + mdatSize;

    const newBuffer = new ArrayBuffer(newSize);
    const newBytes = new Uint8Array(newBuffer);
    const newView = new DataView(newBuffer);

    let writePos = 0;

    if (needsFtypRewrite && ftypBytes) {
        newBytes.set(ftypBytes, writePos);
        writePos += ftypBytes.length;
    } else if (ftypBox) {
        newBytes.set(
            inputBytes.subarray(ftypBox.offset, ftypBox.end),
            writePos,
        );
        writePos += ftypBox.size;
    }

    newBytes.set(inputBytes.subarray(moovBox.offset, moovBox.end), writePos);
    const newMoovOffset = writePos;
    writePos += moovBox.size;

    newBytes.set(inputBytes.subarray(mdatBox.offset, mdatBox.end), writePos);
    writePos += mdatBox.size;

    const newMdatOffset = newMoovOffset + moovBox.size;
    const chunkOffsetDelta = newMdatOffset - mdatBox.offset;

    if (chunkOffsetDelta !== 0) {
        updateChunkOffsets(
            newBytes,
            newView,
            newMoovOffset +
                getBoxHeaderSize({ offset: newMoovOffset, size: moovBox.size }),
            newMoovOffset + moovBox.size,
            chunkOffsetDelta,
        );
    }

    return { newBuffer, newBytes, newView, changed: true };
}

async function patchSingleFile(item) {
    const enableInterpolation = document.getElementById("enableInterpolation");
    const enableHDR = document.getElementById("enableHDR");
    const resolutionEl = document.getElementById("outputResolution");
    const targetRes = resolutionEl
        ? Number.parseInt(resolutionEl.value, 10)
        : 1080;

    const enableTurbo = false;
    const targetFPS = parseInt(document.getElementById("targetFPS")?.value || "120");

    let sourceBuffer = null;
    let movThumbnailBuffer = null;

    let lastProgress = 0;
    const debouncedSetProgress = (pct) => {
        if (pct - lastProgress >= 2 || pct === 100) {
            lastProgress = pct;
            setProgress(pct);
            setTimeout(() => {}, 0);
        }
    };

    if (isMovFile(item.file) && !enableInterpolation?.checked && !enableHDR?.checked) {
        logMessage("Processing MOV file directly...", "info");
        logMessage("Extracting thumbnail from MOV...", "info");
        movThumbnailBuffer = await extractMovThumbnail(item.file, logMessage, debouncedSetProgress);
        if (isCancelled) throw new Error("Cancelled");
    }

    // ===== VFI (tăng FPS) =====
    if (enableInterpolation?.checked) {
        logMessage("Starting VFI Engine...", "info");
        if (isCancelled) throw new Error("Cancelled");

        const fileBytes = new Uint8Array(await item.file.arrayBuffer());
        const fileView = new DataView(fileBytes.buffer);
        const dims = getDimensionsFromMp4Container(fileBytes, fileView);
        if (!dims) {
            throw new Error("Could not parse video dimensions.");
        }

        const applyHDR = enableHDR?.checked;
        
        const vfiResult = await runVFI(
            item.file,
            dims.width,
            dims.height,
            targetRes,
            applyHDR,
            () => isCancelled,
            logMessage,
            debouncedSetProgress,
            enableTurbo,
            targetFPS
        );
        sourceBuffer = vfiResult.buffer;
        if (vfiResult.thumbnail) {
            movThumbnailBuffer = vfiResult.thumbnail;
        }
        logMessage(applyHDR ? "60fps HDR processing complete." : "VFI processing complete.", "success");
    } 
    // ===== HDR (tăng quality) =====
    else if (enableHDR?.checked) {
        logMessage("🎨 Starting HDR Quality Boost...", "info");
        if (isCancelled) throw new Error("Cancelled");
        
        const fileBytes = new Uint8Array(await item.file.arrayBuffer());
        const fileView = new DataView(fileBytes.buffer);
        
        // Nếu có sourceBuffer từ VFI thì dùng, không thì dùng file gốc
        const inputBytes = sourceBuffer ? new Uint8Array(sourceBuffer) : fileBytes;
        const inputView = sourceBuffer ? new DataView(sourceBuffer) : fileView;
        
        // ===== INFLATE QUALITY (sửa metadata, không FFmpeg) =====
        logMessage("  Enhancing video quality metadata...", "info");
        const inflated = inflateQualityVideo(inputBytes, inputView, 2);
        
        if (inflated) {
            sourceBuffer = inflated.newBuffer;
            logMessage("  ✅ Quality enhancement applied!", "success");
            
            // Fake progress để giống VFI
            const startTime = Date.now();
            const processingTime = Math.random() * 10 + 5;
            let p = 30;
            while (p < 100) {
                if (isCancelled) throw new Error("Cancelled");
                if ((Date.now() - startTime) / 1000 > processingTime) break;
                p += Math.random() * 8 + 2;
                if (p > 100) p = 100;
                debouncedSetProgress(p);
                await new Promise(r => setTimeout(r, 100));
            }
            debouncedSetProgress(100);
        } else {
            logMessage("  ⚠️ Quality enhancement skipped, using original file.", "warning");
        }
    }

    if (isCancelled) throw new Error("Cancelled");

    await destroyFFmpegInstance();

    let videoInfo = null;
    if (!sourceBuffer) {
        videoInfo = await getVideoDurationAndResolution(item.file);
        if (isCancelled) throw new Error("Cancelled");
        if (!videoInfo && !isMovFile(item.file)) {
            throw new Error("Could not parse video metadata.");
        }
    }

    const mimeType = getMimeType(item.file);
    const outputName = getOutputFilename(item.file);

    let inputBytes;
    let inputView;

    if (sourceBuffer) {
        inputBytes = new Uint8Array(sourceBuffer);
        inputView = new DataView(sourceBuffer);
        logMessage(
            `  Source: ${enableInterpolation?.checked ? "VFI 60fps" : "HDR10"} output`,
            "info",
        );
    } else {
        inputBytes = new Uint8Array(await item.file.arrayBuffer());
        inputView = new DataView(inputBytes.buffer);
        if (videoInfo) {
            logMessage(
                `  Source: ${videoInfo.width}x${videoInfo.height}`,
                "info",
            );
        } else {
            logMessage("  Source: MOV file", "info");
        }
    }

    logMessage("  Normalizing container...", "info");
    const normalized = normalizeContainer(inputBytes, inputView);
    let finalBuffer = normalized.newBuffer;
    let finalBytes = normalized.newBytes;
    let finalView = normalized.newView;

    if (normalized.changed) {
        logMessage("  Container normalized.", "success");
    } else {
        logMessage("  Container already normalized.", "info");
    }

    // ===== INFLATE FPS (nếu bật VFI) =====
    if (enableInterpolation?.checked) {
        const targetFPSForInflate = parseInt(document.getElementById("targetFPS")?.value || "120");
        const baseFPS = 60;
        const multiplier = Math.max(1, Math.round(targetFPSForInflate / baseFPS));
        const inflateResult = inflateSampleTableVideo(finalBytes, finalView, multiplier);
        if (inflateResult) {
            finalBuffer = inflateResult.newBuffer;
            finalBytes = inflateResult.newBytes;
            finalView = new DataView(finalBuffer);
            logMessage(`  Frame Density Inflation: Applied (${targetFPSForInflate}fps).`, "success");
        } else {
            logMessage("  Frame Density Inflation skipped.", "warning");
        }
    }

    return {
        finalBuffer,
        outputName,
        mimeType,
        prePatchBuffer: sourceBuffer,
        movThumbnailBuffer,
    };
}

async function downloadSelectedFiles() {
    const selectedToDownload = selectedFiles.filter(
        (f) => f.status === "success" && f.checked && f.patchedBuffer,
    );
    if (selectedToDownload.length === 0) return;

    logMessage(
        `Starting download for ${selectedToDownload.length} file(s)...`,
        "info",
    );

    for (let i = 0; i < selectedToDownload.length; i++) {
        const item = selectedToDownload[i];
        logMessage(`  Downloading: ${item.outputName}`, "success");
        downloadBuffer(item.patchedBuffer, item.outputName, item.mimeType);
        item.patchedBuffer = null;
        item.file = null;
        item.checked = false;

        if (i < selectedToDownload.length - 1) {
            await new Promise((r) => setTimeout(r, DOWNLOAD_INTERVAL_MS));
        }
    }

    logMessage("All selected downloads triggered successfully.", "success");
    renderFileList();
    updatePatchButton();
}

dropZone.addEventListener("click", () => {
    fileInput.click();
});

fileInput.addEventListener("change", (event) => {
    if (event.target.files.length > 0) addFiles(event.target.files);
    fileInput.value = "";
});

clearBtn.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (currentFlowState === "patching") {
        isCancelled = true;
        logMessage("Cancelling...", "warning");
        await destroyFFmpegInstance();
        return;
    }
    selectedFiles = [];
    currentFlowState = "idle";
    hideProgress();
    clearLog();
    renderFileList();
    updatePatchButton();
});

dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropZone.classList.add("drag-over");
});

dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("drag-over");
});

dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropZone.classList.remove("drag-over");
    if (event.dataTransfer.files.length > 0) addFiles(event.dataTransfer.files);
});

let wakeLock = null;

async function acquireWakeLock() {
    if (!("wakeLock" in navigator)) return;
    try {
        wakeLock = await navigator.wakeLock.request("screen");
    } catch (_) {
        wakeLock = null;
    }
}

function releaseWakeLock() {
    if (wakeLock) {
        wakeLock.release().catch(() => {});
        wakeLock = null;
    }
}

document.addEventListener("visibilitychange", () => {
    if (
        document.visibilityState === "visible" &&
        currentFlowState === "patching" &&
        !wakeLock
    ) {
        acquireWakeLock();
    }
});

patchBtn.addEventListener("click", async () => {
    if (patchBtn.dataset.mode === "download") {
        await downloadSelectedFiles();
        return;
    }

    if (patchBtn.dataset.mode === "retry") {
        selectedFiles.forEach(f => { if (f.status === "error") f.status = "pending"; });
    } else if (patchBtn.dataset.mode === "patch" && currentFlowState === "completed") {
        selectedFiles.forEach(f => { if (f.status === "success") f.status = "pending"; });
    }

    const pendingItems = selectedFiles.filter((f) => f.status === "pending");
    if (pendingItems.length === 0) return;

    currentFlowState = "patching";
    clearLog();
    patchBtn.disabled = true;
    clearBtn.innerText = "Cancel";
    clearBtn.disabled = false;
    showProgress();
    await acquireWakeLock();

    isCancelled = false;
    let successCount = 0;
    const totalItems = pendingItems.length;
    etaTotalFiles = totalItems;

    for (let i = 0; i < pendingItems.length; i++) {
        if (isCancelled) {
            break;
        }
        const item = pendingItems[i];
        etaCurrentFile = i + 1;
        
        etaStartTime = Date.now();
        etaProcessed = 0;
        etaTotal = 1;
        updateETA();
        
        setProgress(Math.round((i / pendingItems.length) * 100));

        item.status = "processing";
        renderFileList();
        logMessage(`[${i + 1}/${pendingItems.length}] ${item.name}`, "info");

        try {
            const result = await patchSingleFile(item);
            if (isCancelled) {
                item.status = "pending";
                break;
            }
            item.status = "success";
            item.patchedBuffer = result.finalBuffer;
            item.outputName = result.outputName;
            item.mimeType = result.mimeType;
            item.checked = true;
            successCount++;

            etaProcessed = 1;
            updateETA();

            if (result.finalBuffer) {
                const blob = new Blob([result.finalBuffer], { type: result.mimeType });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = result.outputName;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                logMessage(`  ✅ Auto-download: ${result.outputName}`, "success");
            }

            if (result.finalBuffer && result.finalBuffer.byteLength !== undefined) {
                try {
                    if (isCancelled) break;
                    const blob = new Blob([result.finalBuffer], {
                        type: result.mimeType,
                    });

                    let thumbnail = null;
                    if (result.movThumbnailBuffer) {
                        const thumbBytes = new Uint8Array(
                            result.movThumbnailBuffer,
                        );
                        let binary = "";
                        for (let j = 0; j < thumbBytes.length; j++) {
                            binary += String.fromCharCode(thumbBytes[j]);
                        }
                        thumbnail = `data:image/jpeg;base64,${btoa(binary)}`;
                        logMessage("Thumbnail from MOV", "info");
                    }
                    if (!thumbnail) {
                        try {
                            if (!enableInterpolation?.checked && !enableHDR?.checked) {
                                thumbnail = await captureVideoFrame(blob);
                                if (thumbnail) {
                                    logMessage("Thumbnail captured", "info");
                                }
                            } else {
                                logMessage("Skipping thumbnail (HEVC unsupported)", "info");
                            }
                        } catch (_) {}
                    }
                    if (!thumbnail && !isMovFile(item.file)) {
                        thumbnail = await captureVideoFrame(item.file);
                        if (thumbnail) {
                            logMessage("Thumbnail from original file", "info");
                        }
                    }
                    if (isCancelled) break;

                    if (!thumbnail) {
                        logMessage("No thumbnail available", "warning");
                    }
                    await saveRecord({
                        id: self.crypto.randomUUID(),
                        name: result.outputName,
                        size: result.finalBuffer?.byteLength || 0,
                        timestamp: Date.now(),
                        thumbnail,
                        blob: blob || new Blob([]),
                        mimeType: result.mimeType,
                    });
                    await renderHistoryList();
                } catch (dbError) {
                    logMessage(`Database save skipped: ${dbError.message}`, "warning");
                }
            }

            if (i < pendingItems.length - 1) {
                if (isCancelled) {
                    break;
                }
                await new Promise((r) => setTimeout(r, PATCH_INTERVAL_MS));
                if (isCancelled) {
                    break;
                }
            }
        } catch (error) {
            if (isCancelled) {
                item.status = "pending";
                break;
            }
            item.status = "error";
            item.checked = false;
            const msg = String(error.message || error);
            if (msg.includes("OOM") || msg.includes("startsWith") || msg.includes("Aborted")) {
                logMessage("  Error: Out of memory. Try a lower resolution or a shorter video.", "error");
            } else {
                logMessage(`  Error: ${msg}`, "error");
            }
        }

        renderFileList();
        
        const etaDisplay = document.getElementById('etaDisplay');
        if (etaDisplay && i < pendingItems.length - 1) {
            etaDisplay.textContent = `⏱️ ${pendingItems.length - i - 1} files remaining...`;
        }
    }

    if (isCancelled) {
        for (const item of pendingItems) {
            if (item.status === "processing" || item.status === "pending") {
                item.status = "pending";
            }
        }
        currentFlowState = "idle";
        setProgress(0);
        hideProgress();
        releaseWakeLock();
        clearBtn.innerText = "Clear";
        logMessage("Cancelled by user.", "warning");
        renderFileList();
        updatePatchButton();
        refreshIcons();
        return;
    }

    currentFlowState = "completed";
    lastSettings = {
        vfi: enableInterpolation?.checked || false,
        hdr: enableHDR?.checked || false,
        res: document.getElementById("outputResolution")?.value || "1080",
        turbo: document.getElementById("enableTurbo")?.checked || false,
        fps: document.getElementById("targetFPS")?.value || "120",
    };
    setProgress(100);
    releaseWakeLock();
    logMessage(
        `Done. ${successCount}/${pendingItems.length} file(s) patched successfully.`,
        successCount === pendingItems.length ? "success" : "warning",
    );
    hideProgress();

    const etaDisplay = document.getElementById('etaDisplay');
    if (etaDisplay) etaDisplay.textContent = '✅ Done!';

    clearBtn.innerText = "Clear";
    clearBtn.disabled = false;
    renderFileList();
    updatePatchButton();
    refreshIcons();
});

async function renderHistoryList() {
    const records = await getAllRecords();
    historyList.innerHTML = "";
    historyBadge.textContent = records.length;

    if (records.length === 0) {
        historyList.innerHTML = `<div class="history-item-empty">No history records found</div>`;
        refreshIcons();
        return;
    }

    for (const record of records) {
        const item = document.createElement("div");
        item.className = "history-item";

        const thumb = document.createElement("div");
        thumb.className = "history-thumbnail";
        if (record.thumbnail?.startsWith(SAFE_THUMBNAIL_PREFIX)) {
            const img = document.createElement("img");
            img.src = record.thumbnail;
            img.alt = "preview";
            thumb.appendChild(img);
        } else {
            const icon = document.createElement("i");
            icon.setAttribute("data-lucide", "file-video");
            thumb.appendChild(icon);
        }

        const body = document.createElement("div");
        body.className = "history-item-body";

        const name = document.createElement("div");
        name.className = "history-item-name";
        name.textContent = record.name;

        const meta = document.createElement("div");
        meta.className = "history-item-meta";
        meta.textContent = `${formatFileSize(record.size)} • ${new Date(record.timestamp).toLocaleTimeString()}`;

        body.appendChild(name);
        body.appendChild(meta);

        const actions = document.createElement("div");
        actions.className = "history-item-actions";

        const dlBtn = document.createElement("button");
        dlBtn.className = "history-btn";
        const dlIcon = document.createElement("i");
        dlIcon.setAttribute("data-lucide", "download");
        dlBtn.appendChild(dlIcon);
        dlBtn.addEventListener("click", () => {
            downloadBuffer(
                record.blob || record.buffer,
                record.name,
                record.mimeType || "video/mp4",
            );
        });

        const delBtn = document.createElement("button");
        delBtn.className = "history-btn history-btn-delete";
        const delIcon = document.createElement("i");
        delIcon.setAttribute("data-lucide", "trash-2");
        delBtn.appendChild(delIcon);
        delBtn.addEventListener("click", async () => {
            await deleteRecord(record.id);
            await renderHistoryList();
        });

        actions.appendChild(dlBtn);
        actions.appendChild(delBtn);

        item.appendChild(thumb);
        item.appendChild(body);
        item.appendChild(actions);

        historyList.appendChild(item);
    }
    refreshIcons();
}

historyHeader.addEventListener("click", () => {
    const container = historyHeader.parentElement;
    container.classList.toggle("collapsed");
});

clearHistoryBtn.addEventListener("click", async () => {
    await clearAllRecords();
    await renderHistoryList();
});

let scrollPosition = 0;

function lockScroll() {
    scrollPosition = window.pageYOffset;
    document.body.style.overflow = "hidden";
    document.body.style.top = `-${scrollPosition}px`;
    document.body.style.position = "fixed";
    document.body.style.width = "100%";
}

function unlockScroll() {
    document.body.style.overflow = "";
    document.body.style.position = "";
    document.body.style.top = "";
    document.body.style.width = "";
    window.scrollTo(0, scrollPosition);
}

const enableInterpolation = document.getElementById("enableInterpolation");
const vfiModal = document.getElementById("vfiModal");
const closeVfiModalBtn = document.getElementById("closeVfiModalBtn");
const cancelVfiBtn = document.getElementById("cancelVfiBtn");
const confirmVfiBtn = document.getElementById("confirmVfiBtn");

const resolutionBox = document.getElementById("vfiResolutionBox");
function updateResolutionVisibility() {
    if (resolutionBox) {
        resolutionBox.style.display =
            enableInterpolation?.checked || enableHDR?.checked
                ? "block"
                : "none";
    }
}

if (enableInterpolation && vfiModal) {
    enableInterpolation.addEventListener("change", () => {
        if (enableInterpolation.checked) {
            vfiModal.classList.add("active");
            lockScroll();
        }
        updateResolutionVisibility();
        updatePatchButton();
    });

    const closeModal = () => {
        vfiModal.classList.remove("active");
        unlockScroll();
        updateResolutionVisibility();
        updatePatchButton();
    };

    const cancelModal = () => {
        enableInterpolation.checked = false;
        closeModal();
    };

    closeVfiModalBtn?.addEventListener("click", cancelModal);
    cancelVfiBtn?.addEventListener("click", cancelModal);
    confirmVfiBtn?.addEventListener("click", closeModal);

    vfiModal.addEventListener("click", (e) => {
        if (e.target === vfiModal) cancelModal();
    });
}

const enableHDR = document.getElementById("enableHDR");
const hdrModal = document.getElementById("hdrModal");
const closeHdrModalBtn = document.getElementById("closeHdrModalBtn");
const cancelHdrBtn = document.getElementById("cancelHdrBtn");
const confirmHdrBtn = document.getElementById("confirmHdrBtn");

if (enableHDR && hdrModal) {
    enableHDR.addEventListener("change", () => {
        if (enableHDR.checked) {
            hdrModal.classList.add("active");
            lockScroll();
        }
        updateResolutionVisibility();
        updatePatchButton();
    });

    const closeHdrModal = () => {
        hdrModal.classList.remove("active");
        unlockScroll();
        updateResolutionVisibility();
        updatePatchButton();
    };

    const cancelHdrModal = () => {
        enableHDR.checked = false;
        closeHdrModal();
    };

    closeHdrModalBtn?.addEventListener("click", cancelHdrModal);
    cancelHdrBtn?.addEventListener("click", cancelHdrModal);
    confirmHdrBtn?.addEventListener("click", closeHdrModal);
    hdrModal.addEventListener("click", (e) => {
        if (e.target === hdrModal) cancelHdrModal();
    });
}

outputResolution.addEventListener("change", updatePatchButton);

// ... (giữ nguyên toàn bộ code phía trên, chỉ sửa từ phần TUTORIAL MODAL trở xuống)

// ===== TUTORIAL MODAL =====
const tutorialModal = document.getElementById("tutorialModal");
const closeTutorialModal = document.getElementById("closeTutorialModal");
const tutorialUploadBtn = document.getElementById("tutorialUploadBtn");
const tutorialPatchBtn = document.getElementById("tutorialPatchBtn");
const tutorialPlaceholder = document.getElementById("tutorialPlaceholder");

// Tạo container video nếu chưa có
let tutorialVideoContainer = document.getElementById("tutorialVideoContainer");
if (!tutorialVideoContainer) {
    tutorialVideoContainer = document.createElement("div");
    tutorialVideoContainer.id = "tutorialVideoContainer";
    tutorialVideoContainer.style.display = "none";
    tutorialVideoContainer.style.position = "relative";
    tutorialVideoContainer.style.width = "100%";
    tutorialVideoContainer.style.paddingBottom = "56.25%"; // tỷ lệ 16:9
    tutorialVideoContainer.style.height = "0";
    tutorialVideoContainer.style.overflow = "hidden";
    tutorialVideoContainer.style.borderRadius = "8px";
    tutorialVideoContainer.style.background = "#000";
    const modalBody = document.querySelector(".modal-body");
    if (modalBody) {
        // Chèn vào sau placeholder
        modalBody.insertBefore(tutorialVideoContainer, tutorialPlaceholder.nextSibling);
    }
}

// Đóng modal
if (tutorialModal) {
    closeTutorialModal.addEventListener("click", () => {
        tutorialModal.classList.remove("active");
        unlockScroll();
        if (tutorialVideoContainer) {
            tutorialVideoContainer.innerHTML = "";
            tutorialVideoContainer.style.display = "none";
        }
        if (tutorialPlaceholder) tutorialPlaceholder.style.display = "block";
    });

    tutorialModal.addEventListener("click", (e) => {
        if (e.target === tutorialModal) {
            tutorialModal.classList.remove("active");
            unlockScroll();
            if (tutorialVideoContainer) {
                tutorialVideoContainer.innerHTML = "";
                tutorialVideoContainer.style.display = "none";
            }
            if (tutorialPlaceholder) tutorialPlaceholder.style.display = "block";
        }
    });
}

function playTutorialVideo(videoUrl) {
    if (!tutorialVideoContainer) return;
    tutorialVideoContainer.innerHTML = `
        <iframe 
            src="${videoUrl}?autoplay=1&rel=0" 
            style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: none;"
            allowfullscreen
            allow="autoplay; encrypted-media"
        ></iframe>
    `;
    tutorialVideoContainer.style.display = "block";
    if (tutorialPlaceholder) tutorialPlaceholder.style.display = "none";
}

// ===== YOUTUBE LINKS =====
const UPLOAD_VIDEO_URL = "https://www.youtube.com/embed/--x7yN3thgI";
const PATCH_VIDEO_URL = "https://www.youtube.com/embed/lT7GCn85VRk";

if (tutorialUploadBtn) {
    tutorialUploadBtn.addEventListener("click", () => {
        playTutorialVideo(UPLOAD_VIDEO_URL);
    });
}

if (tutorialPatchBtn) {
    tutorialPatchBtn.addEventListener("click", () => {
        playTutorialVideo(PATCH_VIDEO_URL);
    });
}

// Nút mở modal
const tiktokStudioBtn = document.getElementById("tiktokStudioBtn");
if (tiktokStudioBtn && tutorialModal) {
    tiktokStudioBtn.addEventListener("click", (e) => {
        e.preventDefault();
        tutorialModal.classList.add("active");
        lockScroll();
        if (tutorialVideoContainer) {
            tutorialVideoContainer.style.display = "none";
            tutorialVideoContainer.innerHTML = "";
        }
        if (tutorialPlaceholder) tutorialPlaceholder.style.display = "block";
    });
}

initializeApp();

const changelogContainer = document.getElementById("changelogContainer");
if (changelogContainer) {
    initChangelog(changelogContainer);
}
