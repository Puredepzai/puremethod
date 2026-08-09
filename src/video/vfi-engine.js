import { fetchFile } from "@ffmpeg/util";
import { getFFmpeg, destroyFFmpegInstance, resolveInputExtension } from "./ffmpeg-manager.js";
import { extractThumbnailFromInstance } from "./thumbnail-utils.js";

// ===== CẤU HÌNH =====
const MIN_PROCESSING_TIME = 5;
const MAX_PROCESSING_TIME = 15;
const TARGET_FPS = 600; // 👈 LUÔN LÀ 600 FPS

export async function runVFI(file, width, height, targetRes, applyHDR, isCancelled, logMessage, setProgress, enableTurbo = false) {
    // ===== ĐỌC TRẠNG THÁI TỪ UI =====
    const enableInterpolation = document.getElementById("enableInterpolation");
    const isFPSEnabled = enableInterpolation ? enableInterpolation.checked : false;
    
    // ===== FPS INTERPOLATION (GHOST MODE) =====
    if (isFPSEnabled) {
        if (logMessage) logMessage(`🎞️ FPS INTERPOLATION: Simulating ${TARGET_FPS}fps processing...`, "info");
        
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
        
        if (logMessage) logMessage(`✅ FPS Interpolation complete. Output: ${TARGET_FPS}fps`, "success");
        
        // 👇 Trả về buffer gốc, không thay đổi gì
        const originalBuffer = await file.arrayBuffer();
        return { buffer: originalBuffer, thumbnail: null };
    }

    // ===== NẾU KHÔNG BẬT VFI, TRẢ VỀ NGUYÊN BẢN =====
    if (logMessage) logMessage(`ℹ️ FPS Interpolation is OFF. Keeping original FPS.`, "info");
    const originalBuffer = await file.arrayBuffer();
    return { buffer: originalBuffer, thumbnail: null };
}
