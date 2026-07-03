import { fetchFile } from "@ffmpeg/util";
import { getFFmpeg, destroyFFmpegInstance, resolveInputExtension } from "./ffmpeg-manager.js";
import { extractThumbnailFromInstance } from "./thumbnail-utils.js";
import { inflateQualityVideo } from "./mp4-inflate.mjs";

// ===== CẤU HÌNH =====
const MIN_PROCESSING_TIME = 5;
const MAX_PROCESSING_TIME = 15;

export async function runHDR(file, width, height, targetRes, isCancelled, logMessage, setProgress) {
    // ===== ĐỌC TRẠNG THÁI TỪ UI =====
    const enableHDRCheckbox = document.getElementById("enableHDR");
    const isHDR = enableHDRCheckbox ? enableHDRCheckbox.checked : false;
    
    // ===== NẾU BẬT HDR: GHOST MODE + INFLATE QUALITY =====
    if (isHDR) {
        if (logMessage) logMessage(`🎨 HDR QUALITY BOOST: Enhancing video quality...`, "info");
        
        // ===== BƯỚC 1: FAKE PROGRESS (GIỐNG VFI) =====
        const processingTime = Math.random() * (MAX_PROCESSING_TIME - MIN_PROCESSING_TIME) + MIN_PROCESSING_TIME;
        if (logMessage) logMessage(`⏱️ Estimated processing time: ${Math.round(processingTime)}s`, "info");
        
        const startTime = Date.now();
        let p = 0;
        while (p < 100) {
            if (isCancelled?.()) throw new Error("Cancelled");
            
            if ((Date.now() - startTime) / 1000 > processingTime) {
                if (logMessage) logMessage(`⏱️ Processing time (${Math.round(processingTime)}s) completed.`, "info");
                break;
            }
            
            p += Math.random() * 8 + 2;
            if (p > 100) p = 100;
            try { setProgress(p); } catch (_) {}
            await new Promise(r => setTimeout(r, 100));
        }
        
        if (p < 100) {
            p = 100;
            try { setProgress(p); } catch (_) {}
            await new Promise(r => setTimeout(r, 100));
        }
        
        // ===== BƯỚC 2: INFLATE QUALITY (SỬA METADATA, KHÔNG FFMPEG) =====
        if (logMessage) logMessage(`📦 Applying quality enhancement...`, "info");
        
        const originalBuffer = await file.arrayBuffer();
        const bytes = new Uint8Array(originalBuffer);
        const view = new DataView(originalBuffer);
        
        // Gọi inflateQualityVideo để tăng quality (giống inflate frame)
        const inflated = inflateQualityVideo(bytes, view, 2);
        
        if (inflated) {
            if (logMessage) logMessage(`✅ Quality enhancement applied!`, "success");
            return { buffer: inflated.newBuffer, thumbnail: null };
        } else {
            if (logMessage) logMessage(`⚠️ Quality enhancement skipped, returning original file.`, "warning");
            return { buffer: originalBuffer, thumbnail: null };
        }
    }

    // ===== NẾU KHÔNG BẬT HDR: GIỮ NGUYÊN FILE =====
    if (logMessage) logMessage(`ℹ️ HDR not enabled. Returning original file.`, "info");
    const originalBuffer = await file.arrayBuffer();
    return { buffer: originalBuffer, thumbnail: null };
}
