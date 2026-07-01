import { fetchFile } from "@ffmpeg/util";
import { getFFmpeg, destroyFFmpegInstance, resolveInputExtension } from "./ffmpeg-manager.js";
import { extractThumbnailFromInstance } from "./thumbnail-utils.js";

export async function runVFI(file, width, height, targetRes, applyHDR, isCancelled, logMessage, setProgress) {
    let instance;
    const ext = resolveInputExtension(file);
    const inputName = `input${ext}`;
    const outputName = applyHDR ? "output.mp4" : `output${ext}`;
    
    try {
        if (isCancelled?.()) throw new Error("Cancelled");
        instance = await getFFmpeg(logMessage, setProgress);
        if (isCancelled?.()) throw new Error("Cancelled");

        if (logMessage) logMessage("Preparing video data streams...", "info");
        const fileData = await fetchFile(file);
        await instance.writeFile(inputName, fileData);
        if (isCancelled?.()) throw new Error("Cancelled");

        // ===== BỎ mpdecimate, chỉ giữ minterpolate =====
        let filter;
        if (applyHDR) {
            filter =
                "minterpolate=fps=60:mi_mode=mci:me_mode=bilat:me=epzs:search_param=4," +
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
                "minterpolate=fps=60:mi_mode=mci:me_mode=bilat:me=epzs:search_param=4";
            if (width > height) {
                filter = `scale=-2:${targetRes},${filter}`;
            } else {
                filter = `scale=${targetRes}:-2,${filter}`;
            }
        }

        const threads = Math.min(navigator.hardwareConcurrency || 4, 4);
        
        // ===== CHUNK PROCESSING VỚI LOG CHI TIẾT =====
        const fileSizeMB = file.size / (1024 * 1024);
        const useChunk = fileSizeMB > 50;
        
        if (useChunk) {
            if (logMessage) logMessage(`Large file (${Math.round(fileSizeMB)}MB), using chunk processing...`, "info");
            
            const numChunks = Math.max(2, Math.min(Math.ceil(fileSizeMB / 25), 8));
            const chunkDuration = Math.max(2, Math.floor(30 / numChunks));
            
            let chunkFiles = [];
            let totalProgress = 0;
            
            for (let i = 0; i < numChunks; i++) {
                if (isCancelled?.()) throw new Error("Cancelled");
                
                const start = i * chunkDuration;
                const chunkInput = `chunk_${i}${ext}`;
                const chunkOutput = `chunk_out_${i}.mp4`;
                
                // Cắt chunk
                const cutArgs = ["-i", inputName, "-ss", String(start), "-t", String(chunkDuration), "-c", "copy", chunkInput];
                if (logMessage) logMessage(`Cutting chunk ${i+1}: ${cutArgs.join(' ')}`, "info");
                await instance.exec(cutArgs);
                
                // Xử lý chunk
                const processArgs = [
                    "-i", chunkInput,
                    "-vf", filter,
                    "-c:v", applyHDR ? "libx265" : "libx264",
                    "-preset", "fast",
                    "-crf", applyHDR ? "18" : "20",
                    "-c:a", "copy",
                    "-threads", String(threads),
                    "-max_muxing_queue_size", "2048",
                    chunkOutput
                ];
                
                if (logMessage) logMessage(`Processing chunk ${i+1}: ${processArgs.join(' ')}`, "info");
                
                let ret;
                try {
                    ret = await instance.exec(processArgs);
                } catch (execErr) {
                    if (logMessage) logMessage(`Chunk ${i} exec error: ${execErr.message}`, "error");
                    throw new Error(`Chunk ${i} exec failed: ${execErr.message}`);
                }
                
                if (ret !== 0 && ret !== undefined) {
                    if (logMessage) logMessage(`Chunk ${i} returned code ${ret}`, "error");
                    throw new Error(`Chunk ${i} failed with code ${ret}`);
                }
                
                chunkFiles.push(chunkOutput);
                totalProgress = Math.round(((i + 1) / numChunks) * 80);
                if (setProgress) try { setProgress(totalProgress); } catch (_) {}
                if (logMessage) logMessage(`Chunk ${i+1}/${numChunks} done`, "info");
                
                await instance.deleteFile(chunkInput).catch(() => {});
                if (window.gc) try { window.gc(); } catch (_) {}
            }
            
            // Ghép chunk
            if (logMessage) logMessage("Merging chunks...", "info");
            const concatList = chunkFiles.map(f => `file '${f}'`).join('\n');
            await instance.writeFile("concat.txt", concatList);
            await instance.exec(["-f", "concat", "-safe", "0", "-i", "concat.txt", "-c", "copy", outputName]);
            
            for (const f of chunkFiles) {
                await instance.deleteFile(f).catch(() => {});
            }
            await instance.deleteFile("concat.txt").catch(() => {});
            if (window.gc) try { window.gc(); } catch (_) {}
            
        } else {
            // ===== XỬ LÝ BÌNH THƯỜNG =====
            const args = applyHDR ? [
                "-i", inputName,
                "-vf", filter,
                "-c:v", "libx265",
                "-preset", "fast",
                "-crf", "18",
                "-maxrate", "20M",
                "-bufsize", "40M",
                "-pix_fmt", "yuv420p10le",
                "-x265-params", "hdr10=1:repeat-headers=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50):max-cll=1000,400",
                "-c:a", "copy",
                "-video_track_timescale", "90000",
                "-threads", String(threads),
                outputName,
            ] : [
                "-i", inputName,
                "-vf", filter,
                "-c:v", "libx264",
                "-preset", "fast",
                "-crf", "20",
                "-c:a", "copy",
                "-video_track_timescale", "90000",
                "-threads", String(threads),
                outputName,
            ];
            
            if (logMessage) logMessage(`Encoding: ${args.join(' ')}`, "info");
            const ret = await instance.exec(args);
            if (ret !== 0 && ret !== undefined) {
                throw new Error(`FFmpeg exited with code ${ret}`);
            }
        }

        const data = await instance.readFile(outputName);
        if (!data || data.byteLength < 100) {
            throw new Error("FFmpeg produced an empty or invalid output file.");
        }

        let thumbnailBuffer = null;
        if (applyHDR) {
            thumbnailBuffer = await extractThumbnailFromInstance(instance, outputName, logMessage);
        }

        if (setProgress) try { setProgress(100); } catch (_) {}

        return { buffer: data.buffer, thumbnail: thumbnailBuffer };
        
    } catch (err) {
        if (logMessage) try { logMessage(`VFI Error: ${err.message}`, "error"); } catch (_) {}
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
