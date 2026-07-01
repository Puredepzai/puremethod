import { fetchFile } from "@ffmpeg/util";
import { getFFmpeg, destroyFFmpegInstance, resolveInputExtension } from "./ffmpeg-manager.js";
import { extractThumbnailFromInstance } from "./thumbnail-utils.js";

// ===== GIỚI HẠN TÀI NGUYÊN CỰC THẤP =====
const MAX_THREADS = 1;
const CRF_VALUE = 23;
const PRESET = "ultrafast";
// ========================================

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
        
        if (isCancelled?.()) throw new Error("Cancelled");

        const threads = MAX_THREADS;
        logMessage(`Using ${threads} thread(s) for processing`, "info");
        
        // Filter
        let filter;
        if (applyHDR) {
            filter =
                "mpdecimate,minterpolate=fps=60:mi_mode=mci:me_mode=bidir:me=epzs:search_param=2," +
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
                "mpdecimate,minterpolate=fps=60:mi_mode=mci:me_mode=bidir:me=epzs:search_param=2";
            if (width > height) {
                filter = `scale=-2:${targetRes},${filter}`;
            } else {
                filter = `scale=${targetRes}:-2,${filter}`;
            }
        }

        // Args
        let args;
        if (applyHDR) {
            logMessage("Interpolating to 60fps and converting to HDR10 (HEVC 10-bit)...", "info");
            args = [
                "-i", inputName,
                "-vf", filter,
                "-c:v", "libx265",
                "-preset", PRESET,
                "-crf", String(CRF_VALUE),
                "-maxrate", "20M",
                "-bufsize", "40M",
                "-pix_fmt", "yuv420p10le",
                "-x265-params", "hdr10=1:repeat-headers=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50):max-cll=1000,400",
                "-c:a", "copy",
                "-video_track_timescale", "90000",
                "-threads", String(threads),
                "-max_muxing_queue_size", "1024",
                outputName,
            ];
        } else {
            logMessage("Interpolating video frames to 60fps (H.264)...", "info");
            args = [
                "-i", inputName,
                "-vf", filter,
                "-c:v", "libx264",
                "-preset", PRESET,
                "-crf", String(CRF_VALUE),
                "-c:a", "copy",
                "-video_track_timescale", "90000",
                "-threads", String(threads),
                "-max_muxing_queue_size", "1024",
                outputName,
            ];
        }

        logMessage("Encoding in progress (this may take a while)...", "info");
        
        // Bắt lỗi exec
        let ret;
        try {
            ret = await instance.exec(args);
        } catch (execError) {
            logMessage(`FFmpeg execution error: ${execError.message}`, "error");
            throw new Error(`FFmpeg exec failed: ${execError.message}`);
        }
        
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

        // Dọn dẹp
        await instance.deleteFile(inputName).catch(() => {});
        await instance.deleteFile(outputName).catch(() => {});

        return { buffer: data.buffer, thumbnail: thumbnailBuffer };
        
    } catch (err) {
        // Log lỗi trước khi ném ra
        logMessage(`VFI Error: ${err.message}`, "error");
        await destroyFFmpegInstance();
        throw err; // Ném ra để app.js bắt và xử lý UI
    } finally {
        if (instance) {
            await instance.deleteFile(inputName).catch(() => {});
            await instance.deleteFile(outputName).catch(() => {});
        }
    }
}
