import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import {
    ChevronDown,
    Cpu,
    Download,
    FileVideo,
    Info,
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
    getHistoryTotalSize,
    pruneOldRecords,
    saveRecord,
} from "./db.js";
import { initChangelog } from "./src/changelog.mjs";
import {
    getBoxHeaderSize,
    parseBoxes,
    updateBoxSize,
    updateChunkOffsets,
} from "./src/mp4-boxes.mjs";
import { inflateSampleTableVideo } from "./src/mp4-inflate.mjs";
import {
    buildEdtsAtom,
    patchMvhdMatrix,
    rebuildWithElstBypass,
} from "./src/mp4-patches.mjs";
import {
    injectCommentUdta,
    stripTkhdMatrix,
    stripUdtaAtom,
} from "./src/mp4-strip.mjs";

const FRAME_CAPTURE_TIMEOUT_MS = 5000;
const METADATA_TIMEOUT_MS = 10000;
const MAX_STORAGE_BYTES = 209715200;
const HISTORY_EXPIRY_MS = 43200000;
const MAX_THUMBNAIL_DIMENSION = 120;
const MOBILE_BREAKPOINT = 900;
const DOWNLOAD_REVOKE_DELAY_MS = 1000;
const PROGRESS_HIDE_DELAY_MS = 800;
const PROGRESS_FADE_DURATION_MS = 400;
const DOWNLOAD_INTERVAL_MS = 300;
const PATCH_INTERVAL_MS = 600;
const MOBILE_SCROLL_DELAY_MS = 150;
const MAX_VIDEO_DURATION_SECONDS = 30;
const DOWNLOAD_ANCHOR_CLEANUP_MS = 100;
const SAFE_THUMBNAIL_PREFIX = "data:image/jpeg;base64,";

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
};

const outputSuffix = "_enhanced";
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
const historyToggleBtn = document.getElementById("historyToggleBtn");
const historyDrawer = document.getElementById("historyDrawer");
const historyHeader = document.getElementById("historyHeader");
const clearHistoryBtn = document.getElementById("clearHistoryBtn");

let selectedFiles = [];
let currentFlowState = "idle";
let isCancelled = false;
let processingFiles = false;

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
    pruneOldRecords()
        .then(() => renderHistoryList())
        .catch((err) =>
            logMessage(`History pruning failed: ${err.message}`, "warning"),
        );
    adjustMobileLayout();
    window.addEventListener("resize", adjustMobileLayout);
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

function isSupportedFile(file) {
    const lowerName = file.name.toLowerCase();
    return (
        supportedMimeTypes.includes(file.type) ||
        supportedExtensions.some((ext) => lowerName.endsWith(ext))
    );
}

function getMimeType(file) {
    const lowerName = file.name.toLowerCase();
    if (file.type && supportedMimeTypes.includes(file.type)) return file.type;
    if (lowerName.endsWith(".mov")) return "video/quicktime";
    return "video/mp4";
}

function getOutputFilename(file) {
    const lastDotIndex = file.name.lastIndexOf(".");
    if (lastDotIndex <= 0) return file.name + outputSuffix;
    const name = file.name.substring(0, lastDotIndex);
    const ext = file.name.substring(lastDotIndex);
    return name + outputSuffix + ext;
}

export function captureVideoFrame(file) {
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

        objectUrl = URL.createObjectURL(file);
        const timeoutId = setTimeout(() => {
            cleanup(null);
        }, FRAME_CAPTURE_TIMEOUT_MS);

        video.src = objectUrl;

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
        let historySize = 0;
        try {
            historySize = await getHistoryTotalSize();
        } catch (err) {
            logMessage(`History size check failed: ${err.message}`, "warning");
        }
        const totalQueueSize = selectedFiles
            .filter((f) => f.status !== "success")
            .reduce((sum, f) => sum + f.size, 0);
        let runningTotal = historySize + totalQueueSize;
        if (runningTotal >= MAX_STORAGE_BYTES) {
            logMessage(
                "Upload failed: Storage limit reached (200MB). Please delete one or more items from your history persistence storage to upload files again.",
                "error",
            );
            return;
        }
        let skipped = 0;
        let limitReached = false;
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
            if (runningTotal + file.size > MAX_STORAGE_BYTES) {
                limitReached = true;
                break;
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
            runningTotal += file.size;
        }
        if (limitReached) {
            logMessage(
                "Some files skipped: 200MB total storage limit reached. Clear your history persistence storage to upload more files.",
                "error",
            );
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
    if (currentFlowState === "completed") {
        const checkedCount = selectedFiles.filter(
            (f) => f.status === "success" && f.checked && f.patchedBuffer,
        ).length;
        patchBtn.disabled = checkedCount === 0;
        const label = `Download Selected (${checkedCount})`;
        patchBtn.querySelector("span").textContent = label;
    } else {
        const pendingCount = selectedFiles.filter(
            (f) => f.status === "pending",
        ).length;
        patchBtn.disabled =
            pendingCount === 0 || currentFlowState === "patching";
        const label =
            pendingCount > 1
                ? `Patch Videos (${pendingCount})`
                : "Patch Videos";
        patchBtn.querySelector("span").textContent = label;
    }
}

function parseMp4Boxes(bytes, view, start, end) {
    const boxes = [];
    let pos = start;
    while (pos + 8 <= end) {
        let sz = view.getUint32(pos, false);
        let hdr = 8;
        if (sz === 1) {
            if (pos + 16 > end) break;
            const hi = view.getUint32(pos + 8, false);
            const lo = view.getUint32(pos + 12, false);
            sz = hi * 0x100000000 + lo;
            hdr = 16;
        } else if (sz === 0) {
            sz = end - pos;
        }
        if (sz < hdr || pos + sz > end) break;
        const type = String.fromCharCode(
            bytes[pos + 4],
            bytes[pos + 5],
            bytes[pos + 6],
            bytes[pos + 7],
        );
        boxes.push({ offset: pos, size: sz, type, end: pos + sz, hdr });
        pos += sz;
    }
    return boxes;
}

function getDimensionsFromMp4Container(bytes, view) {
    const top = parseMp4Boxes(bytes, view, 0, bytes.length);
    const moov = top.find((b) => b.type === "moov");
    if (!moov) return null;

    const moovCh = parseMp4Boxes(bytes, view, moov.offset + moov.hdr, moov.end);
    for (const trak of moovCh.filter((b) => b.type === "trak")) {
        const tch = parseMp4Boxes(
            bytes,
            view,
            trak.offset + trak.hdr,
            trak.end,
        );
        const tkhd = tch.find((b) => b.type === "tkhd");
        const mdia = tch.find((b) => b.type === "mdia");
        if (!tkhd || !mdia) continue;

        const mch = parseMp4Boxes(
            bytes,
            view,
            mdia.offset + mdia.hdr,
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

        const cs = tkhd.offset + tkhd.hdr;
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

let ffmpegInstance = null;

async function destroyFFmpegInstance() {
    if (!ffmpegInstance) return;
    try {
        await ffmpegInstance.terminate();
    } catch (err) {
        console.error("FFmpeg terminate failed:", err);
    }
    ffmpegInstance = null;
}

async function getFFmpeg() {
    if (ffmpegInstance) return ffmpegInstance;
    ffmpegInstance = new FFmpeg();
    logMessage("Loading high-performance video engine...", "info");
    const isMultiThread =
        typeof window.SharedArrayBuffer !== "undefined" &&
        window.crossOriginIsolated;
    const baseURL = isMultiThread
        ? "https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@0.12.6/dist/esm"
        : "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm";
    ffmpegInstance.on("progress", ({ progress }) => {
        setProgress(Math.round(progress * 100));
    });
    try {
        const loadConfig = {
            coreURL: await toBlobURL(
                `${baseURL}/ffmpeg-core.js`,
                "text/javascript",
            ),
            wasmURL: await toBlobURL(
                `${baseURL}/ffmpeg-core.wasm`,
                "application/wasm",
            ),
            classWorkerURL: await toBlobURL(
                "https://esm.sh/@ffmpeg/ffmpeg@0.12.15/es2022/dist/esm/worker.bundle.mjs",
                "text/javascript",
            ),
        };
        if (isMultiThread) {
            loadConfig.workerURL = await toBlobURL(
                `${baseURL}/ffmpeg-core.worker.js`,
                "text/javascript",
            );
        }
        await ffmpegInstance.load(loadConfig);
        logMessage("Video engine loaded successfully.", "success");
    } catch (err) {
        await destroyFFmpegInstance();
        throw err;
    }
    return ffmpegInstance;
}

const CODEC_ENCODER_MAP = {
    h264: "libx264",
    avc: "libx264",
    hevc: "libx265",
    h265: "libx265",
    vp9: "libvpx-vp9",
    vp8: "libvpx",
    mpeg4: "mpeg4",
    av1: "libaom-av1",
};

function resolveInputExtension(file) {
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".mov")) return ".mov";
    if (lower.endsWith(".webm")) return ".webm";
    return ".mp4";
}

async function probeSourceFps(instance, inputName) {
    const logLines = [];
    const collector = ({ message }) => logLines.push(message);
    instance.on("log", collector);
    try {
        await instance.exec(["-i", inputName]);
    } catch (err) {
        console.error("Failed to probe source FPS:", err);
    }
    instance.off("log", collector);

    for (const line of logLines) {
        const match = line.match(/(\d+(?:\.\d+)?)\s+fps/i);
        if (match) {
            const fps = Number.parseFloat(match[1]);
            if (fps > 0) return fps;
        }
    }
    return null;
}

async function probeInputCodec(instance, inputName) {
    const logLines = [];
    const collector = ({ message }) => logLines.push(message.toLowerCase());
    instance.on("log", collector);
    try {
        await instance.exec(["-i", inputName]);
    } catch (err) {
        console.error("Failed to probe input codec:", err);
    }
    instance.off("log", collector);

    for (const line of logLines) {
        const streamMatch = line.match(/\bvideo:\s*([a-z0-9]+)/);
        if (streamMatch) {
            const codec = streamMatch[1];
            if (CODEC_ENCODER_MAP[codec]) return codec;
        }
    }
    return null;
}

async function execWithEncoder(instance, args, encoder) {
    const logLines = [];
    const collector = ({ message }) => logLines.push(message.toLowerCase());
    instance.on("log", collector);
    try {
        await instance.exec(args);
        instance.off("log", collector);
        return true;
    } catch (err) {
        instance.off("log", collector);
        const failed = logLines.some(
            (l) =>
                l.includes("unknown encoder") ||
                l.includes(`encoder ${encoder} is not available`),
        );
        if (failed) return false;
        throw err;
    }
}

async function runVFI(file, width, height, targetRes = 1080) {
    let instance;
    try {
        if (isCancelled) throw new Error("Cancelled");
        instance = await getFFmpeg();
        if (isCancelled) throw new Error("Cancelled");
        const ext = resolveInputExtension(file);
        const inputName = `input${ext}`;
        const outputName = `output${ext}`;

        logMessage("Preparing video data streams...", "info");
        await instance.writeFile(inputName, await fetchFile(file));
        if (isCancelled) throw new Error("Cancelled");

        logMessage("Detecting input video codec...", "info");
        const detectedCodec = await probeInputCodec(instance, inputName);
        const targetEncoder = detectedCodec
            ? (CODEC_ENCODER_MAP[detectedCodec] ?? "libx264")
            : "libx264";
        logMessage(
            `Input codec: ${detectedCodec ?? "unknown"} -> encoder: ${targetEncoder}`,
            "info",
        );

        const isMultiThread =
            typeof window.SharedArrayBuffer !== "undefined" &&
            window.crossOriginIsolated;
        const threads = Math.min(navigator.hardwareConcurrency || 4, 8);
        if (!isMultiThread) {
            logMessage(
                "Notice: Single-threaded mode active. Enable HTTPS/cross-origin isolation for faster processing.",
                "warning",
            );
        }

        let filter =
            "mpdecimate,minterpolate=fps=60:mi_mode=mci:me_mode=bilat:me=epzs:search_param=4";
        if (width > height) {
            filter = `scale=-2:${targetRes},${filter}`;
        } else {
            filter = `scale=${targetRes}:-2,${filter}`;
        }

        logMessage(
            "Interpolating video frames to 60fps... This may take up to a minute.",
            "info",
        );

        const buildArgs = (encoder) => [
            "-i",
            inputName,
            "-vf",
            filter,
            "-c:v",
            encoder,
            "-preset",
            "ultrafast",
            "-crf",
            "20",
            "-c:a",
            "aac",
            "-b:a",
            "250k",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-video_track_timescale",
            "90000",
            "-threads",
            String(threads),
            outputName,
        ];

        const succeeded = await execWithEncoder(
            instance,
            buildArgs(targetEncoder),
            targetEncoder,
        );

        if (!succeeded) {
            logMessage(
                `Encoder ${targetEncoder} not available in this build. Falling back to libx264.`,
                "warning",
            );
            await instance.exec(buildArgs("libx264"));
        }

        logMessage("Completed frame processing.", "success");
        const data = await instance.readFile(outputName);

        await instance.deleteFile(inputName).catch(() => {});
        await instance.deleteFile(outputName).catch(() => {});

        return data.buffer;
    } catch (err) {
        await destroyFFmpegInstance();
        throw err;
    }
}

async function patchSingleFile(item) {
    const enableInterpolation = document.getElementById("enableInterpolation");

    if (enableInterpolation?.checked) {
        logMessage("Starting VFI Engine for frame rate upgrade...", "info");
        if (isCancelled) throw new Error("Cancelled");
        const videoInfo = await getVideoDurationAndResolution(item.file);
        if (isCancelled) throw new Error("Cancelled");
        if (!videoInfo) {
            throw new Error("Could not parse video metadata.");
        }

        if (videoInfo.duration > MAX_VIDEO_DURATION_SECONDS) {
            throw new Error(
                `Video duration of ${Math.round(videoInfo.duration)}s exceeds the strict 30s limit.`,
            );
        }

        const vfiResEl = document.getElementById("outputResolution");
        const vfiTargetRes = vfiResEl
            ? Number.parseInt(vfiResEl.value, 10)
            : 1080;
        const workingBuffer = await runVFI(
            item.file,
            videoInfo.width,
            videoInfo.height,
            vfiTargetRes,
        );
        const workingBytes = new Uint8Array(workingBuffer);
        const workingView = new DataView(workingBuffer);

        const mimeType = getMimeType(item.file);
        const outputName = getOutputFilename(item.file);

        let finalBuffer = workingBuffer;
        let finalBytes = workingBytes;
        let finalView = workingView;

        const elstResult = rebuildWithElstBypass(workingBytes, workingView);
        if (elstResult) {
            finalBuffer = elstResult.newBuffer;
            finalBytes = elstResult.newBytes;
            finalView = new DataView(finalBuffer);
            logMessage(
                `  [Pass 1/5] ZeroLoss Track Bypass: Applied.`,
                "success",
            );
        } else {
            logMessage(
                "  [Pass 1/5] ZeroLoss Track Bypass skipped.",
                "warning",
            );
        }

        const quantumResult = patchMvhdMatrix(finalBytes, finalView);
        if (quantumResult && !quantumResult.skipped) {
            logMessage(`  [Pass 2/5] Quantum Matrix: Patched.`, "success");
        } else {
            logMessage("  [Pass 2/5] Quantum Matrix skipped.", "warning");
        }

        const udtaResult = stripUdtaAtom(finalBytes, finalView);
        if (udtaResult) {
            finalBuffer = udtaResult.newBuffer;
            finalBytes = udtaResult.newBytes;
            finalView = new DataView(finalBuffer);
            logMessage("  [Pass 3/5] Udta Strip: Applied.", "success");
        } else {
            logMessage("  [Pass 3/5] Udta Strip skipped.", "warning");
        }

        const tkhdResult = stripTkhdMatrix(finalBytes, finalView);
        if (tkhdResult.patched) {
            logMessage("  [Pass 4/5] Tkhd Matrix Zero: Applied.", "success");
        } else {
            logMessage("  [Pass 4/5] Tkhd Matrix Zero skipped.", "warning");
        }

        const commentResult = injectCommentUdta(
            finalBytes,
            finalView,
            "KwjYwI2DziQ8It5PyJGJgQ",
        );
        if (commentResult) {
            finalBuffer = commentResult.newBuffer;
            finalBytes = commentResult.newBytes;
            finalView = new DataView(finalBuffer);
            logMessage(
                "  [Pass 5/5] Comment Udta Injection: Applied.",
                "success",
            );
        } else {
            logMessage(
                "  [Pass 5/5] Comment Udta Injection skipped.",
                "warning",
            );
        }

        return { finalBuffer, outputName, mimeType };
    }

    if (isCancelled) throw new Error("Cancelled");

    const videoInfo = await getVideoDurationAndResolution(item.file);
    if (isCancelled) throw new Error("Cancelled");
    if (!videoInfo) {
        throw new Error("Could not parse video metadata.");
    }

    const resolutionEl = document.getElementById("outputResolution");
    const targetRes = resolutionEl
        ? Number.parseInt(resolutionEl.value, 10)
        : 1080;
    const resolutionBitrate = { 1080: "14261k", 1440: "25000k" };
    const resolutionMaxrate = { 1080: "15000k", 1440: "27000k" };
    const resolutionBufsize = { 1080: "28000k", 1440: "50000k" };
    const targetBitrate = resolutionBitrate[targetRes] || "14261k";
    const targetMaxrate = resolutionMaxrate[targetRes] || "15000k";
    const targetBufsize = resolutionBufsize[targetRes] || "28000k";

    const isLandscape = videoInfo.width > videoInfo.height;
    const scaleFilter = isLandscape
        ? `scale=-2:${targetRes}`
        : `scale=${targetRes}:-2`;

    logMessage(
        `  Source: ${videoInfo.width}x${videoInfo.height} (${isLandscape ? "landscape" : "portrait"}) → ${isLandscape ? `H:${targetRes}` : `W:${targetRes}`} adaptive`,
        "info",
    );

    const mimeType = getMimeType(item.file);
    const outputName = getOutputFilename(item.file);

    logMessage("  [Pass 1/5] Running container reencode...", "info");

    const instance = await getFFmpeg();
    if (isCancelled) throw new Error("Cancelled");

    const ext = resolveInputExtension(item.file);
    const inputName = `input${ext}`;
    const tempFileName = `temp${ext}`;
    const outputFileName = `output${ext}`;

    await instance.writeFile(inputName, await fetchFile(item.file));
    if (isCancelled) {
        await instance.deleteFile(inputName).catch(() => {});
        throw new Error("Cancelled");
    }

    await instance.exec([
        "-i",
        inputName,
        "-vf",
        scaleFilter,
        "-c:v",
        "libx264",
        "-profile:v",
        "main",
        "-level",
        "4.2",
        "-pix_fmt",
        "yuv420p",
        "-b:v",
        targetBitrate,
        "-maxrate",
        targetMaxrate,
        "-bufsize",
        targetBufsize,
        "-g",
        "30",
        "-bf",
        "2",
        "-refs",
        "1",
        "-preset",
        "medium",
        "-c:a",
        "aac",
        "-b:a",
        "250k",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-video_track_timescale",
        "90000",
        "-movflags",
        "+faststart",
        tempFileName,
    ]);

    if (isCancelled) {
        await instance.deleteFile(inputName).catch(() => {});
        await instance.deleteFile(tempFileName).catch(() => {});
        throw new Error("Cancelled");
    }

    await instance.exec([
        "-i",
        tempFileName,
        "-c",
        "copy",
        "-map_metadata",
        "-1",
        "-metadata:s:v",
        "language=und",
        "-metadata:s:a",
        "language=und",
        "-metadata:s:v",
        "handler_name=VideoHandler",
        "-metadata:s:a",
        "handler_name=SoundHandler",
        "-metadata",
        "comment=KwjYwI2DziQ8It5PyJGJgQ",
        "-movflags",
        "+faststart",
        outputFileName,
    ]);

    await instance.deleteFile(tempFileName).catch(() => {});

    if (isCancelled) {
        await instance.deleteFile(inputName).catch(() => {});
        await instance.deleteFile(outputFileName).catch(() => {});
        throw new Error("Cancelled");
    }

    const data = await instance.readFile(outputFileName);
    await instance.deleteFile(inputName).catch(() => {});
    await instance.deleteFile(outputFileName).catch(() => {});

    logMessage("  [Pass 1/7] Container transform complete.", "success");

    let finalBuffer = data.buffer;
    let finalBytes = new Uint8Array(finalBuffer);
    let finalView = new DataView(finalBuffer);

    const elstResult = rebuildWithElstBypass(finalBytes, finalView);
    if (elstResult) {
        finalBuffer = elstResult.newBuffer;
        finalBytes = elstResult.newBytes;
        finalView = new DataView(finalBuffer);
        logMessage(`  [Pass 2/7] ZeroLoss Track Bypass: Applied.`, "success");
    } else {
        logMessage("  [Pass 2/7] ZeroLoss Track Bypass skipped.", "warning");
    }

    const quantumResult = patchMvhdMatrix(finalBytes, finalView);
    if (quantumResult && !quantumResult.skipped) {
        logMessage(`  [Pass 3/7] Quantum Matrix: Patched.`, "success");
    } else {
        logMessage("  [Pass 3/7] Quantum Matrix skipped.", "warning");
    }

    const udtaResult = stripUdtaAtom(finalBytes, finalView);
    if (udtaResult) {
        finalBuffer = udtaResult.newBuffer;
        finalBytes = udtaResult.newBytes;
        finalView = new DataView(finalBuffer);
        logMessage("  [Pass 4/7] Udta Strip: Applied.", "success");
    } else {
        logMessage("  [Pass 4/7] Udta Strip skipped.", "warning");
    }

    const tkhdResult = stripTkhdMatrix(finalBytes, finalView);
    if (tkhdResult.patched) {
        logMessage("  [Pass 5/7] Tkhd Matrix Zero: Applied.", "success");
    } else {
        logMessage("  [Pass 5/7] Tkhd Matrix Zero skipped.", "warning");
    }

    const inflateResult = inflateSampleTableVideo(finalBytes, finalView, 5);
    if (inflateResult) {
        finalBuffer = inflateResult.newBuffer;
        finalBytes = inflateResult.newBytes;
        finalView = new DataView(finalBuffer);
        logMessage("  [Pass 6/7] Frame Density Inflation: Applied.", "success");
    } else {
        logMessage("  [Pass 6/7] Frame Density Inflation skipped.", "warning");
    }

    const commentResult = injectCommentUdta(
        finalBytes,
        finalView,
        "KwjYwI2DziQ8It5PyJGJgQ",
    );
    if (commentResult) {
        finalBuffer = commentResult.newBuffer;
        finalBytes = commentResult.newBytes;
        finalView = new DataView(finalBuffer);
        logMessage("  [Pass 7/7] Comment Udta Injection: Applied.", "success");
    } else {
        logMessage("  [Pass 7/7] Comment Udta Injection skipped.", "warning");
    }

    return { finalBuffer, outputName, mimeType };
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
        logMessage("Cancelling active interpolation progress...", "warning");
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
    if (currentFlowState === "completed") {
        await downloadSelectedFiles();
        return;
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

    for (let i = 0; i < pendingItems.length; i++) {
        if (isCancelled) {
            break;
        }
        const item = pendingItems[i];
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

            if (
                result.finalBuffer &&
                result.finalBuffer.byteLength !== undefined &&
                result.finalBuffer.byteLength <= MAX_STORAGE_BYTES
            ) {
                try {
                    if (isCancelled) break;
                    const blob = new Blob([result.finalBuffer], {
                        type: result.mimeType,
                    });
                    let thumbnail = await captureVideoFrame(blob);
                    if (isCancelled) break;
                    if (!thumbnail) {
                        thumbnail = await captureVideoFrame(item.file);
                        if (isCancelled) break;
                    }
                    await saveRecord({
                        id: self.crypto.randomUUID(),
                        name: result.outputName,
                        size: result.finalBuffer.byteLength,
                        timestamp: Date.now(),
                        thumbnail,
                        blob,
                        mimeType: result.mimeType,
                    });
                    await renderHistoryList();
                } catch (dbError) {
                    logMessage(
                        `  Database save skipped: ${dbError.message}`,
                        "warning",
                    );
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
            logMessage(`  Error: ${error.message}`, "error");
        }

        renderFileList();
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
        logMessage("Interpolation progress cancelled by user.", "warning");
        renderFileList();
        updatePatchButton();
        refreshIcons();
        return;
    }

    currentFlowState = "completed";
    setProgress(100);
    releaseWakeLock();
    logMessage(
        `Done. ${successCount}/${pendingItems.length} file(s) patched successfully.`,
        successCount === pendingItems.length ? "success" : "warning",
    );
    hideProgress();

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
        historyList.innerHTML = `<div class="history-item-empty" style="font-size: 10px; color: #657c6a; text-align: center; padding: 12px 0; font-family: 'JetBrains Mono', monospace;">No history records found</div>`;
        refreshIcons();
        return;
    }

    for (const record of records) {
        const item = document.createElement("div");
        item.className = "history-item";

        const thumb = document.createElement("div");
        thumb.className = "history-thumbnail";
        if (
            record.thumbnail &&
            record.thumbnail.startsWith(SAFE_THUMBNAIL_PREFIX)
        ) {
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

const enableInterpolation = document.getElementById("enableInterpolation");
const vfiModal = document.getElementById("vfiModal");
const closeVfiModalBtn = document.getElementById("closeVfiModalBtn");
const cancelVfiBtn = document.getElementById("cancelVfiBtn");
const confirmVfiBtn = document.getElementById("confirmVfiBtn");

if (enableInterpolation && vfiModal) {
    enableInterpolation.addEventListener("change", () => {
        if (enableInterpolation.checked) {
            vfiModal.classList.add("active");
        }
    });

    const closeModal = () => vfiModal.classList.remove("active");

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

const tiktokModal = document.getElementById("tiktokModal");
const tiktokStudioBtn = document.getElementById("tiktokStudioBtn");
const closeTiktokModalBtn = document.getElementById("closeTiktokModalBtn");
const cancelTiktokModalBtn = document.getElementById("cancelTiktokModalBtn");
const confirmTiktokBtn = document.getElementById("confirmTiktokBtn");

function isMobileDevice() {
    return (
        window.innerWidth <= MOBILE_BREAKPOINT ||
        /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    );
}

if (tiktokStudioBtn && tiktokModal) {
    tiktokStudioBtn.addEventListener("click", (e) => {
        if (isMobileDevice()) {
            e.preventDefault();
            tiktokModal.classList.add("active");
        }
    });

    const closeTiktokModal = () => tiktokModal.classList.remove("active");

    closeTiktokModalBtn?.addEventListener("click", closeTiktokModal);
    cancelTiktokModalBtn?.addEventListener("click", closeTiktokModal);
    confirmTiktokBtn?.addEventListener("click", closeTiktokModal);

    tiktokModal.addEventListener("click", (e) => {
        if (e.target === tiktokModal) closeTiktokModal();
    });
}

initializeApp();

const changelogContainer = document.getElementById("changelogContainer");
if (changelogContainer) {
    initChangelog(changelogContainer);
}
