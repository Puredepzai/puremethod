import { fetchFile } from "@ffmpeg/util";[cite: 1]
import { getFFmpeg, destroyFFmpegInstance, resolveInputExtension } from "./ffmpeg-manager.js";[cite: 1]
import { extractThumbnailFromInstance } from "./thumbnail-utils.js";[cite: 1]

export async function runVFI(file, width, height, targetRes, applyHDR, isCancelled, logMessage, setProgress) {[cite: 1]
    let instance;[cite: 1]
    const ext = resolveInputExtension(file);[cite: 1]
    const inputName = `input${ext}`;[cite: 1]
    const outputName = applyHDR ? "output.mp4" : `output${ext}`;[cite: 1]
    try {
        if (isCancelled()) throw new Error("Cancelled");[cite: 1]
        instance = await getFFmpeg(logMessage, setProgress);[cite: 1]
        if (isCancelled()) throw new Error("Cancelled");[cite: 1]

        logMessage("Preparing video data streams...", "info");[cite: 1]
        
        // Tối ưu hóa RAM: Đọc dữ liệu file riêng biệt để giải phóng bộ nhớ sớm hơn
        let fileData = await fetchFile(file);
        await instance.writeFile(inputName, fileData);[cite: 1]
        fileData = null; // Xóa tham chiếu ngay lập tức để Garbage Collector thu hồi RAM
        
        if (isCancelled()) throw new Error("Cancelled");[cite: 1]

        // Ép về 1 thread để bảo vệ bộ nhớ RAM, tránh tình trạng chia luồng làm tăng vọt Peak Memory gây sập tab
        const threads = 1;
        
        let filter;[cite: 1]
        // Tối ưu hóa minterpolate: Chuyển sang me_mode=bidir và search_param=2 để giữ chất lượng MCI nhưng ngốn ít RAM nhất
        if (applyHDR) {[cite: 1]
            filter =
                "mpdecimate,minterpolate=fps=60:mi_mode=mci:me_mode=bidir:me=epzs:search_param=2," +
                "eq=brightness=0.20:contrast=1.25," +
                "zscale=transfer=linear," +
                "zscale=transfer=smpte2084:primaries=bt2020:matrix=bt2020nc," +
                "format=yuv420p10le";[cite: 1]
            if (width > height) {[cite: 1]
                filter = `scale=-2:${targetRes},${filter}`;[cite: 1]
            } else {
                filter = `scale=${targetRes}:-2,${filter}`;[cite: 1]
            }
        } else {
            filter =
                "mpdecimate,minterpolate=fps=60:mi_mode=mci:me_mode=bidir:me=epzs:search_param=2";
            if (width > height) {[cite: 1]
                filter = `scale=-2:${targetRes},${filter}`;[cite: 1]
            } else {
                filter = `scale=${targetRes}:-2,${filter}`;[cite: 1]
            }
        }

        let args;[cite: 1]
        if (applyHDR) {[cite: 1]
            logMessage("Interpolating to 60fps and converting to HDR10 (HEVC 10-bit)... This will take a few minutes.", "info");[cite: 1]
            args = [
                "-i", inputName,[cite: 1]
                "-vf", filter,[cite: 1]
                "-c:v", "libx265",[cite: 1]
                "-preset", "fast",[cite: 1]
                "-crf", "18",[cite: 1]
                "-maxrate", "20M",[cite: 1]
                "-bufsize", "40M",[cite: 1]
                "-pix_fmt", "yuv420p10le",[cite: 1]
                "-x265-params", "hdr10=1:repeat-headers=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50):max-cll=1000,400",[cite: 1]
                "-c:a", "copy",[cite: 1]
                "-video_track_timescale", "90000",[cite: 1]
                "-threads", String(threads),[cite: 1]
                outputName,[cite: 1]
            ];
        } else {
            logMessage("Interpolating video frames to 60fps (H.264)... This may take a bit longer.", "info");[cite: 1]
            args = [
                "-i", inputName,[cite: 1]
                "-vf", filter,[cite: 1]
                "-c:v", "libx264",[cite: 1]
                "-preset", "fast",[cite: 1]
                "-crf", "20",[cite: 1]
                "-c:a", "copy",[cite: 1]
                "-video_track_timescale", "90000",[cite: 1]
                "-threads", String(threads),[cite: 1]
                outputName,[cite: 1]
            ];
        }

        logMessage("Encoding in progress, please wait...", "info");[cite: 1]
        const ret = await instance.exec(args);[cite: 1]
        if (ret !== 0 && ret !== undefined) {[cite: 1]
            throw new Error(`FFmpeg exited with code ${ret}`);[cite: 1]
        }
        logMessage("Encoding complete.", "success");[cite: 1]

        const data = await instance.readFile(outputName);[cite: 1]
        if (!data || data.byteLength < 100) {[cite: 1]
            throw new Error("FFmpeg produced an empty or invalid output file.");[cite: 1]
        }

        let thumbnailBuffer = null;[cite: 1]
        if (applyHDR) {[cite: 1]
            // HEVC needs FFmpeg helper for thumbnail
            thumbnailBuffer = await extractThumbnailFromInstance(instance, outputName, logMessage);[cite: 1]
        }

        return { buffer: data.buffer, thumbnail: thumbnailBuffer };[cite: 1]
    } catch (err) {
        await destroyFFmpegInstance();[cite: 1]
        throw err;[cite: 1]
    } finally {
        if (instance) {
            await instance.deleteFile(inputName).catch(() => {});[cite: 1]
            await instance.deleteFile(outputName).catch(() => {});[cite: 1]
        }
    }
}
