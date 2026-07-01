import { fetchFile } from "@ffmpeg/util";
import { getFFmpeg, destroyFFmpegInstance, resolveInputExtension } from "./ffmpeg-manager.js";
import { extractThumbnailFromInstance } from "./thumbnail-utils.js";

// ===== CẤU HÌNH CHỐNG CRASH =====
const MAX_MEMORY_MB = 2048;
const CHUNK_DURATION = 3; // 3 giây mỗi chunk
const MIN_CHUNK_SIZE_MB = 30; // Chỉ chunk khi file > 30MB

export async function runVFI(file, width, height, targetRes, applyHDR, isCancelled, logMessage, setProgress, enableTurbo = false, targetFPS = 120) {
    let instance;
    const ext = resolveInputExtension(file);
    const inputName = `input${ext}`;
    const outputName = applyHDR ? "output.mp4" : `output${ext}`;
    
    try {
        if (isCancelled?.()) throw new Error("Cancelled");
        instance = await getFFmpeg(logMessage, setProgress);
        if (isCancelled?.()) throw new Error("Cancelled");

        try {
            await instance.setMemoryLimit(MAX_MEMORY_MB * 1024 * 1024);
        } catch (_) {}

        if (logMessage) logMessage("Preparing video data streams...", "info");
        const fileData = await fetchFile(file);
        await instance.writeFile(inputName, fileData);
        if (isCancelled?.()) throw new Error("Cancelled");

        // ===== CẤU HÌNH =====
        const preset = enableTurbo ? "veryfast" : "fast";
        const crf = enableTurbo ? 22 : 18;
        const searchParam = enableTurbo ? 2 : 4;
        const threads = Math.min(navigator.hardwareConcurrency || 4, enableTurbo ? 2 : 4);

        if (logMessage) logMessage(`⚙️ Mode: ${enableTurbo ? "TURBO" : "QUALITY"} | FPS: ${targetFPS}`, "info");

        // ===== FILTER (ĐƠN GIẢN HƠN, BỎ MP=EPZS) =====
        let filter;
        if (applyHDR) {
            filter =
                `minterpolate=fps=${targetFPS}:mi_mode=mci:me_mode=bilat:search_param=${searchParam},` +
                "eq=brightness=0.15:contrast=1.20," +
                "zscale=transfer=linear," +
                "zscale=transfer=smpte2084:primaries=bt2020:matrix=bt2020nc," +
                "format=yuv420p10le";
        } else {
            filter =
                `minterpolate=fps=${targetFPS}:mi_mode=mci:me_mode=bilat:search_param=${searchParam}`;
        }
        
        if (width > height) {
            filter = `scale=-2:${targetRes},${filter}`;
        } else {
            filter = `scale=${targetRes}:-2,${filter}`;
        }

        const fileSizeMB = file.size / (1024 * 1024);
        const useChunk = fileSizeMB > MIN_CHUNK_SIZE_MB;

        // ===== XỬ LÝ CHUNK =====
        if (useChunk) {
            if (logMessage) logMessage(`📦 File ${Math.round(fileSizeMB)}MB, using chunk processing (${CHUNK_DURATION}s chunks)...`, "info");
            
            // Ước tính số chunk
            const totalDuration = 30; // Giả định 30s, có thể lấy từ metadata nếu có
            const numChunks = Math.ceil(totalDuration / CHUNK_DURATION);
            let chunkFiles = [];
            let totalProgress = 0;
            
            for (let i = 0; i < numChunks; i++) {
                if (isCancelled?.()) throw new Error("Cancelled");
                
                const start = i * CHUNK_DURATION;
                const chunkInput = `chunk_${i}${ext}`;
                const chunkOutput = `chunk_out_${i}.mp4`;
                
                // Cắt chunk
                await instance.exec(["-i", inputName, "-ss", String(start), "-t", String(CHUNK_DURATION), "-c", "copy", chunkInput]);
                
                // Xử lý chunk với filter đơn giản hơn
                const chunkFilter = applyHDR ? 
                    `minterpolate=fps=${targetFPS}:mi_mode=mci:me_mode=bilat:search_param=2,eq=brightness=0.15:contrast=1.20,zscale=transfer=linear,zscale=transfer=smpte2084:primaries=bt2020:matrix=bt2020nc,format=yuv420p10le` :
                    `minterpolate=fps=${targetFPS}:mi_mode=mci:me_mode=bilat:search_param=2`;
                
                const processArgs = [
                    "-i", chunkInput,
                    "-vf", chunkFilter,
                    "-c:v", applyHDR ? "libx265" : "libx264",
                    "-preset", preset,
                    "-crf", String(crf),
                    "-c:a", "copy",
                    "-threads", String(threads),
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
                if (setProgress) setProgress(totalProgress);
                
                await instance.deleteFile(chunkInput).catch(() => {});
                if (window.gc) try { window.gc(); } catch (_) {}
            }
            
            // Ghép chunk
            if (logMessage) logMessage("🔗 Merging chunks...", "info");
            const concatList = chunkFiles.map(f => `file '${f}'`).join('\n');
            await instance.writeFile("concat.txt", concatList);
            await instance.exec(["-f", "concat", "-safe", "0", "-i", "concat.txt", "-c", "copy", outputName]);
            
            for (const f of chunkFiles) {
                await instance.deleteFile(f).catch(() => {});
            }
            await instance.deleteFile("concat.txt").catch(() => {});
            
        } else {
            // ===== XỬ LÝ BÌNH THƯỜNG (ĐƠN GIẢN HƠN) =====
            const args = applyHDR ? [
                "-i", inputName,
                "-vf", filter,
                "-c:v", "libx265",
                "-preset", preset,
                "-crf", String(crf),
                "-maxrate", enableTurbo ? "10M" : "15M",
                "-bufsize", enableTurbo ? "20M" : "30M",
                "-pix_fmt", "yuv420p10le",
                "-x265-params", "hdr10=1:repeat-headers=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc",
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
            
            if (logMessage) logMessage(`🔄 Encoding...`, "info");
            setProgress(30);
            const ret = await instance.exec(args);
            if (ret !== 0 && ret !== undefined) {
                throw new Error(`FFmpeg exited with code ${ret}`);
            }
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
