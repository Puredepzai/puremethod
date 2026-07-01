import { fetchFile } from "@ffmpeg/util";
import { getFFmpeg, destroyFFmpegInstance, resolveInputExtension } from "./ffmpeg-manager.js";
import { extractThumbnailFromInstance } from "./thumbnail-utils.js";

// ===== CẤU HÌNH =====
const MAX_THREADS = 4;
const CRF_VALUE = 18;
const PRESET = "slow";
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
        logMessage(`Using ${threads} thread(s) for processing`, "info");
        
        // ==== THỬ FILTER ĐƠN GIẢN (BỎ MINTERPOLATE) =====
        // Filter này chỉ scale và thay đổi brightness, không interpolate
        let filter;
        if (applyHDR) {
            filter =
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
            // Chỉ scale, không interpolate
            if (width > height) {
                filter = `scale=-2:${targetRes}`;
            } else {
                filter = `scale=${targetRes}:-2`;
            }
        }

        // ==== ARGS ====
        let args;
        if (applyHDR) {
            logMessage("Converting to HDR10 (HEVC 10-bit)... (NO interpolation)", "info");
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
            logMessage("Scaling video (NO interpolation)...", "info");
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

        logMessage("Encoding in progress (no interpolation)...", "info");
        
        let ret;
        try {
            ret = await instance.exec(args);
        } catch (execError) {
            logMessage(`FFmpeg exec error: ${execError.message}`, "error");
            try {
                const logData = await instance.readFile("ffmpeg.log").catch(() => null);
                if (logData) {
                    const logText = new TextDecoder().decode(logData);
                    logMessage(`FFmpeg log: ${logText.substring(0, 500)}`, "error");
                }
            } catch (_) {}
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
