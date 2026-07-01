import { fetchFile } from "@ffmpeg/util";
import { getFFmpeg, destroyFFmpegInstance, resolveInputExtension } from "./ffmpeg-manager.js";
import { extractThumbnailFromInstance } from "./thumbnail-utils.js";

// ===== GIỚI HẠN TÀI NGUYÊN =====
const MAX_THREADS = 2; // Chỉ dùng 2 luồng để tránh crash
const MEMORY_LIMIT_MB = 512; // Giới hạn RAM 512MB
// ===============================

export async function runVFI(file, width, height, targetRes, applyHDR, isCancelled, logMessage, setProgress) {
    let instance;
    const ext = resolveInputExtension(file);
    const inputName = `input${ext}`;
    const outputName = applyHDR ? "output.mp4" : `output${ext}`;
    try {
        if (isCancelled()) throw new Error("Cancelled");
        instance = await getFFmpeg(logMessage, setProgress);
        if (isCancelled()) throw new Error("Cancelled");

        logMessage("Preparing video data streams...", "info");
        await instance.writeFile(inputName, await fetchFile(file));
        if (isCancelled()) throw new Error("Cancelled");

        // ===== GIỚI HẠN THREAD =====
        const threads = MAX_THREADS;
        logMessage(`Using ${threads} thread(s) for processing`, "info");
        
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

        let args;
        if (applyHDR) {
            logMessage("Interpolating to 60fps and converting to HDR10 (HEVC 10-bit)... This will take a few minutes.", "info");
            args = [
                "-i", inputName,
                "-vf", filter,
                "-c:v", "libx265",
                "-preset", "veryfast", // Từ fast sang veryfast để giảm CPU
                "-crf", "22", // Tăng lên 22 để giảm dung lượng (quality giảm nhẹ)
                "-maxrate", "20M",
                "-bufsize", "40M",
                "-pix_fmt", "yuv420p10le",
                "-x265-params", "hdr10=1:repeat-headers=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50):max-cll=1000,400",
                "-c:a", "copy",
                "-video_track_timescale", "90000",
                "-threads", String(threads),
                "-memory_limit", String(MEMORY_LIMIT_MB * 1024 * 1024), // Giới hạn RAM
                outputName,
            ];
        } else {
            logMessage("Interpolating video frames to 60fps (H.264)... This may take a bit longer.", "info");
            args = [
                "-i", inputName,
                "-vf", filter,
                "-c:v", "libx264",
                "-preset", "veryfast", // Từ fast sang veryfast
                "-crf", "22", // Từ 20 lên 22
                "-c:a", "copy",
                "-video_track_timescale", "90000",
                "-threads", String(threads),
                "-memory_limit", String(MEMORY_LIMIT_MB * 1024 * 1024),
                outputName,
            ];
        }

        logMessage("Encoding in progress, please wait...", "info");
        const ret = await instance.exec(args);
        if (ret !== 0 && ret !== undefined) {
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

        return { buffer: data.buffer, thumbnail: thumbnailBuffer };
    } catch (err) {
        await destroyFFmpegInstance();
        throw err;
    } finally {
        if (instance) {
            await instance.deleteFile(inputName).catch(() => {});
            await instance.deleteFile(outputName).catch(() => {});
        }
    }
}
