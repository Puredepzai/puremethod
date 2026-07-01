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

        let filter =
            "eq=brightness=0.20:contrast=1.25," +
            "zscale=transfer=linear," +
            "zscale=transfer=smpte2084:primaries=bt2020:matrix=bt2020nc," +
            "format=yuv420p10le";
        if (width > height) {
            filter = `scale=-2:${targetRes},${filter}`;
        } else {
            filter = `scale=${targetRes}:-2,${filter}`;
        }

        logMessage("Converting SDR to HDR10 (HEVC 10-bit)... This may take a few minutes.", "info");

        const args = [
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
        ];

        logMessage("Encoding in progress, please wait...", "info");
        const ret = await instance.exec(args);
        if (ret !== 0 && ret !== undefined) {
            throw new Error(`FFmpeg exited with code ${ret}`);
        }
        logMessage("Encoding complete.", "success");

        const thumbnailBuffer = await extractThumbnailFromInstance(instance, outputName, logMessage);
        const data = await instance.readFile(outputName);
        if (!data || data.byteLength < 100) {
            throw new Error("FFmpeg produced an empty or invalid output file.");
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
