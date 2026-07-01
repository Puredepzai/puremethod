import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";

let ffmpegInstance = null;

// ===== CẤU HÌNH GIỚI HẠN TÀI NGUYÊN =====
const MEMORY_LIMIT_MB = 512; // Giới hạn RAM tối đa 512MB
const THREAD_COUNT = 2;       // Giới hạn số luồng xử lý
// ========================================

export async function destroyFFmpegInstance() {
    if (!ffmpegInstance) return;
    const tempInstance = ffmpegInstance;
    ffmpegInstance = null;
    try {
        await tempInstance.terminate();
    } catch (err) {
        console.error("FFmpeg terminate failed:", err);
    }
}

export async function getFFmpeg(logMessage, setProgress) {
    if (ffmpegInstance) return ffmpegInstance;

    ffmpegInstance = new FFmpeg();
    logMessage("Loading video processing engine...", "info");
    
    const isMultiThread =
        typeof window.SharedArrayBuffer !== "undefined" &&
        window.crossOriginIsolated;
    const baseURL = isMultiThread
        ? "https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@0.12.6/dist/esm"
        : "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm";
    
    // ===== GIỚI HẠN PROGRESS =====
    let lastProgress = 0;
    ffmpegInstance.on("progress", ({ progress }) => {
        const pct = Math.round(progress * 100);
        if (pct !== lastProgress) {
            lastProgress = pct;
            setProgress(Math.min(pct, 100));
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
        
        // ===== ÁP DỤNG GIỚI HẠN TÀI NGUYÊN =====
        try {
            // Giới hạn bộ nhớ (nếu FFmpeg hỗ trợ)
            await ffmpegInstance.setMemoryLimit(MEMORY_LIMIT_MB * 1024 * 1024);
            logMessage(`Memory limit set to ${MEMORY_LIMIT_MB}MB`, "info");
        } catch (_) {
            // Nếu không hỗ trợ, bỏ qua
        }
        
        try {
            // Giới hạn số luồng
            await ffmpegInstance.setThreadCount(THREAD_COUNT);
            logMessage(`Thread count set to ${THREAD_COUNT}`, "info");
        } catch (_) {
            // Nếu không hỗ trợ, bỏ qua
        }
        // ========================================
        
        logMessage("Video processing engine loaded successfully.", "success");
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

// ===== HÀM HỖ TRỢ THÊM THAM SỐ GIỚI HẠN CHO FFMPEG =====
export function getLimitedFFmpegArgs(extraArgs = []) {
    // Thêm các tham số giới hạn tài nguyên vào lệnh FFmpeg
    const limitArgs = [
        '-threads', String(THREAD_COUNT),
        '-memory_limit', String(MEMORY_LIMIT_MB * 1024 * 1024),
    ];
    return [...limitArgs, ...extraArgs];
}
// ======================================================
