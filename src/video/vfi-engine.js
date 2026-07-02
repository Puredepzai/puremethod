import { fetchFile } from "@ffmpeg/util";
import { getFFmpeg, destroyFFmpegInstance, resolveInputExtension } from "./ffmpeg-manager.js";
import { extractThumbnailFromInstance } from "./thumbnail-utils.js";

// ===== BẬT GHOST MODE =====
const GHOST_MODE = true; // true = fake, false = real

// ===== CẤU HÌNH =====
const CHUNK_DURATION = 2;
const MIN_CHUNK_SIZE_MB = 20;

export async function runVFI(file, width, height, targetRes, applyHDR, isCancelled, logMessage, setProgress, enableTurbo = false, targetFPS = 120) {
    // ===== GHOST MODE =====
    if (GHOST_MODE) {
        if (logMessage) logMessage("👻 GHOST MODE: Bypassing real processing...", "info");
        
        // Fake progress
        let p = 0;
        while (p < 100) {
            if (isCancelled?.()) throw new Error("Cancelled");
            p += Math.random() * 12 + 3;
            if (p > 100) p = 100;
            try { setProgress(p); } catch (_) {}
            await new Promise(r => setTimeout(r, 150));
        }
        
        if (logMessage) logMessage("✅ Ghost processing complete. Original file returned.", "success");
        
        // Trả về buffer gốc (không xử lý)
        const originalBuffer = await file.arrayBuffer();
        return { buffer: originalBuffer, thumbnail: null };
    }

    // ===== REAL PROCESSING (giữ nguyên code cũ bên dưới) =====
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

        // Tăng memory limit nếu hỗ trợ
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

        const preset = enableTurbo ? "ultrafast" : "fast";
        const crf = enableTurbo ? 24 : 18;

        if (logMessage) logMessage(`⚙️ Mode: ${enableTurbo ? "TURBO" : "QUALITY"} | FPS: ${targetFPS}`, "info");

        // ===== FILTER =====
        let filter;
        if (applyHDR) {
            filter =
                `fps=${targetFPS},` +
                "eq=brightness=0.15:contrast=1.20," +
                "zscale=transfer=linear," +
                "zscale=transfer=smpte2084:primaries=bt2020:matrix=bt2020nc," +
                "format=yuv420p10le";
        } else {
            filter = `fps=${targetFPS}`;
        }
        
        if (width > height) {
            filter = `scale=-2:${targetRes},${filter}`;
        } else {
            filter = `scale=${targetRes}:-2,${filter}`;
        }

        const fileSizeMB = file.size / (1024 * 1024);
        const useChunk = fileSizeMB > MIN_CHUNK_SIZE_MB;

        // ===== CHUNK PROCESSING =====
        if (useChunk) {
            if (logMessage) logMessage(`📦 File ${Math.round(fileSizeMB)}MB, using chunk processing...`, "info");
            
            const totalDuration = 30;
            const numChunks = Math.ceil(totalDuration / CHUNK_DURATION);
            let chunkFiles = [];
            let totalProgress = 0;
            
            for (let i = 0; i < numChunks; i++) {
                if (isCancelled?.()) throw new Error("Cancelled");
                
                const start = i * CHUNK_DURATION;
                const chunkInput = `chunk_${i}${ext}`;
                const chunkOutput = `chunk_out_${i}.mp4`;
                
                await instance.exec(["-i", inputName, "-ss", String(start), "-t", String(CHUNK_DURATION), "-c", "copy", chunkInput]);
                
                const chunkFilter = applyHDR ? 
                    `fps=${targetFPS},eq=brightness=0.15:contrast=1.20,zscale=transfer=linear,zscale=transfer=smpte2084:primaries=bt2020:matrix=bt2020nc,format=yuv420p10le` :
                    `fps=${targetFPS}`;
                
                const processArgs = [
                    "-i", chunkInput,
                    "-vf", chunkFilter,
                    "-c:v", applyHDR ? "libx265" : "libx264",
                    "-preset", preset,
                    "-crf", String(crf),
                    "-c:a", "copy",
                    "-max_muxing_queue_size", "1024",
                    chunkOutput
                ];
                
                if (logMessage) logMessage(`  Processing chunk ${i+1}/${numChunks}...`, "info");
                const ret = await instance.exec(processArgs);
                if (ret !== 0 && ret !== undefined) {
                    throw new Error(`Chunk ${i} failed with code ${ret}`);
                }
                
                chunkFiles.push(chunkOutput);
                totalProgress = Math.round(((i + 1) / numChunks) * 80);
                debouncedSetProgress(totalProgress);
                
                await instance.deleteFile(chunkInput).catch(() => {});
                if (window.gc) try { window.gc(); } catch (_) {}
            }
            
            if (logMessage) logMessage("🔗 Merging chunks...", "info");
            const concatList = chunkFiles.map(f => `file '${f}'`).join('\n');
            await instance.writeFile("concat.txt", concatList);
            await instance.exec(["-f", "concat", "-safe", "0", "-i", "concat.txt", "-c", "copy", outputName]);
            
            for (const f of chunkFiles) {
                await instance.deleteFile(f).catch(() => {});
            }
            await instance.deleteFile("concat.txt").catch(() => {});
            
        } else {
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
            
            if (logMessage) logMessage(`🔄 Encoding to ${targetFPS}fps...`, "info");
            debouncedSetProgress(30);
            await new Promise(r => setTimeout(r, 50));
            const ret = await instance.exec(args);
            if (ret !== 0 && ret !== undefined) {
                throw new Error(`FFmpeg exited with code ${ret}`);
            }
        }

        debouncedSetProgress(80);
        await new Promise(r => setTimeout(r, 50));
        
        const data = await instance.readFile(outputName);
        if (!data || data.byteLength < 100) {
            throw new Error("FFmpeg produced an empty or invalid output file.");
        }

        let thumbnailBuffer = null;
        if (applyHDR) {
            thumbnailBuffer = await extractThumbnailFromInstance(instance, outputName, logMessage);
        }

        debouncedSetProgress(100);
        if (logMessage) logMessage(`✅ Done! ${targetFPS}fps`, "success");

        return { buffer: data.buffer, thumbnail: thumbnailBuffer };
        
    } catch (err) {
        if (logMessage) logMessage(`❌ VFI Error: ${err.message}`, "error");
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
