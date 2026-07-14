import { getFFmpeg } from "./ffmpeg-manager.js";

/**
 * Trích xuất thumbnail từ file MOV
 * Dùng FFmpeg để lấy frame đầu tiên
 */
export async function extractMovThumbnail(file, logMessage, setProgress) {
    let instance = null;
    const inputName = "thumb_input.mov";
    const outputName = "thumb.jpg";
    
    try {
        instance = await getFFmpeg(logMessage, setProgress);
        
        // Đọc file và ghi vào FFmpeg
        const fileData = new Uint8Array(await file.arrayBuffer());
        await instance.writeFile(inputName, fileData);
        
        // Lấy frame tại 0.1s
        await instance.exec([
            "-i", inputName,
            "-ss", "0.1",
            "-vframes", "1",
            "-vf", "scale=120:-1",
            "-f", "mjpeg",
            "-q:v", "2",
            outputName
        ]);
        
        const data = await instance.readFile(outputName);
        
        // Cleanup
        await instance.deleteFile(inputName).catch(() => {});
        await instance.deleteFile(outputName).catch(() => {});
        
        if (data && data.length > 100) {
            return data.buffer;
        }
        return null;
        
    } catch (e) {
        if (logMessage) {
            logMessage(`MOV thumbnail extraction failed: ${e.message}`, "warning");
        }
        // Cleanup khi lỗi
        if (instance) {
            await instance.deleteFile(inputName).catch(() => {});
            await instance.deleteFile(outputName).catch(() => {});
        }
        return null;
    }
}

/**
 * Trích xuất thumbnail từ một file đã có trong instance
 * Dùng khi đã có file trong bộ nhớ FFmpeg
 */
export async function extractThumbnailFromInstance(instance, videoFilename, logMessage) {
    const outputName = "thumb_from_instance.jpg";
    
    try {
        await instance.exec([
            "-ss", "0.1",
            "-i", videoFilename,
            "-vframes", "1",
            "-vf", "scale=320:-2",
            "-f", "mjpeg",
            "-q:v", "2",
            outputName
        ]);
        
        const data = await instance.readFile(outputName);
        await instance.deleteFile(outputName).catch(() => {});
        
        if (data && data.length > 100) {
            return data.buffer;
        }
        return null;
        
    } catch (e) {
        if (logMessage) {
            logMessage(`Thumbnail capture failed: ${e.message}`, "warning");
        }
        await instance.deleteFile(outputName).catch(() => {});
        return null;
    }
}

/**
 * Tạo thumbnail từ file blob (dùng video element)
 * Không cần FFmpeg, nhanh hơn
 */
export async function captureThumbnailFromBlob(blob, maxDimension = 120) {
    return new Promise((resolve) => {
        const video = document.createElement("video");
        video.preload = "auto";
        video.muted = true;
        video.playsInline = true;
        let objectUrl = null;
        let settled = false;

        const cleanup = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            video.onloadeddata = null;
            video.onseeked = null;
            video.onerror = null;
            video.src = "";
            video.load();
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            resolve(result);
        };

        const timeoutId = setTimeout(() => cleanup(null), 5000);

        video.onloadeddata = () => {
            if (settled) return;
            video.currentTime = 0.1;
        };

        video.onseeked = () => {
            if (settled) return;
            const canvas = document.createElement("canvas");
            const ctx = canvas.getContext("2d");
            
            let width = video.videoWidth;
            let height = video.videoHeight;
            
            if (width === 0 || height === 0) {
                cleanup(null);
                return;
            }
            
            // Scale giữ tỉ lệ
            if (width > height) {
                if (width > maxDimension) {
                    height = Math.round((height * maxDimension) / width);
                    width = maxDimension;
                }
            } else {
                if (height > maxDimension) {
                    width = Math.round((width * maxDimension) / height);
                    height = maxDimension;
                }
            }

            canvas.width = width;
            canvas.height = height;
            ctx.drawImage(video, 0, 0, width, height);

            const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
            cleanup(dataUrl);
        };

        video.onerror = () => cleanup(null);
        objectUrl = URL.createObjectURL(blob);
        video.src = objectUrl;
    });
}
