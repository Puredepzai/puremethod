import { fetchFile } from "@ffmpeg/util";
import { getFFmpeg, destroyFFmpegInstance, resolveInputExtension } from "./ffmpeg-manager.js";
import { extractThumbnailFromInstance } from "./thumbnail-utils.js";
import { inflateQualityVideo } from "./mp4-inflate.mjs";

export async function runHDR(file, width, height, targetRes, isCancelled, logMessage, setProgress) {
    const enableHDRCheckbox = document.getElementById("enableHDR");
    const isHDR = enableHDRCheckbox ? enableHDRCheckbox.checked : false;
    
    if (!isHDR) {
        if (logMessage) logMessage(`ℹ️ HDR not enabled. Returning original file.`, "info");
        const originalBuffer = await file.arrayBuffer();
        return { buffer: originalBuffer, thumbnail: null };
    }

    if (logMessage) logMessage(`🎨 Applying HDR quality boost...`, "info");
    
    try {
        // ===== ĐỌC FILE =====
        const originalBuffer = await file.arrayBuffer();
        const bytes = new Uint8Array(originalBuffer);
        const view = new DataView(originalBuffer);
        
        // ===== UPDATE PROGRESS =====
        setProgress(30);
        await new Promise(r => setTimeout(r, 50));
        
        // ===== INFLATE QUALITY (NHANH) =====
        if (logMessage) logMessage(`📦 Enhancing video metadata...`, "info");
        const inflated = inflateQualityVideo(bytes, view, 2);
        
        setProgress(80);
        await new Promise(r => setTimeout(r, 50));
        
        if (inflated) {
            if (logMessage) logMessage(`✅ Quality enhancement applied!`, "success");
            setProgress(100);
            return { buffer: inflated.newBuffer, thumbnail: null };
        } else {
            if (logMessage) logMessage(`⚠️ Quality enhancement skipped, returning original file.`, "warning");
            setProgress(100);
            return { buffer: originalBuffer, thumbnail: null };
        }
        
    } catch (err) {
        if (logMessage) logMessage(`❌ HDR Error: ${err.message}`, "error");
        setProgress(0);
        throw err;
    }
}
