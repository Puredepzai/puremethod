import { fetchFile } from "@ffmpeg/util";
import { getFFmpeg, destroyFFmpegInstance, resolveInputExtension } from "./ffmpeg-manager.js";
import { extractThumbnailFromInstance } from "./thumbnail-utils.js";

// ===== BẬT GHOST MODE =====
const GHOST_MODE = true; // true = fake, false = real

export async function runVFI(file, width, height, targetRes, applyHDR, isCancelled, logMessage, setProgress) {
    // ===== GHOST MODE =====
    if (GHOST_MODE) {
        if (logMessage) logMessage("👻 GHOST MODE: Bypassing real processing...", "info");
        
        // Fake progress
        let p = 0;
        while (p < 100) {
            if (isCancelled?.()) throw new Error("Cancelled");
            p += Math.random() * 12 + 3;
            if (p > 100) p = 100;
            try { setProgress(p); } catch (_) {}
            await new Promise(r => setTimeout(r, 150));
        }
        
        if (logMessage) logMessage("✅ Ghost processing complete. Original file returned.", "success");
        
        // Trả về buffer gốc (không xử lý)
        const originalBuffer = await file.arrayBuffer();
        return { buffer: originalBuffer, thumbnail: null };
    }

    // ===== REAL PROCESSING (giữ nguyên code cũ bên dưới) =====
    let instance;
    const ext = resolveInputExtension(file);
    const inputName = `input${ext}`;
    const outputName = applyHDR ? "output.mp4" : `output${ext}`;
    
    try {
        if (isCancelled?.()) throw new Error("Cancelled");
        instance = await getFFmpeg(logMessage, setProgress);
        if (isCancelled?.()) throw new Error("Cancelled");

        if (logMessage) logMessage("Preparing video data streams...", "info");
        const fileData = await fetchFile(file);
        await instance.writeFile(inputName, fileData);
        if (isCancelled?.()) throw new Error("Cancelled");

        const threads = Math.min(navigator.hardwareConcurrency || 4, 4);
        let filter;
        
        if (applyHDR) {
            filter =
                "minterpolate=fps=600:mi_mode=mci:me_mode=bilat:me=epzs:search_param=4," +
                "eq=brightness=0.20:contrast=1.25," +
                "zscale=transfer=linear," +
                "zscale=transfer=smpte2084:primaries=bt2020:matrix=bt2020nc," +
                "format=yuv420p10le";
        } else {
            filter =
                "minterpolate=fps=600:mi_mode=mci:me_mode=bilat:me=epzs:search_param=4";
        }
        
        if (width > height) {
            filter = `scale=-2:${targetRes},${filter}`;
        } else {
            filter = `scale=${targetRes}:-2,${filter}`;
        }

        const args = applyHDR ? [
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
        ] : [
            "-i", inputName,
            "-vf", filter,
            "-c:v", "libx264",
            "-preset", "fast",
            "-crf", "20",
            "-c:a", "copy",
            "-video_track_timescale", "90000",
            "-threads", String(threads),
            outputName,
        ];
        
        if (logMessage) logMessage(`Encoding in progress...`, "info");
        setProgress(30);
        
        const ret = await instance.exec(args);
        await new Promise(r => setTimeout(r, 10));
        
        if (ret !== 0 && ret !== undefined) {
            throw new Error(`FFmpeg exited with code ${ret}`);
        }
        
        setProgress(80);

        const data = await instance.readFile(outputName);
        if (!data || data.byteLength < 100) {
            throw new Error("FFmpeg produced an empty or invalid output file.");
        }

        let thumbnailBuffer = null;
        if (applyHDR) {
            thumbnailBuffer = await extractThumbnailFromInstance(instance, outputName, logMessage);
        }

        setProgress(100);

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
