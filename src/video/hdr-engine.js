import { fetchFile } from "@ffmpeg/util";
import { getFFmpeg, destroyFFmpegInstance, resolveInputExtension } from "./ffmpeg-manager.js";
import { extractThumbnailFromInstance } from "./thumbnail-utils.js";

// ===== CẤU HÌNH CHỐNG OOM (cho video nặng) =====
const MAX_THREADS = 2;
const CHUNK_DURATION = 1.5;
const MIN_CHUNK_SIZE_MB = 15;
const GHOST_MODE = false; // Bật true nếu vẫn OOM

export async function runHDR(file, width, height, targetRes, isCancelled, logMessage, setProgress) {
    if (GHOST_MODE) {
        if (logMessage) logMessage("👻 GHOST MODE: Bypassing real HDR processing...", "info");
        let p = 0;
        while (p < 100) {
            if (isCancelled?.()) throw new Error("Cancelled");
            p += Math.random() * 12 + 3;
            if (p > 100) p = 100;
            try { setProgress(p); } catch (_) {}
            await new Promise(r => setTimeout(r, 150));
        }
        if (logMessage) logMessage("✅ Ghost processing complete.", "success");
        const originalBuffer = await file.arrayBuffer();
        return { buffer: originalBuffer, thumbnail: null };
    }

    let instance;
    const ext = resolveInputExtension(file);
    const inputName = `input${ext}`;
    const outputName = "output.mp4";
    
    let lastProgress = 0;
    const debouncedSetProgress = (pct) => {
        if (pct - lastProgress >= 2 || pct === 100) {
            lastProgress = pct;
            try { setProgress(pct); } catch (_) {}
            setTimeout(() => {}, 0);
        }
    };
    
    try {
        if (isCancelled?.()) throw new Error("Cancelled");
        instance = await getFFmpeg(logMessage, debouncedSetProgress);
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

        const threads = MAX_THREADS;
        if (logMessage) logMessage(`Using ${threads} thread(s) for HDR processing`, "info");

        let filter =
            "eq=brightness=0.18:contrast=1.20," +
            "zscale=transfer=linear," +
            "zscale=transfer=smpte2084:primaries=bt2020:matrix=bt2020nc," +
            "format=yuv420p10le";
        if (width > height) {
            filter = `scale=-2:${targetRes},${filter}`;
        } else {
            filter = `scale=${targetRes}:-2,${filter}`;
        }

        const fileSizeMB = file.size / (1024 * 1024);
        const useChunk = fileSizeMB > MIN_CHUNK_SIZE_MB;

        if (useChunk) {
            if (logMessage) logMessage(`📦 File ${Math.round(fileSizeMB)}MB, using chunk processing (${CHUNK_DURATION}s chunks)...`, "info");
            
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
                await new Promise(r => setTimeout(r, 10));
                
                const chunkFilter =
                    "eq=brightness=0.18:contrast=1.20," +
                    "zscale=transfer=linear," +
                    "zscale=transfer=smpte2084:primaries=bt2020:matrix=bt2020nc," +
                    "format=yuv420p10le";
                
                const processArgs = [
                    "-i", chunkInput,
                    "-vf", chunkFilter,
                    "-c:v", "libx265",
                    "-preset", "veryfast",
                    "-crf", "25",
                    "-maxrate", "10M",
                    "-bufsize", "20M",
                    "-pix_fmt", "yuv420p10le",
                    "-x265-params", "hdr10=1:repeat-headers=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50):max-cll=1000,400",
                    "-c:a", "copy",
                    "-video_track_timescale", "90000",
                    "-threads", String(threads),
                    chunkOutput
                ];
                
                if (logMessage) logMessage(`  Processing chunk ${i+1}/${numChunks}...`, "info");
                const ret = await instance.exec(processArgs);
                await new Promise(r => setTimeout(r, 10));
                
                if (ret !== 0 && ret !== undefined) {
                    throw new Error(`Chunk ${i} failed with code ${ret}`);
                }
                
                chunkFiles.push(chunkOutput);
                totalProgress = Math.round(((i + 1) / numChunks) * 80);
                debouncedSetProgress(totalProgress);
                if (logMessage) logMessage(`  Chunk ${i+1}/${numChunks} done`, "info");
                
                await instance.deleteFile(chunkInput).catch(() => {});
                if (window.gc) try { window.gc(); } catch (_) {}
            }
            
            if (logMessage) logMessage("🔗 Merging chunks...", "info");
            const concatList = chunkFiles.map(f => `file '${f}'`).join('\n');
            await instance.writeFile("concat.txt", concatList);
            await instance.exec(["-f", "concat", "-safe", "0", "-i", "concat.txt", "-c", "copy", outputName]);
            await new Promise(r => setTimeout(r, 10));
            
            for (const f of chunkFiles) {
                await instance.deleteFile(f).catch(() => {});
            }
            await instance.deleteFile("concat.txt").catch(() => {});
            
        } else {
            const args = [
                "-i", inputName,
                "-vf", filter,
                "-c:v", "libx265",
                "-preset", "veryfast",
                "-crf", "25",
                "-maxrate", "10M",
                "-bufsize", "20M",
                "-pix_fmt", "yuv420p10le",
                "-x265-params", "hdr10=1:repeat-headers=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50):max-cll=1000,400",
                "-c:a", "copy",
                "-video_track_timescale", "90000",
                "-threads", String(threads),
                outputName,
            ];
            
            if (logMessage) logMessage("🔄 Encoding HDR...", "info");
            debouncedSetProgress(30);
            await new Promise(r => setTimeout(r, 50));
            const ret = await instance.exec(args);
            if (ret !== 0 && ret !== undefined) {
                throw new Error(`FFmpeg exited with code ${ret}`);
            }
        }

        debouncedSetProgress(80);
        await new Promise(r => setTimeout(r, 10));
        
        const data = await instance.readFile(outputName);
        if (!data || data.byteLength < 100) {
            throw new Error("FFmpeg produced an empty or invalid output file.");
        }

        const thumbnailBuffer = await extractThumbnailFromInstance(instance, outputName, logMessage);

        debouncedSetProgress(100);
        if (logMessage) logMessage("✅ HDR conversion complete.", "success");

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
