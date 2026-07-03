import { fetchFile } from "@ffmpeg/util";
import { getFFmpeg, destroyFFmpegInstance, resolveInputExtension } from "./ffmpeg-manager.js";
import { extractThumbnailFromInstance } from "./thumbnail-utils.js";

export async function runHDR(file, width, height, targetRes, isCancelled, logMessage, setProgress) {
    const enableHDRCheckbox = document.getElementById("enableHDR");
    const isHDR = enableHDRCheckbox ? enableHDRCheckbox.checked : false;
    
    if (!isHDR) {
        if (logMessage) logMessage(`ℹ️ HDR not enabled. Returning original file.`, "info");
        const originalBuffer = await file.arrayBuffer();
        return { buffer: originalBuffer, thumbnail: null };
    }

    if (logMessage) logMessage(`🎨 Applying HDR quality boost...`, "info");
    
    let instance;
    const ext = resolveInputExtension(file);
    const inputName = `input${ext}`;
    const outputName = "output.mp4";
    
    try {
        if (isCancelled?.()) throw new Error("Cancelled");
        instance = await getFFmpeg(logMessage, setProgress);
        if (isCancelled?.()) throw new Error("Cancelled");

        try {
            await instance.setMemoryLimit(2048 * 1024 * 1024);
            if (logMessage) logMessage("🧠 Memory limit set to 2GB", "info");
        } catch (_) {
            if (logMessage) logMessage("⚠️ setMemoryLimit not supported", "warning");
        }

        if (logMessage) logMessage("Preparing video data streams...", "info");
        const fileData = await fetchFile(file);
        await instance.writeFile(inputName, fileData);
        if (isCancelled?.()) throw new Error("Cancelled");

        // ===== FILTER TĂNG QUALITY (NHANH HƠN) =====
        let filter =
            "eq=brightness=0.15:contrast=1.20:saturation=1.15," +
            "unsharp=5:5:1.0:5:5:0.5";
        
        if (width > height) {
            filter = `scale=-2:${targetRes}:flags=lanczos,${filter}`;
        } else {
            filter = `scale=${targetRes}:-2:flags=lanczos,${filter}`;
        }

        // ===== CẤU HÌNH NHANH HƠN =====
        const args = [
            "-i", inputName,
            "-vf", filter,
            "-c:v", "libx264",
            "-preset", "medium", // medium nhanh hơn slow
            "-crf", "18",        // 18 thay vì 15
            "-maxrate", "20M",   // 20M thay vì 30M
            "-bufsize", "40M",
            "-c:a", "copy",
            "-video_track_timescale", "90000",
            "-threads", "4",
            outputName,
        ];
        
        if (logMessage) logMessage(`🔄 Encoding HDR (medium quality)...`, "info");
        setProgress(30);
        await new Promise(r => setTimeout(r, 50));
        
        const ret = await instance.exec(args);
        if (ret !== 0 && ret !== undefined) {
            throw new Error(`FFmpeg exited with code ${ret}`);
        }

        setProgress(80);
        await new Promise(r => setTimeout(r, 50));
        
        const data = await instance.readFile(outputName);
        if (!data || data.byteLength < 100) {
            throw new Error("FFmpeg produced an empty or invalid output file.");
        }

        const thumbnailBuffer = await extractThumbnailFromInstance(instance, outputName, logMessage);

        setProgress(100);
        if (logMessage) logMessage(`✅ HDR quality boost complete! (medium)`, "success");

        return { buffer: data.buffer, thumbnail: thumbnailBuffer };
        
    } catch (err) {
        if (logMessage) logMessage(`❌ HDR Error: ${err.message}`, "error");
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
