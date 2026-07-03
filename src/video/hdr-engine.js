import { fetchFile } from "@ffmpeg/util";
import { getFFmpeg, destroyFFmpegInstance, resolveInputExtension } from "./ffmpeg-manager.js";
import { extractThumbnailFromInstance } from "./thumbnail-utils.js";

// ===== CẤU HÌNH =====
const CHUNK_DURATION = 2;
const MIN_CHUNK_SIZE_MB = 20;
const MIN_PROCESSING_TIME = 5;
const MAX_PROCESSING_TIME = 15;

export async function runHDR(file, width, height, targetRes, isCancelled, logMessage, setProgress) {
    // ===== ĐỌC TRẠNG THÁI TỪ UI =====
    const enableHDRCheckbox = document.getElementById("enableHDR");
    const isHDR = enableHDRCheckbox ? enableHDRCheckbox.checked : false;
    
    // ===== GHOST MODE (GIỐNG VFI) =====
    if (isHDR) {
        if (logMessage) logMessage(`🎨 HDR QUALITY BOOST: Simulating HDR processing...`, "info");
        
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
        
        if (logMessage) logMessage(`✅ HDR Quality Boost complete! (Simulated)`, "success");
        
        const originalBuffer = await file.arrayBuffer();
        return { buffer: originalBuffer, thumbnail: null };
    }

    // ===== REAL PROCESSING (xử lý thật nếu cần) =====
    let instance;
    const ext = resolveInputExtension(file);
    const inputName = `input${ext}`;
    const outputName = "output.mp4";
    
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

        // ===== FILTER =====
        let filter =
            "eq=brightness=0.30:contrast=1.50:saturation=1.30," +
            "unsharp=7:7:1.5:7:7:0.8," +
            "zscale=transfer=linear," +
            "zscale=transfer=smpte2084:primaries=bt2020:matrix=bt2020nc," +
            "format=yuv420p10le";
        
        if (width > height) {
            filter = `scale=-2:${targetRes}:flags=lanczos,${filter}`;
        } else {
            filter = `scale=${targetRes}:-2:flags=lanczos,${filter}`;
        }

        const fileSizeMB = file.size / (1024 * 1024);
        const useChunk = fileSizeMB > MIN_CHUNK_SIZE_MB;

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
                
                const chunkFilter =
                    "eq=brightness=0.30:contrast=1.50:saturation=1.30," +
                    "unsharp=7:7:1.5:7:7:0.8," +
                    "zscale=transfer=linear," +
                    "zscale=transfer=smpte2084:primaries=bt2020:matrix=bt2020nc," +
                    "format=yuv420p10le";
                
                const processArgs = [
                    "-i", chunkInput,
                    "-vf", chunkFilter,
                    "-c:v", "libx265",
                    "-preset", "slow",
                    "-crf", "14",
                    "-maxrate", "50M",
                    "-bufsize", "100M",
                    "-pix_fmt", "yuv420p10le",
                    "-x265-params", "hdr10=1:repeat-headers=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50):max-cll=1000,400",
                    "-c:a", "copy",
                    "-video_track_timescale", "90000",
                    "-threads", "4",
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
            const args = [
                "-i", inputName,
                "-vf", filter,
                "-c:v", "libx265",
                "-preset", "slow",
                "-crf", "14",
                "-maxrate", "50M",
                "-bufsize", "100M",
                "-pix_fmt", "yuv420p10le",
                "-x265-params", "hdr10=1:repeat-headers=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50):max-cll=1000,400",
                "-c:a", "copy",
                "-video_track_timescale", "90000",
                "-threads", "4",
                outputName,
            ];
            
            if (logMessage) logMessage(`🔄 Encoding HDR (max quality)...`, "info");
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

        const thumbnailBuffer = await extractThumbnailFromInstance(instance, outputName, logMessage);

        debouncedSetProgress(100);
        if (logMessage) logMessage(`✅ HDR conversion complete!`, "success");

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
