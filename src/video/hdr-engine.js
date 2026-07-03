import { fetchFile } from "@ffmpeg/util";
import { getFFmpeg, destroyFFmpegInstance, resolveInputExtension } from "./ffmpeg-manager.js";
import { extractThumbnailFromInstance } from "./thumbnail-utils.js";

export async function runHDR(file, width, height, targetRes, isCancelled, logMessage, setProgress) {
    let instance;
    const ext = resolveInputExtension(file);
    const inputName = `input${ext}`;
    const outputName = "output.mp4";
    try {
        if (isCancelled()) throw new Error("Cancelled");
        instance = await getFFmpeg(logMessage, setProgress);
        if (isCancelled()) throw new Error("Cancelled");

        await instance.writeFile(inputName, await fetchFile(file));
        if (isCancelled()) throw new Error("Cancelled");

        const threads = Math.min(navigator.hardwareConcurrency || 4, 8);

        // ===== NÂNG CẤP QUALITY GẤP ĐÔI =====
        // Tăng cường độ tương phản, độ sáng và độ bão hòa
        // Thêm unsharp mask để làm nét hơn
        let filter =
            "eq=brightness=0.25:contrast=1.35:saturation=1.15," +
            "unsharp=5:5:1.0:5:5:0.5," + // Làm nét (sharpening)
            "zscale=transfer=linear," +
            "zscale=transfer=smpte2084:primaries=bt2020:matrix=bt2020nc," +
            "format=yuv420p10le";
        if (width > height) {
            filter = `scale=-2:${targetRes},${filter}`;
        } else {
            filter = `scale=${targetRes}:-2,${filter}`;
        }

        logMessage("Converting SDR to HDR10 (HEVC 10-bit) with enhanced quality...", "info");

        const args = [
            "-i", inputName,
            "-vf", filter,
            "-c:v", "libx265",
            "-preset", "slow", // Từ fast lên slow để quality tốt hơn (chậm hơn nhưng đẹp hơn)
            "-crf", "15", // Giảm từ 18 xuống 15 để quality cao hơn
            "-maxrate", "30M", // Tăng bitrate từ 20M lên 30M
            "-bufsize", "60M", // Tăng buffer từ 40M lên 60M
            "-pix_fmt", "yuv420p10le",
            "-x265-params", "hdr10=1:repeat-headers=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50):max-cll=1000,400",
            "-c:a", "copy",
            "-video_track_timescale", "90000",
            "-threads", String(threads),
            outputName,
        ];

        logMessage("Encoding in progress (high quality mode, may take longer)...", "info");
        const ret = await instance.exec(args);
        if (ret !== 0 && ret !== undefined) {
            throw new Error(`FFmpeg exited with code ${ret}`);
        }
        logMessage("Encoding complete.", "success");

        const data = await instance.readFile(outputName);
        if (!data || data.byteLength < 100) {
            throw new Error("FFmpeg produced an empty or invalid output file.");
        }

        const thumbnailBuffer = await extractThumbnailFromInstance(instance, outputName, logMessage);

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
