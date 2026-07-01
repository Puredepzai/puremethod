import { fetchFile } from "@ffmpeg/util";
import { getFFmpeg, destroyFFmpegInstance, resolveInputExtension } from "./ffmpeg-manager.js";
import { extractThumbnailFromInstance } from "./thumbnail-utils.js";

// ===== CẤU HÌNH =====
const MAX_THREADS = 4;
const CRF_VALUE = 18;
const PRESET = "slow";
const CHUNK_DURATION = 8;
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
        
        // Đọc file và ghi vào FFmpeg
        const fileData = await fetchFile(file);
        await instance.writeFile(inputName, fileData);
        
        // ===== GIẢI PHÓNG RAM NGAY =====
        if (fileData) {
            try {
                // Xóa tham chiếu để GC thu hồi
                if (fileData.buffer) {
                    // Nếu là ArrayBuffer, clear
                    try { fileData.buffer = null; } catch (_) {}
                }
                // Đặt null để GC làm việc
                fileData = null;
            } catch (_) {}
        }
        // Force garbage collection (nếu trình duyệt hỗ trợ)
        if (window.gc) {
            try { window.gc(); } catch (_) {}
        }
        // =================================
        
        if (isCancelled?.()) throw new Error("Cancelled");

        const threads = MAX_THREADS;
        logMessage(`Using ${threads} thread(s) for processing`, "info");
        
        // ==== FILTER ====
        let filter;
        if (applyHDR) {
            filter =
                "mpdecimate,minterpolate=fps=60:mi_mode=mci:me_mode=bidir:me=epzs:search_param=4," +
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
                "mpdecimate,minterpolate=fps=60:mi_mode=mci:me_mode=bidir:me=epzs:search_param=4";
            if (width > height) {
                filter = `scale=-2:${targetRes},${filter}`;
            } else {
                filter = `scale=${targetRes}:-2,${filter}`;
            }
        }

        // ==== ARGS ====
        let args;
        if (applyHDR) {
            logMessage("Interpolating to 60fps and converting to HDR10 (HEVC 10-bit)... Quality: HIGH", "info");
            args = [
                "-i", inputName,
                "-vf", filter,
                "-c:v", "libx265",
                "-preset", PRESET,
                "-crf", String(CRF_VALUE),
                "-maxrate", "30M",
                "-bufsize", "60M",
                "-pix_fmt", "yuv420p10le",
                "-x265-params", "hdr10=1:repeat-headers=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50):max-cll=1000,400",
                "-c:a", "copy",
                "-video_track_timescale", "90000",
                "-threads", String(threads),
                "-max_muxing_queue_size", "2048",
                outputName,
            ];
        } else {
            logMessage("Interpolating video frames to 60fps (H.264)... Quality: HIGH", "info");
            args = [
                "-i", inputName,
                "-vf", filter,
                "-c:v", "libx264",
                "-preset", PRESET,
                "-crf", String(CRF_VALUE),
                "-c:a", "copy",
                "-video_track_timescale", "90000",
                "-threads", String(threads),
                "-max_muxing_queue_size", "2048",
                outputName,
            ];
        }

        logMessage("Encoding in progress (high quality, may take a while)...", "info");
        
        let ret;
        try {
            ret = await instance.exec(args);
        } catch (execError) {
            logMessage(`FFmpeg exec error: ${execError.message}`, "error");
            throw new Error(`FFmpeg exec failed: ${execError.message}`);
        }
        
        if (ret !== 0 && ret !== undefined) {
            try {
                const logData = await instance.readFile("ffmpeg.log").catch(() => null);
                if (logData) {
                    const logText = new TextDecoder().decode(logData);
                    logMessage(`FFmpeg log: ${logText.substring(0, 500)}`, "error");
                }
            } catch (_) {}
            throw new Error(`FFmpeg exited with code ${ret}`);
        }
        logMessage("Encoding complete.", "success");

        // ===== ĐỌC FILE OUTPUT VÀ GIẢI PHÓNG =====
        const data = await instance.readFile(outputName);
        if (!data || data.byteLength < 100) {
            throw new Error("FFmpeg produced an empty or invalid output file.");
        }

        let thumbnailBuffer = null;
        if (applyHDR) {
            thumbnailBuffer = await extractThumbnailFromInstance(instance, outputName, logMessage);
        }

        // ===== DỌN DẸP FILE TRONG FFMPEG =====
        await instance.deleteFile(inputName).catch(() => {});
        await instance.deleteFile(outputName).catch(() => {});
        
        // ===== GIẢI PHÓNG THAM CHIẾU =====
        if (data) {
            try {
                // Giữ buffer để return, nhưng xóa tham chiếu khác
                const resultBuffer = data.buffer;
                data = null;
                return { buffer: resultBuffer, thumbnail: thumbnailBuffer };
            } catch (_) {
                return { buffer: data.buffer, thumbnail: thumbnailBuffer };
            }
        }
        // =================================

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
        // ===== FORCE GC =====
        if (window.gc) {
            try { window.gc(); } catch (_) {}
        }
        // ====================
    }
}
