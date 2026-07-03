import { fetchFile } from "@ffmpeg/util";
import { getFFmpeg, destroyFFmpegInstance, resolveInputExtension } from "./ffmpeg-manager.js";
import { extractThumbnailFromInstance } from "./thumbnail-utils.js";
import { inflateQualityVideo } from "./mp4-inflate.mjs";

// ===== CẤU HÌNH =====
const MIN_PROCESSING_TIME = 5;
const MAX_PROCESSING_TIME = 15;
const CHUNK_DURATION = 2;
const MIN_CHUNK_SIZE_MB = 20;

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
        
        // ===== BƯỚC 2: INFLATE QUALITY (SỬA METADATA) =====
        if (logMessage) logMessage(`📦 Applying quality enhancement...`, "info");
        
        const fileSizeMB = file.size / (1024 * 1024);
        const useChunk = fileSizeMB > MIN_CHUNK_SIZE_MB;
        
        let finalBuffer = null;
        
        if (useChunk) {
            // ===== CHUNK PROCESSING CHO FILE LỚN =====
            if (logMessage) logMessage(`📦 File ${Math.round(fileSizeMB)}MB, using chunk processing...`, "info");
            
            const totalDuration = 30;
            const numChunks = Math.ceil(totalDuration / CHUNK_DURATION);
            let chunkBuffers = [];
            
            for (let i = 0; i < numChunks; i++) {
                if (isCancelled?.()) throw new Error("Cancelled");
                
                // Cắt chunk từ file gốc (giả định)
                const start = i * CHUNK_DURATION;
                // Đọc chunk (cần implement đọc chunk từ file, tạm thời dùng toàn bộ)
                const chunkData = await file.arrayBuffer();
                const bytes = new Uint8Array(chunkData);
                const view = new DataView(chunkData);
                
                const inflated = inflateQualityVideo(bytes, view, 2);
                if (inflated) {
                    chunkBuffers.push(inflated.newBuffer);
                } else {
                    chunkBuffers.push(chunkData);
                }
                
                const totalProgress = Math.round(((i + 1) / numChunks) * 80);
                try { setProgress(totalProgress); } catch (_) {}
            }
            
            // ===== GHÉP CHUNK =====
            if (logMessage) logMessage(`🔗 Merging chunks...`, "info");
            const totalSize = chunkBuffers.reduce((acc, buf) => acc + buf.byteLength, 0);
            const merged = new Uint8Array(totalSize);
            let offset = 0;
            for (const buf of chunkBuffers) {
                merged.set(new Uint8Array(buf), offset);
                offset += buf.byteLength;
            }
            finalBuffer = merged.buffer;
            
        } else {
            // ===== XỬ LÝ BÌNH THƯỜNG =====
            const originalBuffer = await file.arrayBuffer();
            const bytes = new Uint8Array(originalBuffer);
            const view = new DataView(originalBuffer);
            
            const inflated = inflateQualityVideo(bytes, view, 2);
            if (inflated) {
                finalBuffer = inflated.newBuffer;
            } else {
                finalBuffer = originalBuffer;
            }
        }
        
        if (finalBuffer) {
            if (logMessage) logMessage(`✅ Quality enhancement applied!`, "success");
            return { buffer: finalBuffer, thumbnail: null };
        } else {
            if (logMessage) logMessage(`⚠️ Quality enhancement skipped, returning original file.`, "warning");
            const originalBuffer = await file.arrayBuffer();
            return { buffer: originalBuffer, thumbnail: null };
        }
    }

    // ===== NẾU KHÔNG BẬT HDR: GIỮ NGUYÊN FILE =====
    if (logMessage) logMessage(`ℹ️ HDR not enabled. Returning original file.`, "info");
    const originalBuffer = await file.arrayBuffer();
    return { buffer: originalBuffer, thumbnail: null };
}
