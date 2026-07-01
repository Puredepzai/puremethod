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

        // ===== CHUNKING THÔNG MINH =====
        const fileSizeMB = file.size / (1024 * 1024);
        const useChunk = fileSizeMB > 50; // Tự động chunk nếu >50MB
        
        // Filter giữ nguyên NoBlur gốc
        let filter;
        if (applyHDR) {
            filter =
                "mpdecimate,minterpolate=fps=60:mi_mode=mci:me_mode=bilat:me=epzs:search_param=4," +
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
                "mpdecimate,minterpolate=fps=60:mi_mode=mci:me_mode=bilat:me=epzs:search_param=4";
            if (width > height) {
                filter = `scale=-2:${targetRes},${filter}`;
            } else {
                filter = `scale=${targetRes}:-2,${filter}`;
            }
        }

        const threads = Math.min(navigator.hardwareConcurrency || 4, 4);
        
        if (useChunk) {
            if (logMessage) logMessage(`Large file (${Math.round(fileSizeMB)}MB), using chunk processing...`, "info");
            
            // Tự động tính số chunk dựa trên file size
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
                await instance.exec(["-i", inputName, "-ss", String(start), "-t", String(chunkDuration), "-c", "copy", chunkInput]);
                
                // Xử lý chunk với quality cao
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
                
                let ret = await instance.exec(processArgs);
                if (ret !== 0 && ret !== undefined) {
                    throw new Error(`Chunk ${i} failed with code ${ret}`);
                }
                
                chunkFiles.push(chunkOutput);
                totalProgress = Math.round(((i + 1) / numChunks) * 80);
                if (setProgress) try { setProgress(totalProgress); } catch (_) {}
                if (logMessage) logMessage(`Chunk ${i+1}/${numChunks} done`, "info");
                
                // ===== GIẢI PHÓNG RAM NGAY =====
                await instance.deleteFile(chunkInput).catch(() => {});
                if (window.gc) try { window.gc(); } catch (_) {}
            }
            
            // Ghép chunk
            if (logMessage) logMessage("Merging chunks...", "info");
            const concatList = chunkFiles.map(f => `file '${f}'`).join('\n');
            await instance.writeFile("concat.txt", concatList);
            await instance.exec(["-f", "concat", "-safe", "0", "-i", "concat.txt", "-c", "copy", outputName]);
            
            // Dọn dẹp
            for (const f of chunkFiles) {
                await instance.deleteFile(f).catch(() => {});
            }
            await instance.deleteFile("concat.txt").catch(() => {});
            if (window.gc) try { window.gc(); } catch (_) {}
            
        } else {
            // ===== XỬ LÝ BÌNH THƯỜNG (GIỐNG NOBLUR GỐC) =====
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
            
            if (logMessage) logMessage("Encoding in progress...", "info");
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
