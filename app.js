// ===== patchSingleFile SỬA LẠI (BỎ GHOST MODE LOOP) =====
async function patchSingleFile(item) {
    const enableInterpolation = document.getElementById("enableInterpolation");
    const enableHDR = document.getElementById("enableHDR");
    const resolutionEl = document.getElementById("outputResolution");
    const targetRes = resolutionEl
        ? Number.parseInt(resolutionEl.value, 10)
        : 1080;

    const enableTurbo = false;
    const targetFPS = parseInt(document.getElementById("targetFPS")?.value || "120");

    let sourceBuffer = null;
    let movThumbnailBuffer = null;

    let lastProgress = 0;
    const debouncedSetProgress = (pct) => {
        if (pct - lastProgress >= 2 || pct === 100) {
            lastProgress = pct;
            setProgress(pct);
            setTimeout(() => {}, 0);
        }
    };

    if (isMovFile(item.file) && !enableInterpolation?.checked && !enableHDR?.checked) {
        logMessage("Processing MOV file directly...", "info");
        logMessage("Extracting thumbnail from MOV...", "info");
        movThumbnailBuffer = await extractMovThumbnail(item.file, logMessage, debouncedSetProgress);
        if (isCancelled) throw new Error("Cancelled");
    }

    // ===== VFI (tăng FPS) - CHỈ CHẠY KHI BẬT INTERPOLATION =====
    if (enableInterpolation?.checked) {
        logMessage("Starting VFI Engine...", "info");
        if (isCancelled) throw new Error("Cancelled");

        const fileBytes = new Uint8Array(await item.file.arrayBuffer());
        const fileView = new DataView(fileBytes.buffer);
        const dims = getDimensionsFromMp4Container(fileBytes, fileView);
        if (!dims) {
            throw new Error("Could not parse video dimensions.");
        }

        const applyHDR = enableHDR?.checked;
        
        const vfiResult = await runVFI(
            item.file,
            dims.width,
            dims.height,
            targetRes,
            applyHDR,
            () => isCancelled,
            logMessage,
            debouncedSetProgress,
            enableTurbo,
            targetFPS
        );
        sourceBuffer = vfiResult.buffer;
        if (vfiResult.thumbnail) {
            movThumbnailBuffer = vfiResult.thumbnail;
        }
        logMessage(applyHDR ? "60fps HDR processing complete." : "VFI processing complete.", "success");
    } 
    // ===== HDR (tăng quality) - CHỈ CHẠY KHI BẬT HDR MÀ KHÔNG BẬT INTERPOLATION =====
    else if (enableHDR?.checked) {
        logMessage("🎨 Starting HDR Quality Boost...", "info");
        if (isCancelled) throw new Error("Cancelled");
        
        const fileBytes = new Uint8Array(await item.file.arrayBuffer());
        const fileView = new DataView(fileBytes.buffer);
        
        // ===== INFLATE QUALITY (KHÔNG LOOP, KHÔNG BLOCK UI) =====
        logMessage("  Enhancing video quality metadata...", "info");
        const inflated = inflateQualityVideo(fileBytes, fileView, 2);
        
        if (inflated) {
            sourceBuffer = inflated.newBuffer;
            logMessage("  ✅ Quality enhancement applied!", "success");
            debouncedSetProgress(100);
        } else {
            logMessage("  ⚠️ Quality enhancement skipped, using original file.", "warning");
            debouncedSetProgress(100);
        }
    }

    if (isCancelled) throw new Error("Cancelled");

    await destroyFFmpegInstance();

    let videoInfo = null;
    if (!sourceBuffer) {
        videoInfo = await getVideoDurationAndResolution(item.file);
        if (isCancelled) throw new Error("Cancelled");
        if (!videoInfo && !isMovFile(item.file)) {
            throw new Error("Could not parse video metadata.");
        }
    }

    const mimeType = getMimeType(item.file);
    const outputName = getOutputFilename(item.file);

    let inputBytes;
    let inputView;

    if (sourceBuffer) {
        inputBytes = new Uint8Array(sourceBuffer);
        inputView = new DataView(sourceBuffer);
        logMessage(
            `  Source: ${enableInterpolation?.checked ? "VFI 60fps" : "HDR10"} output`,
            "info",
        );
    } else {
        inputBytes = new Uint8Array(await item.file.arrayBuffer());
        inputView = new DataView(inputBytes.buffer);
        if (videoInfo) {
            logMessage(
                `  Source: ${videoInfo.width}x${videoInfo.height}`,
                "info",
            );
        } else {
            logMessage("  Source: MOV file", "info");
        }
    }

    logMessage("  Normalizing container...", "info");
    const normalized = normalizeContainer(inputBytes, inputView);
    let finalBuffer = normalized.newBuffer;
    let finalBytes = normalized.newBytes;
    let finalView = normalized.newView;

    if (normalized.changed) {
        logMessage("  Container normalized.", "success");
    } else {
        logMessage("  Container already normalized.", "info");
    }

    // ===== INFLATE FPS (nếu bật VFI) =====
    if (enableInterpolation?.checked) {
        const targetFPSForInflate = parseInt(document.getElementById("targetFPS")?.value || "120");
        const baseFPS = 60;
        const multiplier = Math.max(1, Math.round(targetFPSForInflate / baseFPS));
        const inflateResult = inflateSampleTableVideo(finalBytes, finalView, multiplier);
        if (inflateResult) {
            finalBuffer = inflateResult.newBuffer;
            finalBytes = inflateResult.newBytes;
            finalView = new DataView(finalBuffer);
            logMessage(`  Frame Density Inflation: Applied (${targetFPSForInflate}fps).`, "success");
        } else {
            logMessage("  Frame Density Inflation skipped.", "warning");
        }
    }

    return {
        finalBuffer,
        outputName,
        mimeType,
        prePatchBuffer: sourceBuffer,
        movThumbnailBuffer,
    };
}
