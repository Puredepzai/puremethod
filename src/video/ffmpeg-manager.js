import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";

let ffmpegInstance = null;

// ===== CẤU HÌNH TỐI ĐA =====
const MEMORY_LIMIT_MB = 4096; // 4GB RAM (tối đa)
const THREAD_COUNT = 1;       // 1 luồng để giảm RAM
// ===========================

export async function destroyFFmpegInstance() {
    if (!ffmpegInstance) return;
    const tempInstance = ffmpegInstance;
    ffmpegInstance = null;
    try {
        await tempInstance.terminate();
        if (window.gc) {
            try { window.gc(); } catch (_) {}
        }
    } catch (err) {
        console.error("FFmpeg terminate failed:", err);
    }
}

export async function getFFmpeg(logMessage, setProgress) {
    if (ffmpegInstance) return ffmpegInstance;

    ffmpegInstance = new FFmpeg();
    if (logMessage) logMessage("Loading video processing engine...", "info");
    
    const isMultiThread =
        typeof window.SharedArrayBuffer !== "undefined" &&
        window.crossOriginIsolated;
    const baseURL = isMultiThread
        ? "https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@0.12.6/dist/esm"
        : "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm";
    
    let lastProgress = 0;
    ffmpegInstance.on("progress", ({ progress }) => {
        if (!setProgress) return;
        const pct = Math.round(progress * 100);
        if (pct !== lastProgress) {
            lastProgress = pct;
            try { setProgress(Math.min(pct, 100)); } catch (_) {}
        }
    });

    try {
        const loadConfig = {
            coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
            wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
            classWorkerURL: await toBlobURL(
                "https://esm.sh/@ffmpeg/ffmpeg@0.12.15/es2022/dist/esm/worker.bundle.mjs",
                "text/javascript",
            ),
        };
        if (isMultiThread) {
            loadConfig.workerURL = await toBlobURL(`${baseURL}/ffmpeg-core.worker.js`, "text/javascript");
        }
        await ffmpegInstance.load(loadConfig);
        
        // ===== TĂNG RAM TỐI ĐA =====
        try {
            await ffmpegInstance.setMemoryLimit(MEMORY_LIMIT_MB * 1024 * 1024);
            if (logMessage) logMessage(`Memory limit set to ${MEMORY_LIMIT_MB}MB`, "info");
        } catch (_) {
            if (logMessage) logMessage("Memory limit not supported", "warning");
        }
        
        try {
            await ffmpegInstance.setThreadCount(THREAD_COUNT);
            if (logMessage) logMessage(`Thread count set to ${THREAD_COUNT}`, "info");
        } catch (_) {
            if (logMessage) logMessage("Thread count not supported", "warning");
        }
        
        if (logMessage) logMessage("Video processing engine loaded successfully.", "success");
    } catch (err) {
        await destroyFFmpegInstance();
        throw err;
    }
    return ffmpegInstance;
}

export function resolveInputExtension(file) {
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".mov")) return ".mov";
    if (lower.endsWith(".webm")) return ".webm";
    return ".mp4";
}

export function getLimitedFFmpegArgs(extraArgs = []) {
    const limitArgs = [
        '-threads', String(THREAD_COUNT),
        '-memory_limit', String(MEMORY_LIMIT_MB * 1024 * 1024),
    ];
    return [...limitArgs, ...extraArgs];
}
