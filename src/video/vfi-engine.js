import { fetchFile } from "@ffmpeg/util";
import { getFFmpeg, destroyFFmpegInstance, resolveInputExtension } from "./ffmpeg-manager.js";
import { extractThumbnailFromInstance } from "./thumbnail-utils.js";

// ===== CẤU HÌNH CHỐNG OOM =====
const MAX_MEMORY_MB = 2048;
const FALLBACK_CRF = 28;
const FALLBACK_PRESET = "ultrafast";

export async function runVFI(file, width, height, targetRes, applyHDR, isCancelled, logMessage, setProgress, enableTurbo = false, targetFPS = 120) {
    let instance;
    const ext = resolveInputExtension(file);
    const inputName = `input${ext}`;
    const outputName = applyHDR ? "output.mp4" : `output${ext}`;
    
    try {
        if (isCancelled?.()) throw new Error("Cancelled");
        instance = await getFFmpeg(logMessage, setProgress);
        if (isCancelled?.()) throw new Error("Cancelled");

        // ===== GIỚI HẠN RAM =====
        try {
            await instance.setMemoryLimit(MAX_MEMORY_MB * 1024 * 1024);
            if (logMessage) logMessage(`🧠 Memory limit set to ${MAX_MEMORY_MB}MB`, "info");
        } catch (_) {}

        if (logMessage) logMessage("Preparing video data streams...", "info");
        const fileData = await fetchFile(file);
        await instance.writeFile(inputName, fileData);
        if (isCancelled?.()) throw new Error("Cancelled");

        // ===== CẤU HÌNH THEO TURBO MODE (NHANH HƠN, VẪN GIỮ FPS) =====
        const preset = enableTurbo ? "veryfast" : "fast";
        const crf = enableTurbo ? 20 : 18;
        const searchParam = enableTurbo ? 2 : 4;
        const threads = Math.min(navigator.hardwareConcurrency || 4, enableTurbo ? 4 : 4);

        if (logMessage) logMessage(`⚙️ Mode: ${enableTurbo ? "TURBO (faster)" : "QUALITY"} | Target FPS: ${targetFPS} (unchanged)`, "info");

        // ===== FILTER VỚI targetFPS =====
        let filter;
        if (applyHDR) {
            filter =
                `minterpolate=fps=${targetFPS}:mi_mode=mci:me_mode=bilat:me=epzs:search_param=${searchParam},` +
                "eq=brightness=0.20:contrast=1.25," +
                "zscale=transfer=linear," +
                "zscale=transfer=smpte2084:primaries=bt2020:matrix=bt2020nc," +
                "format=yuv420p10le";
        } else {
            filter =
                `minterpolate=fps=${targetFPS}:mi_mode=mci:me_mode=bilat:me=epzs:search_param=${searchParam}`;
        }
        
        if (width > height) {
            filter = `scale=-2:${targetRes},${filter}`;
        } else {
            filter = `scale=${targetRes}:-2,${filter}`;
        }

        // ===== THỬ VỚI CẤU HÌNH CHÍNH =====
        let args = applyHDR ? [
            "-i", inputName,
            "-vf", filter,
            "-c:v", "libx265",
            "-preset", preset,
            "-crf", String(crf),
            "-maxrate", enableTurbo ? "15M" : "20M",
            "-bufsize", enableTurbo ? "30M" : "40M",
            "-pix_fmt", "yuv420p10le",
            "-x265-params", "hdr10=1:repeat-headers=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50):max-cll=1000,400",
            "-c:a", "copy",
            "-video_track_timescale", "90000",
            "-threads", String(threads),
            outputName,
        ] : [
            "-i", inputName,
            "-vf", filter,
            "-c:v", "libx264",
            "-preset", preset,
            "-crf", String(crf),
            "-c:a", "copy",
            "-video_track_timescale", "90000",
            "-threads", String(threads),
            outputName,
        ];
        
        if (logMessage) logMessage(`🔄 Encoding to ${targetFPS}fps with ${preset} preset...`, "info");
        setProgress(30);
        
        let ret;
        let oomRetry = false;

        try {
            ret = await instance.exec(args);
        } catch (execErr) {
            if (execErr.message?.includes("Out of memory") || execErr.message?.includes("OOM")) {
                oomRetry = true;
                if (logMessage) logMessage("⚠️ Out of memory detected! Retrying with lower quality...", "warning");
            } else {
                throw execErr;
            }
        }

        // ===== NẾU OOM, THỬ LẠI VỚI CẤU HÌNH THẤP HƠN (VẪN GIỮ FPS) =====
        if (oomRetry) {
            const fallbackPreset = FALLBACK_PRESET;
            const fallbackCrf = FALLBACK_CRF;
            const fallbackThreads = 1;
            
            if (logMessage) logMessage(`🔄 Retry with preset: ${fallbackPreset}, crf: ${fallbackCrf}, threads: ${fallbackThreads} (FPS still ${targetFPS})`, "warning");
            
            args = applyHDR ? [
                "-i", inputName,
                "-vf", filter,
                "-c:v", "libx265",
                "-preset", fallbackPreset,
                "-crf", String(fallbackCrf),
                "-maxrate", "5M",
                "-bufsize", "10M",
                "-pix_fmt", "yuv420p10le",
                "-x265-params", "hdr10=1:repeat-headers=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50):max-cll=1000,400",
                "-c:a", "copy",
                "-video_track_timescale", "90000",
                "-threads", "1",
                outputName,
            ] : [
                "-i", inputName,
                "-vf", filter,
                "-c:v", "libx264",
                "-preset", fallbackPreset,
                "-crf", String(fallbackCrf),
                "-c:a", "copy",
                "-video_track_timescale", "90000",
                "-threads", "1",
                outputName,
            ];
            
            ret = await instance.exec(args);
        }

        if (ret !== 0 && ret !== undefined) {
            throw new Error(`FFmpeg exited with code ${ret}`);
        }
        
        setProgress(80);

        const data = await instance.readFile(outputName);
        if (!data || data.byteLength < 100) {
            throw new Error("FFmpeg produced an empty or invalid output file.");
        }

        let thumbnailBuffer = null;
        if (applyHDR) {
            thumbnailBuffer = await extractThumbnailFromInstance(instance, outputName, logMessage);
        }

        setProgress(100);
        if (logMessage) logMessage(`✅ Done! Output: ${targetFPS}fps`, "success");

        return { buffer: data.buffer, thumbnail: thumbnailBuffer };
        
    } catch (err) {
        if (logMessage) try { logMessage(`VFI Error: ${err.message}`, "error"); } catch (_) {}
        await destroyFFmpegInstance();
        throw err;
    } finally {
        if (instance) {
            await instance.deleteFile(inputName).catch(() => {});
            await instance.deleteFile(outputName).catch(() => {});
        }
        if (window.gc) try { window.gc(); } catch (_) {}
    }
}
