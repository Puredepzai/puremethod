import { fetchFile } from "@ffmpeg/util";
import { getFFmpeg, destroyFFmpegInstance, resolveInputExtension } from "./ffmpeg-manager.js";
import { extractThumbnailFromInstance } from "./thumbnail-utils.js";

export async function runHDR(file, width, height, targetRes, isCancelled, logMessage, setProgress) {
    // ===== ĐỌC TRẠNG THÁI TỪ UI =====
    const enableHDRCheckbox = document.getElementById("enableHDR");
    const isHDR = enableHDRCheckbox ? enableHDRCheckbox.checked : false;
    
    // ===== NẾU BẬT HDR: TĂNG QUALITY BẰNG FFMPEG =====
    if (isHDR) {
        if (logMessage) logMessage(`🎨 Applying HDR quality boost...`, "info");
        
        let instance;
        const ext = resolveInputExtension(file);
        const inputName = `input${ext}`;
        const outputName = "output.mp4";
        
        try {
            if (isCancelled?.()) throw new Error("Cancelled");
            instance = await getFFmpeg(logMessage, setProgress);
            if (isCancelled?.()) throw new Error("Cancelled");

            try {
                await instance.setMemoryLimit(2048 * 1024 * 1024);
                if (logMessage) logMessage("🧠 Memory limit set to 2GB", "info");
            } catch (_) {
                if (logMessage) logMessage("⚠️ setMemoryLimit not supported", "warning");
            }

            if (logMessage) logMessage("Preparing video data streams...", "info");
            const fileData = await fetchFile(file);
            await instance.writeFile(inputName, fileData);
            if (isCancelled?.()) throw new Error("Cancelled");

            // ===== FILTER TĂNG QUALITY =====
            const filter =
                "eq=brightness=0.30:contrast=1.50:saturation=1.30," +
                "unsharp=7:7:1.5:7:7:0.8," +
                "zscale=transfer=linear," +
                "zscale=transfer=smpte2084:primaries=bt2020:matrix=bt2020nc," +
                "format=yuv420p10le";
            
            const scaleFilter = width > height 
                ? `scale=-2:${targetRes}:flags=lanczos,${filter}`
                : `scale=${targetRes}:-2:flags=lanczos,${filter}`;

            const args = [
                "-i", inputName,
                "-vf", scaleFilter,
                "-c:v", "libx265",
                "-preset", "slow",
                "-crf", "14",
                "-maxrate", "50M",
                "-bufsize", "100M",
                "-pix_fmt", "yuv420p10le",
                "-x265-params", "hdr10=1:repeat-headers=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50):max-cll=1000,400",
                "-c:a", "copy",
                "-video_track_timescale", "90000",
                "-threads", "4",
                outputName,
            ];
            
            if (logMessage) logMessage(`🔄 Encoding HDR (high quality)...`, "info");
            setProgress(30);
            await new Promise(r => setTimeout(r, 50));
            const ret = await instance.exec(args);
            if (ret !== 0 && ret !== undefined) {
                throw new Error(`FFmpeg exited with code ${ret}`);
            }

            setProgress(80);
            await new Promise(r => setTimeout(r, 50));
            
            const data = await instance.readFile(outputName);
            if (!data || data.byteLength < 100) {
                throw new Error("FFmpeg produced an empty or invalid output file.");
            }

            const thumbnailBuffer = await extractThumbnailFromInstance(instance, outputName, logMessage);

            setProgress(100);
            if (logMessage) logMessage(`✅ HDR quality boost complete!`, "success");

            return { buffer: data.buffer, thumbnail: thumbnailBuffer };
            
        } catch (err) {
            if (logMessage) logMessage(`❌ HDR Error: ${err.message}`, "error");
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

    // ===== NẾU KHÔNG BẬT HDR: GIỮ NGUYÊN FILE =====
    if (logMessage) logMessage(`ℹ️ HDR not enabled. Returning original file.`, "info");
    const originalBuffer = await file.arrayBuffer();
    return { buffer: originalBuffer, thumbnail: null };
}
