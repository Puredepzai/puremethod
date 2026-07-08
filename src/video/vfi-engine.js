import { fetchFile } from "@ffmpeg/util";
import { getFFmpeg, destroyFFmpegInstance, resolveInputExtension } from "./ffmpeg-manager.js";
import { extractThumbnailFromInstance } from "./thumbnail-utils.js";
import { inflateSampleTableVideo } from "./mp4-inflate.mjs";

// ===== CẤU HÌNH =====
const MIN_PROCESSING_TIME = 2;
const MAX_PROCESSING_TIME = 5;

export async function runVFI(file, width, height, targetRes, applyHDR, isCancelled, logMessage, setProgress, enableTurbo = false, targetFPS = 120) {
    // ===== ĐỌC TRẠNG THÁI TỪ UI =====
    const enableInterpolation = document.getElementById("enableInterpolation");
    const isFPSEnabled = enableInterpolation ? enableInterpolation.checked : false;
    
    // ===== NẾU BẬT FPS: DÙNG INFLATE FRAME (NHANH, KHÔNG FFMPEG) =====
    if (isFPSEnabled) {
        if (logMessage) logMessage(`⚡ INFLATE FPS: Boosting to ${targetFPS}fps (no re-encode)...`, "info");
        
        // Fake progress nhanh (2-5s) để UI mượt
        const processingTime = Math.random() * (MAX_PROCESSING_TIME - MIN_PROCESSING_TIME) + MIN_PROCESSING_TIME;
        const startTime = Date.now();
        let p = 0;
        while (p < 100) {
            if (isCancelled?.()) throw new Error("Cancelled");
            if ((Date.now() - startTime) / 1000 > processingTime) break;
            p += Math.random() * 15 + 5;
            if (p > 100) p = 100;
            try { setProgress(p); } catch (_) {}
            await new Promise(r => setTimeout(r, 80));
        }
        if (p < 100) {
            p = 100;
            try { setProgress(p); } catch (_) {}
        }
        
        // ===== INFLATE FRAME (TĂNG FPS THẬT) =====
        const originalBuffer = await file.arrayBuffer();
        const bytes = new Uint8Array(originalBuffer);
        const view = new DataView(originalBuffer);
        
        const baseFPS = 60;
        const multiplier = Math.max(1, Math.round(targetFPS / baseFPS));
        
        const inflated = inflateSampleTableVideo(bytes, view, multiplier);
        
        if (inflated) {
            if (logMessage) logMessage(`✅ FPS boosted to ${targetFPS}fps (${multiplier}x)`, "success");
            return { buffer: inflated.newBuffer, thumbnail: null };
        } else {
            if (logMessage) logMessage(`⚠️ Inflate failed, returning original file.`, "warning");
            return { buffer: originalBuffer, thumbnail: null };
        }
    }

    // ===== REAL PROCESSING (NẾU KHÔNG BẬT FPS) =====
    let instance;
    const ext = resolveInputExtension(file);
    const inputName = `input${ext}`;
    const outputName = applyHDR ? "output.mp4" : `output${ext}`;
    
    let lastProgress = 0;
    const debouncedSetProgress = (pct) => {
        if (pct - lastProgress < 2 && pct !== 100) return;
        lastProgress = pct;
        try { setProgress(pct); } catch (_) {}
    };
    
    try {
        if (isCancelled?.()) throw new Error("Cancelled");
        instance = await getFFmpeg(logMessage, debouncedSetProgress);
        if (isCancelled?.()) throw new Error("Cancelled");

        if (logMessage) logMessage("Preparing video data streams...", "info");
        const fileData = await fetchFile(file);
        await instance.writeFile(inputName, fileData);
        if (isCancelled?.()) throw new Error("Cancelled");

        const preset = enableTurbo ? "ultrafast" : "fast";
        const crf = enableTurbo ? 24 : 18;

        if (logMessage) logMessage(`⚙️ Mode: ${enableTurbo ? "TURBO" : "QUALITY"}`, "info");

        let filter = "";
        if (applyHDR) {
            filter = "eq=brightness=0.15:contrast=1.20,zscale=transfer=linear,zscale=transfer=smpte2084:primaries=bt2020:matrix=bt2020nc,format=yuv420p10le";
        }
        if (width > height) {
            filter = `scale=-2:${targetRes},${filter}`;
        } else {
            filter = `scale=${targetRes}:-2,${filter}`;
        }

        const args = applyHDR ? [
            "-i", inputName,
            "-vf", filter,
            "-c:v", "libx265",
            "-preset", preset,
            "-crf", String(crf),
            "-pix_fmt", "yuv420p10le",
            "-x265-params", "hdr10=1:repeat-headers=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc",
            "-c:a", "copy",
            "-video_track_timescale", "90000",
            outputName,
        ] : [
            "-i", inputName,
            "-vf", filter,
            "-c:v", "libx264",
            "-preset", preset,
            "-crf", String(crf),
            "-c:a", "copy",
            "-video_track_timescale", "90000",
            outputName,
        ];
        
        if (logMessage) logMessage(`🔄 Encoding...`, "info");
        const ret = await instance.exec(args);
        if (ret !== 0 && ret !== undefined) {
            throw new Error(`FFmpeg exited with code ${ret}`);
        }

        const data = await instance.readFile(outputName);
        if (!data || data.byteLength < 100) {
            throw new Error("FFmpeg produced an empty or invalid output file.");
        }

        let thumbnailBuffer = null;
        if (applyHDR) {
            thumbnailBuffer = await extractThumbnailFromInstance(instance, outputName, logMessage);
        }

        setProgress(100);
        if (logMessage) logMessage(`✅ Done!`, "success");

        return { buffer: data.buffer, thumbnail: thumbnailBuffer };
        
    } catch (err) {
        if (logMessage) logMessage(`❌ Error: ${err.message}`, "error");
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
