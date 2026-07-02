import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";

let ffmpegInstance = null;

export async function destroyFFmpegInstance() {
    if (!ffmpegInstance) return;
    const tempInstance = ffmpegInstance;
    ffmpegInstance = null; // Set null first so concurrent callers see a dead instance
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
    
    ffmpegInstance.on("progress", ({ progress }) => {
        setProgress(Math.round(progress * 100));
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
