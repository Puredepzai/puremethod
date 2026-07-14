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
import { 
    inflateSampleTableVideo, 
    inflateQualityVideo, 
    processAndCompressVideo,
    compressVideoUnder20MB 
} from "./src/mp4-inflate.mjs";
import {
    runVFI,
    runHDR,
    extractMovThumbnail,
    destroyFFmpegInstance,
    resolveInputExtension,
} from "./src/video-processor.js";

// ============================================================
// HẰNG SỐ CẤU HÌNH
// ============================================================
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
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB
const TARGET_FPS = 600; // 👈 LUÔN LÀ 600 FPS KHI BẬT VFI

// ============================================================
// BIẾN TOÀN CỤC
// ============================================================
let etaStartTime = 0;
let etaProcessed = 0;
let etaTotal = 0;
let etaInterval = null;
let etaCurrentFile = 0;
let etaTotalFiles = 0;

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

// ============================================================
// DOM REFERENCES
// ============================================================
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

// ============================================================
// STATE
// ============================================================
let selectedFiles = [];
let currentFlowState = "idle";
let isCancelled = false;
let processingFiles = false;
let lastSettings = null;
let lastWidth = null;
let wakeLock = null;

// ============================================================
// UI UTILITY FUNCTIONS
// ============================================================
function refreshIcons() {
    createIcons({ icons: ALL_ICONS });
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
    progressBar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
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

function formatFileSize(bytes) {
    if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
    return `${(bytes / 1024).toFixed(1)} KB`;
}

function getStatusLabel(status) {
    return {
        pending: "Pending",
        processing: "Processing",
        success: "Done",
        error: "Error",
    }[status] || status;
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

// ============================================================
// ETA DISPLAY INIT
// ============================================================
function initETADisplay() {
    const etaDisplay = document.createElement('div');
    etaDisplay.id = 'etaDisplay';
    etaDisplay.style.cssText = 'font-family: monospace; font-size: 13px; color: #aaa; text-align: center; margin-top: 4px; min-height: 20px;';
    etaDisplay.textContent = '⏱️ Waiting...';
    const progressTrackEl = document.getElementById('progressTrack');
    if (progressTrackEl) {
        progressTrackEl.parentNode.insertBefore(etaDisplay, progressTrackEl.nextSibling);
    }
}

// ============================================================
// WAKE LOCK
// ============================================================
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

// ============================================================
// CAPTURE VIDEO FRAME
// ============================================================
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

// ============================================================
// FILE LIST RENDER
// ============================================================
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
        row.dataset.index = removeIndex;

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
        fileProgressBar.style.width = `${item.progress || 0}%`;
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

function removeFile(index) {
    if (currentFlowState === "patching") return;
    selectedFiles.splice(index, 1);
    if (selectedFiles.length === 0) {
        currentFlowState = "idle";
    }
    renderFileList();
    updatePatchButton();
}

// ============================================================
// ADD FILES
// ============================================================
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
                progress: 0,
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

// ============================================================
// UPDATE PATCH BUTTON
// ============================================================
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
        // 👇 ĐÃ XÓA fps, LUÔN LÀ 600
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

// ============================================================
// UPDATE ITEM PROGRESS
// ============================================================
function updateItemProgressBar(item, pct) {
    item.progress = Math.min(100, Math.max(0, Math.round(pct)));
    const idx = selectedFiles.indexOf(item);
    if (idx === -1) return;
    const row = fileListEl.querySelector(`.file-item[data-index="${idx}"]`);
    if (!row) return;
    const bar = row.querySelector(".file-item-progress-bar");
    if (bar) bar.style.width = `${item.progress}%`;
}

// ============================================================
// VIDEO METADATA PARSING
// ============================================================
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

// ============================================================
// NORMALIZE CONTAINER
// ============================================================
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

// ============================================================
// PATCH SINGLE FILE (PHẦN QUAN TRỌNG NHẤT)
// ============================================================
async function patchSingleFile(item) {
    const enableInterpolation = document.getElementById("enableInterpolation");
    const enableHDR = document.getElementById("enableHDR");
    const resolutionEl = document.getElementById("outputResolution");
    const targetRes = resolutionEl
        ? Number.parseInt(resolutionEl.value, 10)
        : 1080;

    const enableTurbo = false;
    // 👇 LUÔN LÀ 600 FPS KHI BẬT VFI
    const targetFPS = TARGET_FPS;

    let sourceBuffer = null;
    let movThumbnailBuffer = null;

    let lastProgress = 0;
    const debouncedSetProgress = (pct) => {
        if (pct - lastProgress >= 2 || pct === 100) {
            lastProgress = pct;
            setProgress(pct);
            updateItemProgressBar(item, pct);
            setTimeout(() => {}, 0);
        }
    };

    // ===== XỬ LÝ MOV TRỰC TIẾP =====
    if (isMovFile(item.file) && !enableInterpolation?.checked && !enableHDR?.checked) {
        logMessage("Processing MOV file directly...", "info");
        logMessage("Extracting thumbnail from MOV...", "info");
        movThumbnailBuffer = await extractMovThumbnail(item.file, logMessage, debouncedSetProgress);
        if (isCancelled) throw new Error("Cancelled");
    }

    // ===== VFI (tăng FPS) =====
    if (enableInterpolation?.checked) {
        logMessage(`🎞️ Starting VFI Engine (${targetFPS} FPS)...`, "info");
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
            targetFPS // 👈 Truyền 600 FPS
        );
        sourceBuffer = vfiResult.buffer;
        if (vfiResult.thumbnail) {
            movThumbnailBuffer = vfiResult.thumbnail;
        }
        logMessage(applyHDR ? "60
