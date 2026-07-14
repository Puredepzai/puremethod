import {
    getBoxHeaderSize,
    parseBoxes,
    updateBoxSize,
    updateChunkOffsets,
} from "./mp4-boxes.mjs";

import { getFFmpeg, destroyFFmpegInstance } from "./video/ffmpeg-manager.js";

// ============================================================
// PHẦN 1: CÁC HÀM XỬ LÝ MP4 BOX (GIỮ NGUYÊN, KHÔNG SỬA)
// ============================================================

const DUMMY_SIZES = {
    avc1: 8, avc3: 8, hvc1: 16, hev1: 16, vp09: 4, av01: 4, mp4v: 8,
};
const DEFAULT_DUMMY_SIZE = 8;

function findVideoStbl(bytes, view, moovBox) {
    const moovChildren = parseBoxes(bytes, view, moovBox.offset + getBoxHeaderSize(moovBox), moovBox.end);
    for (const trak of moovChildren.filter(b => b.type === "trak")) {
        const trakChildren = parseBoxes(bytes, view, trak.offset + getBoxHeaderSize(trak), trak.end);
        const mdiaBox = trakChildren.find(b => b.type === "mdia");
        if (!mdiaBox) continue;
        const mdiaChildren = parseBoxes(bytes, view, mdiaBox.offset + getBoxHeaderSize(mdiaBox), mdiaBox.end);
        const hdlrBox = mdiaChildren.find(b => b.type === "hdlr");
        if (!hdlrBox) continue;
        const handlerType = String.fromCharCode(
            bytes[hdlrBox.offset + 16], bytes[hdlrBox.offset + 17],
            bytes[hdlrBox.offset + 18], bytes[hdlrBox.offset + 19]
        );
        if (handlerType !== "vide") continue;
        const minfBox = mdiaChildren.find(b => b.type === "minf");
        if (!minfBox) continue;
        const minfChildren = parseBoxes(bytes, view, minfBox.offset + getBoxHeaderSize(minfBox), minfBox.end);
        const stblBox = minfChildren.find(b => b.type === "stbl");
        if (!stblBox) continue;
        return { trak, mdiaBox, minfBox, stblBox };
    }
    return null;
}

function buildSttsAtom(realCount, sampleDelta, multiplier) {
    const fakeCount = realCount * (multiplier - 1);
    const atomSize = 16 + 2 * 8;
    const buffer = new ArrayBuffer(atomSize);
    const b = new Uint8Array(buffer);
    const v = new DataView(buffer);
    v.setUint32(0, atomSize, false);
    b[4] = 0x73; b[5] = 0x74; b[6] = 0x74; b[7] = 0x73;
    v.setUint32(8, 0, false);
    v.setUint32(12, 2, false);
    v.setUint32(16, realCount, false);
    v.setUint32(20, sampleDelta, false);
    v.setUint32(24, fakeCount, false);
    v.setUint32(28, sampleDelta, false);
    return b;
}

function buildStszAtom(inputBytes, inputView, stszBox, realCount, multiplier, dummySize) {
    const totalCount = realCount * multiplier;
    const atomSize = 20 + totalCount * 4;
    const buffer = new ArrayBuffer(atomSize);
    const b = new Uint8Array(buffer);
    const v = new DataView(buffer);
    v.setUint32(0, atomSize, false);
    b[4] = 0x73; b[5] = 0x74; b[6] = 0x73; b[7] = 0x7a;
    v.setUint32(8, 0, false);
    v.setUint32(12, 0, false);
    v.setUint32(16, totalCount, false);
    const srcBase = stszBox.offset + 20;
    for (let i = 0; i < realCount; i++) {
        v.setUint32(20 + i * 4, inputView.getUint32(srcBase + i * 4, false), false);
    }
    for (let i = realCount; i < totalCount; i++) {
        v.setUint32(20 + i * 4, dummySize, false);
    }
    return b;
}

function buildStcoAtom(inputView, stcoBox, origCount, realCount, safeOffset, offsetDelta, multiplier) {
    const fakeCount = realCount * (multiplier - 1);
    const newCount = origCount + fakeCount;
    const atomSize = 16 + newCount * 4;
    const buffer = new ArrayBuffer(atomSize);
    const b = new Uint8Array(buffer);
    const v = new DataView(buffer);
    v.setUint32(0, atomSize, false);
    b[4] = 0x73; b[5] = 0x74; b[6] = 0x63; b[7] = 0x6f;
    v.setUint32(8, 0, false);
    v.setUint32(12, newCount, false);
    const srcBase = stcoBox.offset + 16;
    for (let i = 0; i < origCount; i++) {
        v.setUint32(16 + i * 4, inputView.getUint32(srcBase + i * 4, false) + offsetDelta, false);
    }
    for (let i = 0; i < fakeCount; i++) {
        v.setUint32(16 + (origCount + i) * 4, safeOffset, false);
    }
    return b;
}

function buildCo64Atom(inputView, co64Box, origCount, realCount, safeOffset, offsetDelta, multiplier) {
    const fakeCount = realCount * (multiplier - 1);
    const newCount = origCount + fakeCount;
    const atomSize = 16 + newCount * 8;
    const buffer = new ArrayBuffer(atomSize);
    const b = new Uint8Array(buffer);
    const v = new DataView(buffer);
    v.setUint32(0, atomSize, false);
    b[4] = 0x63; b[5] = 0x6f; b[6] = 0x36; b[7] = 0x34;
    v.setUint32(8, 0, false);
    v.setUint32(12, newCount, false);
    const srcBase = co64Box.offset + 16;
    const safeOffsetBig = BigInt(safeOffset);
    const offsetDeltaBig = BigInt(offsetDelta);
    for (let i = 0; i < origCount; i++) {
        v.setBigUint64(16 + i * 8, inputView.getBigUint64(srcBase + i * 8, false) + offsetDeltaBig, false);
    }
    for (let i = 0; i < fakeCount; i++) {
        v.setBigUint64(16 + (origCount + i) * 8, safeOffsetBig, false);
    }
    return b;
}

function detectCodec(bytes, stblBox) {
    const stblChildren = parseBoxes(bytes, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        stblBox.offset + getBoxHeaderSize(stblBox), stblBox.end);
    const stsdBox = stblChildren.find(b => b.type === "stsd");
    if (!stsdBox) return "unknown";
    const contentStart = stsdBox.offset + getBoxHeaderSize(stsdBox);
    if (contentStart + 16 > stsdBox.end) return "unknown";
    return String.fromCharCode(bytes[contentStart + 12], bytes[contentStart + 13], bytes[contentStart + 14], bytes[contentStart + 15]);
}

function buildStscPatch(inputBytes, inputView, stscBox, origStcoCount) {
    const origEntryCount = inputView.getUint32(stscBox.offset + 12, false);
    const newEntryCount = origEntryCount + 1;
    const atomSize = 16 + newEntryCount * 12;
    const buffer = new ArrayBuffer(atomSize);
    const b = new Uint8Array(buffer);
    const v = new DataView(buffer);
    v.setUint32(0, atomSize, false);
    b[4] = 0x73; b[5] = 0x74; b[6] = 0x73; b[7] = 0x63;
    v.setUint32(8, 0, false);
    v.setUint32(12, newEntryCount, false);
    const srcBase = stscBox.offset + 16;
    for (let i = 0; i < origEntryCount; i++) {
        v.setUint32(16 + i * 12, inputView.getUint32(srcBase + i * 12, false), false);
        v.setUint32(16 + i * 12 + 4, inputView.getUint32(srcBase + i * 12 + 4, false), false);
        v.setUint32(16 + i * 12 + 8, inputView.getUint32(srcBase + i * 12 + 8, false), false);
    }
    v.setUint32(16 + origEntryCount * 12, origStcoCount + 1, false);
    v.setUint32(16 + origEntryCount * 12 + 4, 1, false);
    v.setUint32(16 + origEntryCount * 12 + 8, 1, false);
    return b;
}

// ============================================================
// PHẦN 2: HÀM NÉN VIDEO TỐI ƯU - ĐÂY LÀ PHẦN QUAN TRỌNG NHẤT
// ============================================================

/**
 * Nén video xuống dưới ~19MB, giữ nguyên toàn bộ thời lượng gốc.
 *
 * Trước đây hàm này dùng "-crf 26 -fs 19.5M": ffmpeg sẽ NGỪNG GHI FILE
 * ngay khi đạt 19.5MB, tức là video output bị CẮT CỤT giữa chừng nếu
 * bản CRF-26 gốc dài hơn giới hạn đó — video mất đoạn cuối.
 *
 * Giờ đổi sang cách đúng hơn: đo thời lượng thật, tính ra bitrate cần
 * thiết để cả video (từ đầu đến cuối) vừa khít trong ~19MB, rồi encode
 * với bitrate đó. Video vẫn đủ độ dài, chỉ là bitrate thấp hơn đều
 * xuyên suốt thay vì bị cắt.
 */
export async function compressVideoUnder20MB(
    inputBytes,
    { logMessage, setProgress, isCancelled, targetMB = 19 } = {},
) {
    const log = (msg, type) => logMessage?.(msg, type);
    const report = (pct) => {
        try {
            setProgress?.(pct);
        } catch (_) {}
    };
    const checkCancelled = () => {
        if (isCancelled?.()) throw new Error("Cancelled");
    };

    checkCancelled();
    const instance = await getFFmpeg(
        (msg, type) => log(msg, type),
        (pct) => report(Math.round(pct * 0.5)), // ffmpeg's own progress covers the first half of our bar
    );

    const inputName = "compress_input.mp4";
    const outputName = "compress_output.mp4";

    try {
        await instance.writeFile(inputName, inputBytes);
        checkCancelled();

        // ---- Probe real duration + resolution from ffmpeg's own stderr log ----
        let duration = null;
        let srcWidth = null;
        let srcHeight = null;
        const probeHandler = ({ message }) => {
            const durMatch = /Duration:\s*(\d+):(\d+):(\d+\.?\d*)/.exec(message || "");
            if (durMatch && duration === null) {
                duration =
                    parseInt(durMatch[1], 10) * 3600 +
                    parseInt(durMatch[2], 10) * 60 +
                    parseFloat(durMatch[3]);
            }
            const resMatch = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(message || "");
            if (resMatch && srcWidth === null) {
                srcWidth = parseInt(resMatch[1], 10);
                srcHeight = parseInt(resMatch[2], 10);
            }
        };
        instance.on("log", probeHandler);
        await instance.exec(["-i", inputName]).catch(() => {});
        if (typeof instance.off === "function") instance.off("log", probeHandler);
        checkCancelled();

        // Encoding a huge source at its native resolution (often 4K straight
        // off a phone) single-threaded in WASM is what actually crashes the
        // tab — the WASM heap has to hold raw decoded frames at full res.
        // Cap the long edge at 1080p for this pass; that alone cuts memory
        // use roughly 4x for a 4K source and makes hitting a size target
        // realistic without OOM-ing the browser.
        const MAX_LONG_EDGE = 1080;
        let scaleFilter = null;
        if (srcWidth && srcHeight && Math.max(srcWidth, srcHeight) > MAX_LONG_EDGE) {
            scaleFilter =
                srcWidth >= srcHeight
                    ? `scale=${MAX_LONG_EDGE}:-2`
                    : `scale=-2:${MAX_LONG_EDGE}`;
            log(`  📐 Source is ${srcWidth}x${srcHeight} — downscaling to ~${MAX_LONG_EDGE}p to stay within browser memory limits.`, "info");
        }

        const audioBitrateBps = 96000;
        let videoBitrateKbps;
        if (duration && duration > 0.5) {
            const targetBits = targetMB * 1024 * 1024 * 8;
            const safetyMargin = 0.92; // headroom for container/muxing overhead
            const rawVideoBps = (targetBits / duration) * safetyMargin - audioBitrateBps;
            videoBitrateKbps = Math.max(150, Math.round(rawVideoBps / 1000));
            log(
                `  🎯 Duration ${duration.toFixed(1)}s → target bitrate ≈ ${videoBitrateKbps}kbps for <${targetMB}MB`,
                "info",
            );
        } else {
            // Couldn't read duration — fall back to a conservative flat bitrate
            // rather than guessing wrong and overshooting the size target.
            videoBitrateKbps = 1000;
            log("  ⚠️ Could not read video duration, using a conservative fallback bitrate.", "warning");
        }

        checkCancelled();
        const baseArgs = [
            "-i", inputName,
            ...(scaleFilter ? ["-vf", scaleFilter] : []),
            "-c:v", "libx264",
            "-b:v", `${videoBitrateKbps}k`,
            "-maxrate", `${Math.round(videoBitrateKbps * 1.45)}k`,
            "-bufsize", `${Math.round(videoBitrateKbps * 2)}k`,
            "-preset", "medium",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-b:a", "96k",
            "-movflags", "+faststart",
            outputName,
        ];

        log(`  ⚙️ Encoding at ~${videoBitrateKbps}kbps...`, "info");
        report(50);
        const ret = await instance.exec(baseArgs);
        if (ret !== 0 && ret !== undefined) {
            throw new Error(`FFmpeg exited with code ${ret}`);
        }
        checkCancelled();

        const data = await instance.readFile(outputName);
        if (!data || data.byteLength < 100) {
            throw new Error("FFmpeg produced an empty or invalid output file.");
        }
        report(100);
        return data;
    } finally {
        await instance.deleteFile(inputName).catch(() => {});
        await instance.deleteFile(outputName).catch(() => {});
    }
}

// ============================================================
// PHẦN 3: HÀM TÍCH HỢP CHÍNH (DÙNG HÀM NÀY)
// ============================================================

/**
 * HÀM CHÍNH: Nén video xuống dưới 20MB với chất lượng cao nhất
 * Đây là hàm duy nhất bạn cần gọi từ bên ngoài
 */
export async function processAndCompressVideo(inputBytes, options = {}) {
    // Bước 1: Nén video (giữ nguyên độ dài, hạ bitrate cho vừa dung lượng)
    const compressedBytes = await compressVideoUnder20MB(inputBytes, options);

    // Bước 2: Tối ưu metadata (không làm thay đổi chất lượng)
    const compressedView = new DataView(
        compressedBytes.buffer,
        compressedBytes.byteOffset,
        compressedBytes.byteLength
    );

    const finalResult = inflateQualityVideo(compressedBytes, compressedView, 1);

    if (finalResult) {
        return finalResult;
    }

    return {
        newBuffer: compressedBytes.buffer,
        newBytes: compressedBytes,
        newView: compressedView
    };
}

// ============================================================
// PHẦN 4: CÁC HÀM CŨ (GIỮ LẠI ĐỂ TƯƠNG THÍCH)
// ============================================================

export function inflateSampleTableVideo(inputBytes, inputView, multiplier = 1) {
    const fileSize = inputBytes.length;
    const topBoxes = parseBoxes(inputBytes, inputView, 0, fileSize);
    const moovBox = topBoxes.find((b) => b.type === "moov");
    if (!moovBox) return null;
    if (multiplier < 2) return null;

    const located = findVideoStbl(inputBytes, inputView, moovBox);
    if (!located) return null;

    const { stblBox } = located;
    const stblChildren = parseBoxes(
        inputBytes,
        inputView,
        stblBox.offset + getBoxHeaderSize(stblBox),
        stblBox.end,
    );

    const sttsBox = stblChildren.find((b) => b.type === "stts");
    const stszBox = stblChildren.find((b) => b.type === "stsz");
    const stcoBox = stblChildren.find((b) => b.type === "stco");
    const co64Box = stblChildren.find((b) => b.type === "co64");
    const stscBox = stblChildren.find((b) => b.type === "stsc");
    if (!sttsBox || !stszBox || !stscBox) return null;
    if (!stcoBox && !co64Box) return null;

    const sttsEntryCount = inputView.getUint32(sttsBox.offset + 12, false);
    let realCount = 0;
    let totalDuration = 0;
    const sttsBase = sttsBox.offset + 16;
    for (let i = 0; i < sttsEntryCount; i++) {
        const count = inputView.getUint32(sttsBase + i * 8, false);
        const delta = inputView.getUint32(sttsBase + i * 8 + 4, false);
        realCount += count;
        totalDuration += count * delta;
    }
    if (realCount === 0) return null;
    const sampleDelta = Math.round(totalDuration / realCount);

    const codec = detectCodec(inputBytes, stblBox);
    const dummySize = DUMMY_SIZES[codec] || DEFAULT_DUMMY_SIZE;

    const origChunkCount = stcoBox
        ? inputView.getUint32(stcoBox.offset + 12, false)
        : inputView.getUint32(co64Box.offset + 12, false);

    const newStts = buildSttsAtom(realCount, sampleDelta, multiplier);
    const newStsz = buildStszAtom(
        inputBytes,
        inputView,
        stszBox,
        realCount,
        multiplier,
        dummySize,
    );
    const newStsc = buildStscPatch(
        inputBytes,
        inputView,
        stscBox,
        origChunkCount,
    );

    const sttsDelta = newStts.length - sttsBox.size;
    const stszDelta = newStsz.length - stszBox.size;
    const stscDelta = newStsc.length - stscBox.size;
    const fakeCount = realCount * (multiplier - 1);
    const chunkBox = stcoBox || co64Box;
    const chunkEntrySize = stcoBox ? 4 : 8;
    const chunkDelta = fakeCount * chunkEntrySize;
    const moovDelta = sttsDelta + stszDelta + stscDelta + chunkDelta;

    const safeOffset = fileSize + moovDelta;
    const newChunkBox = stcoBox
        ? buildStcoAtom(
              inputView,
              stcoBox,
              origChunkCount,
              realCount,
              safeOffset,
              moovDelta,
              multiplier,
          )
        : buildCo64Atom(
              inputView,
              co64Box,
              origChunkCount,
              realCount,
              safeOffset,
              moovDelta,
              multiplier,
          );

    const replacements = [
        { box: sttsBox, bytes: newStts },
        { box: stszBox, bytes: newStsz },
        { box: stscBox, bytes: newStsc },
        { box: chunkBox, bytes: newChunkBox },
    ].sort((a, b) => a.box.offset - b.box.offset);

    const paddingSize = fakeCount * dummySize;
    const newSize = fileSize + moovDelta + paddingSize;
    const newBuffer = new ArrayBuffer(newSize);
    const newBytes = new Uint8Array(newBuffer);
    const newView = new DataView(newBuffer);

    let readPos = 0;
    let writePos = 0;
    for (const rep of replacements) {
        newBytes.set(inputBytes.subarray(readPos, rep.box.offset), writePos);
        writePos += rep.box.offset - readPos;
        newBytes.set(rep.bytes, writePos);
        writePos += rep.bytes.length;
        readPos = rep.box.end;
    }
    newBytes.set(inputBytes.subarray(readPos, fileSize), writePos);

    updateBoxSize(newView, stblBox.offset, stblBox, moovDelta);
    updateBoxSize(newView, located.minfBox.offset, located.minfBox, moovDelta);
    updateBoxSize(newView, located.mdiaBox.offset, located.mdiaBox, moovDelta);
    updateBoxSize(newView, located.trak.offset, located.trak, moovDelta);
    updateBoxSize(newView, moovBox.offset, moovBox, moovDelta);

    const mdatBox = topBoxes.find((b) => b.type === "mdat");
    const moovBeforeMdat = mdatBox && moovBox.offset < mdatBox.offset;

    if (moovBeforeMdat) {
        const updatedMoovSize = newView.getUint32(moovBox.offset, false);
        const moovEnd = moovBox.offset + updatedMoovSize;
        const moovChildren = parseBoxes(
            newBytes,
            newView,
            moovBox.offset + getBoxHeaderSize(moovBox),
            moovEnd,
        );
        for (const trak of moovChildren.filter((b) => b.type === "trak")) {
            const trakChildren = parseBoxes(
                newBytes,
                newView,
                trak.offset + getBoxHeaderSize(trak),
                trak.end,
            );
            const mdiaBox2 = trakChildren.find((b) => b.type === "mdia");
            if (!mdiaBox2) continue;
            const mdiaChildren = parseBoxes(
                newBytes,
                newView,
                mdiaBox2.offset + getBoxHeaderSize(mdiaBox2),
                mdiaBox2.end,
            );
            const minfBox2 = mdiaChildren.find((b) => b.type === "minf");
            if (!minfBox2) continue;
            const minfChildren = parseBoxes(
                newBytes,
                newView,
                minfBox2.offset + getBoxHeaderSize(minfBox2),
                minfBox2.end,
            );
            const stblBox2 = minfChildren.find((b) => b.type === "stbl");
            if (!stblBox2 || stblBox2.offset === stblBox.offset) continue;
            const stblChildren2 = parseBoxes(
                newBytes,
                newView,
                stblBox2.offset + getBoxHeaderSize(stblBox2),
                stblBox2.end,
            );
            const stcoBox2 = stblChildren2.find((b) => b.type === "stco");
            if (stcoBox2) {
                const count = newView.getUint32(stcoBox2.offset + 12, false);
                for (let i = 0; i < count; i++) {
                    const pos = stcoBox2.offset + 16 + i * 4;
                    newView.setUint32(
                        pos,
                        newView.getUint32(pos, false) + moovDelta,
                        false,
                    );
                }
            }
            const co64Box2 = stblChildren2.find((b) => b.type === "co64");
            if (co64Box2) {
                const count = newView.getUint32(co64Box2.offset + 12, false);
                for (let i = 0; i < count; i++) {
                    const pos = co64Box2.offset + 16 + i * 8;
                    newView.setBigUint64(
                        pos,
                        newView.getBigUint64(pos, false) + BigInt(moovDelta),
                        false,
                    );
                }
            }
        }
    }

    return { newBuffer, newBytes, newView };
}

export function inflateQualityVideo(inputBytes, inputView, level = 1) {
    // Giữ nguyên code cũ - chỉ cập nhật metadata, không thay đổi chất lượng
    const fileSize = inputBytes.length;
    const topBoxes = parseBoxes(inputBytes, inputView, 0, fileSize);
    const moovBox = topBoxes.find(b => b.type === "moov");
    const mdatBox = topBoxes.find(b => b.type === "mdat");
    if (!moovBox) return null;

    const newBuffer = inputBytes.buffer.slice(0);
    const newBytes = new Uint8Array(newBuffer);
    const newView = new DataView(newBuffer);
    const newMoovBox = { ...moovBox };

    let changed = false;

    if (mdatBox) {
        updateBoxSize(newView, mdatBox.offset, mdatBox, 0);
        changed = true;
    }

    const moovChildren = parseBoxes(newBytes, newView, newMoovBox.offset + getBoxHeaderSize(newMoovBox), newMoovBox.end);
    const mvhdBox = moovChildren.find(b => b.type === "mvhd");
    if (mvhdBox) {
        updateBoxSize(newView, mvhdBox.offset, mvhdBox, 0);
        changed = true;
    }

    const located = findVideoStbl(newBytes, newView, newMoovBox);
    if (located) {
        const stblChildren = parseBoxes(newBytes, newView,
            located.stblBox.offset + getBoxHeaderSize(located.stblBox),
            located.stblBox.end
        );
        const stsdBox = stblChildren.find(b => b.type === "stsd");
        if (stsdBox) {
            updateBoxSize(newView, stsdBox.offset, stsdBox, 0);
            changed = true;
        }
    }

    if (!changed) return null;
    return { newBuffer, newBytes, newView };
}

export async function createFakeVideo(inputBytes) {
    // KHÔNG KHUYẾN KHÍCH DÙNG - Có thể bị TikTok phát hiện và xử phạt
    // Thay vào đó, dùng processAndCompressVideo
    return processAndCompressVideo(inputBytes);
}
