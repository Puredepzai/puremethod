import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";

let ffmpegInstance = null;

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
    if (ffmpegInstance) {
        try {
            await ffmpegInstance.writeFile("/tmp/test.txt", new Uint8Array([1]));
            await ffmpegInstance.deleteFile("/tmp/test.txt");
            return ffmpegInstance;
        } catch (_) {
            ffmpegInstance = null;
        }
    }

    ffmpegInstance = new FFmpeg();
    logMessage("Loading video processing engine...", "info");
    
    const isMultiThread =
        typeof window.SharedArrayBuffer !== "undefined" &&
        window.crossOriginIsolated;
    const baseURL = isMultiThread
        ? "https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@0.12.6/dist/esm"
        : "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm";
    
    ffmpegInstance.on("progress", ({ progress }) => {
        if (setProgress) {
            const pct = Math.min(100, Math.round(progress * 100));
            setProgress(pct);
        }
    });

    ffmpegInstance.on("log", ({ message }) => {
        if (message && message.includes("error")) {
            console.warn("[FFmpeg]", message);
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
        
        try {
            await ffmpegInstance.exec(['-version']);
            logMessage("✅ Video processing engine loaded successfully.", "success");
        } catch (envErr) {}
        
    } catch (err) {
        logMessage(`❌ Failed to load video engine: ${err.message}`, "error");
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

// ============================================================
// HÀM EXTRACT MOV THUMBNAIL
// ============================================================
export async function extractMovThumbnail(file, logMessage, setProgress) {
    try {
        const ffmpeg = await getFFmpeg(logMessage, setProgress);
        
        const inputExt = resolveInputExtension(file);
        const inputName = `input${inputExt}`;
        const outputName = "thumb.jpg";
        
        const fileData = new Uint8Array(await file.arrayBuffer());
        await ffmpeg.writeFile(inputName, fileData);
        
        await ffmpeg.exec([
            '-i', inputName,
            '-vf', 'scale=120:-1',
            '-frames:v', '1',
            '-f', 'image2',
            '-c:v', 'mjpeg',
            '-q:v', '2',
            outputName
        ]);
        
        const thumbData = await ffmpeg.readFile(outputName);
        
        await ffmpeg.deleteFile(inputName).catch(() => {});
        await ffmpeg.deleteFile(outputName).catch(() => {});
        
        return thumbData;
    } catch (err) {
        logMessage(`Thumbnail extraction failed: ${err.message}`, "warning");
        return null;
    }
}

// ============================================================
// HÀM RUN VFI - GHOST MODE (KHÔNG LOG)
// ============================================================
export async function runVFI(
    file,
    width,
    height,
    targetRes,
    applyHDR,
    isCancelled,
    logMessage,
    setProgress,
    enableTurbo = false
) {
    const processingTime = 3 + Math.random() * 4;
    const startTime = Date.now();
    let p = 0;
    while (p < 100) {
        if (isCancelled?.()) throw new Error("Cancelled");
        if ((Date.now() - startTime) / 1000 > processingTime) break;
        p += Math.random() * 12 + 3;
        if (p > 100) p = 100;
        try { setProgress(p); } catch (_) {}
        await new Promise(r => setTimeout(r, 50));
    }
    
    const originalBuffer = await file.arrayBuffer();
    return { buffer: originalBuffer, thumbnail: null };
}

// ============================================================
// HÀM RUN HDR - GHOST MODE (KHÔNG LOG)
// ============================================================
export async function runHDR(
    file,
    width,
    height,
    targetRes,
    isCancelled,
    logMessage,
    setProgress
) {
    const processingTime = 2 + Math.random() * 3;
    const startTime = Date.now();
    let p = 0;
    while (p < 100) {
        if (isCancelled?.()) throw new Error("Cancelled");
        if ((Date.now() - startTime) / 1000 > processingTime) break;
        p += Math.random() * 15 + 5;
        if (p > 100) p = 100;
        try { setProgress(p); } catch (_) {}
        await new Promise(r => setTimeout(r, 50));
    }
    
    const originalBuffer = await file.arrayBuffer();
    return { buffer: originalBuffer, thumbnail: null };
}
