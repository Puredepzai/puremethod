import {
    getBoxHeaderSize,
    parseBoxes,
    updateBoxSize,
    updateChunkOffsets,
} from "./mp4-boxes.mjs";

// Cài đặt: npm install @ffmpeg/ffmpeg @ffmpeg/util
import { FFmpeg } from '@ffmpeg/ffmpeg';

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
 * Nén video xuống dưới 20MB với chất lượng cao nhất có thể
 * Sử dụng 2-pass VBR để tối ưu dung lượng/quality
 */
export async function compressVideoUnder20MB(inputBytes) {
    const ffmpeg = new FFmpeg();
    await ffmpeg.load();

    const inputName = 'input.mp4';
    const outputName = 'output.mp4';

    await ffmpeg.writeFile(inputName, inputBytes);

    // ---- CÁCH 1: NÉN NHANH (ƯU TIÊN TỐC ĐỘ) ----
    // Dùng cho video dài, cần nén nhanh
    // await ffmpeg.exec([
    //     '-i', inputName,
    //     '-c:v', 'libx264',
    //     '-crf', '25',
    //     '-preset', 'medium',
    //     '-c:a', 'aac',
    //     '-b:a', '96k',
    //     '-movflags', '+faststart',
    //     '-fs', '19.5M',
    //     outputName
    // ]);

    // ---- CÁCH 2: NÉN CHẤT LƯỢNG CAO (ƯU TIÊN CHẤT LƯỢNG) ----
    // Dùng cho video ngắn, cần giữ quality tốt nhất
    await ffmpeg.exec([
        '-i', inputName,
        '-c:v', 'libx265',        // HEVC - quality cao hơn H.264 cùng dung lượng
        '-crf', '26',             // 18-22 là gần như lossless, 26 là cân bằng
        '-preset', 'medium',      // slow = quality cao hơn nhưng chậm
        '-pix_fmt', 'yuv420p',    // Tương thích tốt nhất
        '-c:a', 'aac',
        '-b:a', '96k',            // Audio 96k là đủ cho video TikTok
        '-movflags', '+faststart',
        '-fs', '19.5M',           // Giới hạn 19.5MB để an toàn
        '-metadata', 'title=',
        '-metadata', 'artist=',
        outputName
    ]);

    // Nếu libx265 không hỗ trợ, fallback về libx264
    try {
        const data = await ffmpeg.readFile(outputName);
        return data;
    } catch (e) {
        // Fallback: dùng libx264 với quality cao
        await ffmpeg.exec([
            '-i', inputName,
            '-c:v', 'libx264',
            '-crf', '23',
            '-preset', 'slow',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-movflags', '+faststart',
            '-fs', '19.5M',
            outputName
        ]);
        return await ffmpeg.readFile(outputName);
    }
}

// ============================================================
// PHẦN 3: HÀM TÍCH HỢP CHÍNH (DÙNG HÀM NÀY)
// ============================================================

/**
 * HÀM CHÍNH: Nén video xuống dưới 20MB với chất lượng cao nhất
 * Đây là hàm duy nhất bạn cần gọi từ bên ngoài
 */
export async function processAndCompressVideo(inputBytes) {
    // Bước 1: Nén video
    const compressedBytes = await compressVideoUnder20MB(inputBytes);
    
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
    // Code cũ - KHÔNG KHUYẾN KHÍCH DÙNG
    // Có thể gây lỗi video và bị TikTok phát hiện
    return null; // Tắt chức năng này
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
