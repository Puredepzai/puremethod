import { fetchFile } from "@ffmpeg/util";
import { getFFmpeg, destroyFFmpegInstance, resolveInputExtension } from "./ffmpeg-manager.js";
import { extractThumbnailFromInstance } from "./thumbnail-utils.js";

export async function runVFI(file, width, height, targetRes, isCancelled, logMessage, setProgress) {
    let instance;
    const ext = resolveInputExtension(file);
    const inputName = `input${ext}`;
    const outputName = `output${ext}`;
    try {
        if (isCancelled()) throw new Error("Cancelled");
        instance = await getFFmpeg(logMessage, setProgress);
        if (isCancelled()) throw new Error("Cancelled");

        logMessage("Preparing video data streams...", "info");
        await instance.writeFile(inputName, await fetchFile(file));
        if (isCancelled()) throw new Error("Cancelled");

        const threads = Math.min(navigator.hardwareConcurrency || 4, 8);
        
        let filter =
            "mpdecimate,minterpolate=fps=60:mi_mode=mci:me_mode=bilat:me=epzs:search_param=4";
        if (width > height) {
            filter = `scale=-2:${targetRes},${filter}`;
        } else {
            filter = `scale=${targetRes}:-2,${filter}`;
        }

        logMessage("Interpolating video frames to 60fps (HEVC)... This may take a minute.", "info");

        const args = [
            "-i", inputName,
            "-vf", filter,
            "-c:v", "libx265",
            "-preset", "ultrafast",
            "-crf", "20",
            "-pix_fmt", "yuv420p",
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
