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

/**
 * Lấy instance FFmpeg (singleton)
 * Tự động load với cấu hình MT hoặc ST
 */
export async function getFFmpeg(logMessage, setProgress) {
    if (ffmpegInstance) {
        // Kiểm tra instance vẫn còn hoạt động
        try {
            // Test nhẹ để xem instance có alive không
            await ffmpegInstance.writeFile("/tmp/test.txt", new Uint8Array([1]));
            await ffmpegInstance.deleteFile("/tmp/test.txt");
            return ffmpegInstance;
        } catch (_) {
            // Instance chết, tạo mới
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
    
    // Progress callback
    ffmpegInstance.on("progress", ({ progress }) => {
        if (setProgress) {
            const pct = Math.min(100, Math.round(progress * 100));
            setProgress(pct);
        }
    });

    // Log callback
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
        
        // ===== KIỂM TRA VÀ TĂNG MEMORY (nếu hỗ trợ) =====
        // FFmpeg.wasm không có setMemoryLimit, nhưng có thể set qua env
        try {
            // Một số phiên bản hỗ trợ env
            await ffmpegInstance.exec(['-version']);
            logMessage("✅ Video processing engine loaded successfully.", "success");
        } catch (envErr) {
            // Ignore - version check không quan trọng
        }
        
    } catch (err) {
        logMessage(`❌ Failed to load video engine: ${err.message}`, "error");
        await destroyFFmpegInstance();
        throw err;
    }
    return ffmpegInstance;
}

/**
 * Lấy extension phù hợp cho input file
 */
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
        
        // Lấy frame đầu tiên làm thumbnail
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
        
        // Cleanup
        await ffmpeg.deleteFile(inputName).catch(() => {});
        await ffmpeg.deleteFile(outputName).catch(() => {});
        
        return thumbData;
    } catch (err) {
        logMessage(`Thumbnail extraction failed: ${err.message}`, "warning");
        return null;
    }
}

// ============================================================
// HÀM RUN VFI
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
    enableTurbo = false,
    targetFPS = 120
) {
    const ffmpeg = await getFFmpeg(logMessage, setProgress);
    
    const inputExt = resolveInputExtension(file);
    const inputName = `input${inputExt}`;
    const outputName = "output.mp4";
    const tempName = "temp.mp4";
    
    const fileData = new Uint8Array(await file.arrayBuffer());
    await ffmpeg.writeFile(inputName, fileData);
    
    // Tính toán scale
    const targetWidth = targetRes === 1440 ? 2560 : 1920;
    const targetHeight = targetRes === 1440 ? 1440 : 1080;
    
    let scaleFilter;
    if (width > height) {
        // Landscape
        const scale = Math.min(targetWidth / width, targetHeight / height);
        const newW = Math.round(width * scale);
        const newH = Math.round(height * scale);
        scaleFilter = `scale=${newW}:${newH}:flags=lanczos`;
    } else {
        // Portrait
        const scale = Math.min(targetHeight / height, targetWidth / width);
        const newW = Math.round(width * scale);
        const newH = Math.round(height * scale);
        scaleFilter = `scale=${newW}:${newH}:flags=lanczos`;
    }
    
    // FPS filter
    const fpsFilter = `fps=${targetFPS}`;
    
    // Chọn codec dựa trên HDR
    const isHevc = applyHDR || false;
    const codec = isHevc ? 'libx265' : 'libx264';
    const pixFmt = isHevc ? 'yuv420p10le' : 'yuv420p';
    const crf = isHevc ? 18 : 20;
    const preset = enableTurbo ? 'ultrafast' : (isHevc ? 'medium' : 'fast');
    
    let videoFilter = `${scaleFilter},${fpsFilter}`;
    
    // HDR color parameters
    let hdrParams = [];
    if (applyHDR) {
        videoFilter = `${videoFilter},eq=brightness=0.20:contrast=1.25`;
        hdrParams = [
            '-colorspace', 'bt2020nc',
            '-color_primaries', 'bt2020',
            '-color_trc', 'smpte2084',
            '-color_range', 'tv',
            '-pix_fmt', 'yuv420p10le',
        ];
    }
    
    // Audio params
    const audioParams = ['-c:a', 'copy'];
    
    // HEVC params
    let hevcParams = [];
    if (isHevc) {
        hevcParams = [
            '-x265-params', 'colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400'
        ];
    }
    
    try {
        // Chạy VFI
        await ffmpeg.exec([
            '-i', inputName,
            '-vf', videoFilter,
            '-c:v', codec,
            '-crf', String(crf),
            '-preset', preset,
            ...hdrParams,
            ...hevcParams,
            ...audioParams,
            '-movflags', '+faststart',
            outputName
        ]);
        
        if (isCancelled()) {
            await ffmpeg.deleteFile(inputName).catch(() => {});
            await ffmpeg.deleteFile(outputName).catch(() => {});
            throw new Error("Cancelled");
        }
        
        // Đọc output
        const outputData = await ffmpeg.readFile(outputName);
        
        // Extract thumbnail (từ frame đầu)
        let thumbnail = null;
        try {
            const thumbName = "thumb.jpg";
            await ffmpeg.exec([
                '-i', outputName,
                '-vf', 'scale=120:-1',
                '-frames:v', '1',
                '-f', 'image2',
                '-c:v', 'mjpeg',
                '-q:v', '2',
                thumbName
            ]);
            thumbnail = await ffmpeg.readFile(thumbName);
            await ffmpeg.deleteFile(thumbName).catch(() => {});
        } catch (_) {}
        
        // Cleanup
        await ffmpeg.deleteFile(inputName).catch(() => {});
        await ffmpeg.deleteFile(outputName).catch(() => {});
        
        return {
            buffer: outputData.buffer,
            thumbnail
        };
        
    } catch (err) {
        await ffmpeg.deleteFile(inputName).catch(() => {});
        await ffmpeg.deleteFile(outputName).catch(() => {});
        if (err.message === "Cancelled") throw err;
        logMessage(`VFI failed: ${err.message}`, "error");
        throw err;
    }
}

// ============================================================
// HÀM RUN HDR
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
    // Tương tự VFI nhưng chỉ HDR
    return runVFI(file, width, height, targetRes, true, isCancelled, logMessage, setProgress, false, 30);
}
