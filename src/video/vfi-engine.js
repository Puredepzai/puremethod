// ===== FILE: src/video-processor.js (hoặc vfi-engine.js) =====
import { fetchFile } from "@ffmpeg/util";
import { getFFmpeg, destroyFFmpegInstance, resolveInputExtension } from "./ffmpeg-manager.js";
import { extractThumbnailFromInstance } from "./thumbnail-utils.js";

// ===== CẤU HÌNH CHẤT LƯỢNG CAO =====
const GHOST_MODE = false;          // true = fake processing, false = real processing
const CRF = 15;                   // 15-18: gần lossless
const PRESET = "medium";          // "medium" là cân bằng tốt nhất (ko cần "slower")
const MAXRATE = "20M";            // Đủ cho 1440p 60fps
const BUFSIZE = "40M";
const CHUNK_DURATION = 5;         // 5 giây mỗi chunk (2s quá ngắn, gây lag)
const CHUNK_THRESHOLD_MB = 100;   // Chỉ chunk khi file > 100MB

// ===== HÀM CHÍNH =====
export async function runVFI(file, width, height, targetRes, applyHDR, isCancelled, logMessage, setProgress) {
    let instance;
    const ext = resolveInputExtension(file);
    const inputName = `input${ext}`;
    const outputName = applyHDR ? "output.mp4" : `output${ext}`;
    
    try {
        if (isCancelled?.()) throw new Error("Cancelled");
        
        // ===== GHOST MODE =====
        if (GHOST_MODE) {
            if (logMessage) logMessage("🔮 GHOST MODE: Bypassing actual VFI processing...", "info");
            let progress = 0;
            while (progress < 100) {
                if (isCancelled?.()) throw new Error("Cancelled");
                progress += Math.random() * 10 + 5;
                if (progress > 100) progress = 100;
                if (setProgress) try { setProgress(progress); } catch (_) {}
                await new Promise(r => setTimeout(r, 200));
            }
            const fakeBuffer = await file.arrayBuffer();
            return { buffer: fakeBuffer, thumbnail: null };
        }

        // ===== REAL PROCESSING =====
        instance = await getFFmpeg(logMessage, setProgress);
        if (isCancelled?.()) throw new Error("Cancelled");

        if (logMessage) logMessage("Preparing video data streams...", "info");
        const fileData = await fetchFile(file);
        await instance.writeFile(inputName, fileData);
        fileData = null; // giải phóng bộ nhớ
        if (isCancelled?.()) throw new Error("Cancelled");

        // ===== FILTER TỐI ƯU =====
        let filter;
        if (applyHDR) {
            filter =
                "minterpolate=fps=60:mi_mode=mci:me_mode=bidir:search_param=4," +
                "eq=brightness=0.15:contrast=1.20:saturation=1.05," +
                "zscale=transfer=linear," +
                "zscale=transfer=smpte2084:primaries=bt2020:matrix=bt2020nc," +
                "format=yuv420p10le";
        } else {
            filter =
                "minterpolate=fps=60:mi_mode=mci:me_mode=bidir:search_param=4," +
                "eq=brightness=0.05:contrast=1.15:saturation=1.0," +
                "format=yuv420p";
        }
        
        // Scale (giữ tỉ lệ)
        if (width > height) {
            filter = `scale=-2:${targetRes}:flags=lanczos,${filter}`;
        } else {
            filter = `scale=${targetRes}:-2:flags=lanczos,${filter}`;
        }

        const threads = Math.min(navigator.hardwareConcurrency || 4, 4);
        const fileSizeMB = file.size / (1024 * 1024);
        const useChunk = fileSizeMB > CHUNK_THRESHOLD_MB;

        // ===== XỬ LÝ CHUNK =====
        if (useChunk) {
            if (logMessage) logMessage(`Large file (${Math.round(fileSizeMB)}MB), using chunk processing...`, "info");
            
            // Ước tính số chunk dựa trên duration (giả định 30s nếu ko có metadata)
            const totalDuration = 30; // Có thể lấy từ metadata nếu có
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
                
                // Xử lý chunk
                const processArgs = [
                    "-i", chunkInput,
                    "-vf", filter,
                    "-c:v", applyHDR ? "libx265" : "libx264",
                    "-preset", PRESET,
                    "-crf", String(CRF),
                    "-c:a", "copy",
                    "-threads", String(threads),
                    "-max_muxing_queue_size", "1024",
                    chunkOutput
                ];
                
                if (logMessage) logMessage(`Processing chunk ${i+1}/${numChunks}...`, "info");
                const ret = await instance.exec(processArgs);
                if (ret !== 0 && ret !== undefined) {
                    throw new Error(`Chunk ${i} failed with code ${ret}`);
                }
                
                chunkFiles.push(chunkOutput);
                totalProgress = Math.round(((i + 1) / numChunks) * 80);
                if (setProgress) try { setProgress(totalProgress); } catch (_) {}
                
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
            // ===== XỬ LÝ KHÔNG CHUNK =====
            const args = applyHDR ? [
                "-i", inputName,
                "-vf", filter,
                "-c:v", "libx265",
                "-preset", PRESET,
                "-crf", String(CRF),
                "-maxrate", MAXRATE,
                "-bufsize", BUFSIZE,
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
                "-preset", PRESET,
                "-crf", String(CRF),
                "-maxrate", MAXRATE,
                "-bufsize", BUFSIZE,
                "-c:a", "copy",
                "-video_track_timescale", "90000",
                "-threads", String(threads),
                outputName,
            ];
            
            if (logMessage) logMessage(`Encoding with CRF ${CRF}, preset ${PRESET}...`, "info");
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

// ===== EXPORT THÊM CÁC HÀM KHÁC =====
export async function runHDR(...args) {
    // Nếu mày có hàm HDR riêng, giữ nguyên hoặc gọi lại runVFI với applyHDR=true
    return runVFI(...args.slice(0, 5), true, ...args.slice(5));
}

export { extractMovThumbnail, destroyFFmpegInstance, resolveInputExtension } from "./ffmpeg-manager.js";
