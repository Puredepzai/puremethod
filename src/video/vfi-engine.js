import { fetchFile } from "@ffmpeg/util";
import { getFFmpeg, destroyFFmpegInstance, resolveInputExtension } from "./ffmpeg-manager.js";
import { extractThumbnailFromInstance } from "./thumbnail-utils.js";

// ===== CẤU HÌNH =====
const MAX_THREADS = 2;
const CRF_VALUE = 18;
const PRESET = "slow";
const CHUNK_DURATION = 5;
// ====================

export async function runVFI(file, width, height, targetRes, applyHDR, isCancelled, logMessage, setProgress) {
    let instance;
    const ext = resolveInputExtension(file);
    const inputName = `input${ext}`;
    const outputName = applyHDR ? "output.mp4" : `output${ext}`;
    
    try {
        if (isCancelled?.()) throw new Error("Cancelled");
        instance = await getFFmpeg(logMessage, setProgress);
        if (isCancelled?.()) throw new Error("Cancelled");

        logMessage("Preparing video data streams...", "info");
        const fileData = await fetchFile(file);
        await instance.writeFile(inputName, fileData);
        if (isCancelled?.()) throw new Error("Cancelled");

        const threads = MAX_THREADS;
        logMessage(`Using ${threads} thread(s) for chunk processing`, "info");
        
        // ===== FILTER 600FPS =====
        let filter;
        if (applyHDR) {
            filter =
                "minterpolate=fps=600:mi_mode=mci:me_mode=bidir:me=epzs:search_param=4," +
                "eq=brightness=0.20:contrast=1.25," +
                "zscale=transfer=linear," +
                "zscale=transfer=smpte2084:primaries=bt2020:matrix=bt2020nc," +
                "format=yuv420p10le";
            if (width > height) {
                filter = `scale=-2:${targetRes},${filter}`;
            } else {
                filter = `scale=${targetRes}:-2,${filter}`;
            }
        } else {
            filter =
                "minterpolate=fps=600:mi_mode=mci:me_mode=bidir:me=epzs:search_param=4";
            if (width > height) {
                filter = `scale=-2:${targetRes},${filter}`;
            } else {
                filter = `scale=${targetRes}:-2,${filter}`;
            }
        }

        // ===== CHUNK PROCESSING =====
        const fileSizeMB = file.size / (1024 * 1024);
        const numChunks = fileSizeMB > 200 ? 6 : (fileSizeMB > 100 ? 4 : 1);
        const chunkDuration = Math.max(3, Math.floor(60 / numChunks));
        
        logMessage(`File size: ${Math.round(fileSizeMB)}MB, splitting into ${numChunks} chunks`, "info");
        
        let chunkFiles = [];
        
        for (let i = 0; i < numChunks; i++) {
            if (isCancelled?.()) throw new Error("Cancelled");
            
            const start = i * chunkDuration;
            const chunkInput = `chunk_${i}${ext}`;
            const chunkOutput = `chunk_out_${i}.mp4`;
            
            // Cắt chunk
            const cutArgs = [
                "-i", inputName,
                "-ss", String(start),
                "-t", String(chunkDuration),
                "-c", "copy",
                chunkInput
            ];
            await instance.exec(cutArgs);
            
            // Xử lý chunk với 600FPS
            const processArgs = [
                "-i", chunkInput,
                "-vf", filter,
                "-c:v", applyHDR ? "libx265" : "libx264",
                "-preset", PRESET,
                "-crf", String(CRF_VALUE),
                "-c:a", "copy",
                "-threads", String(threads),
                "-max_muxing_queue_size", "2048",
                chunkOutput
            ];
            
            let ret = await instance.exec(processArgs);
            if (ret !== 0 && ret !== undefined) {
                throw new Error(`Chunk ${i} failed with code ${ret}`);
            }
            
            chunkFiles.push(chunkOutput);
            logMessage(`Chunk ${i+1}/${numChunks} processed (600FPS)`, "info");
            
            await instance.deleteFile(chunkInput).catch(() => {});
        }
        
        // Ghép các chunk
        if (chunkFiles.length > 1) {
            logMessage("Merging chunks...", "info");
            const concatList = chunkFiles.map(f => `file '${f}'`).join('\n');
            await instance.writeFile("concat.txt", concatList);
            
            const mergeArgs = [
                "-f", "concat",
                "-safe", "0",
                "-i", "concat.txt",
                "-c", "copy",
                outputName
            ];
            await instance.exec(mergeArgs);
        } else if (chunkFiles.length === 1) {
            await instance.exec(["-i", chunkFiles[0], "-c", "copy", outputName]);
        }
        
        // Dọn dẹp
        for (const f of chunkFiles) {
            await instance.deleteFile(f).catch(() => {});
        }
        await instance.deleteFile("concat.txt").catch(() => {});

        logMessage("600FPS encoding complete.", "success");

        const data = await instance.readFile(outputName);
        if (!data || data.byteLength < 100) {
            throw new Error("FFmpeg produced an empty or invalid output file.");
        }

        let thumbnailBuffer = null;
        if (applyHDR) {
            thumbnailBuffer = await extractThumbnailFromInstance(instance, outputName, logMessage);
        }

        await instance.deleteFile(inputName).catch(() => {});
        await instance.deleteFile(outputName).catch(() => {});

        return { buffer: data.buffer, thumbnail: thumbnailBuffer };
        
    } catch (err) {
        logMessage(`VFI Error: ${err.message}`, "error");
        await destroyFFmpegInstance();
        throw err;
    } finally {
        if (instance) {
            await instance.deleteFile(inputName).catch(() => {});
            await instance.deleteFile(outputName).catch(() => {});
        }
        if (window.gc) {
            try { window.gc(); } catch (_) {}
        }
    }
}
