import {
    getBoxHeaderSize,
    parseBoxes,
    updateBoxSize,
    updateChunkOffsets,
} from "./mp4-boxes.mjs";

export function stripUdtaAtom(inputBytes, inputView) {
    const fileSize = inputBytes.length;
    const topBoxes = parseBoxes(inputBytes, inputView, 0, fileSize);
    const moovBox = topBoxes.find((b) => b.type === "moov");
    if (!moovBox) return null;

    const moovChildren = parseBoxes(
        inputBytes,
        inputView,
        moovBox.offset + getBoxHeaderSize(moovBox),
        moovBox.end,
    );
    const udtaBox = moovChildren.find((b) => b.type === "udta");
    if (!udtaBox) return null;

    const delta = -udtaBox.size;
    const newBuffer = new ArrayBuffer(fileSize + delta);
    const newBytes = new Uint8Array(newBuffer);
    const newView = new DataView(newBuffer);

    newBytes.set(inputBytes.subarray(0, udtaBox.offset), 0);
    newBytes.set(inputBytes.subarray(udtaBox.end), udtaBox.offset);

    updateBoxSize(newView, moovBox.offset, moovBox, delta);
    updateChunkOffsets(newBytes, newView, 0, fileSize + delta, delta);

    return { newBuffer, newBytes, newView };
}

function buildCommentUdta(commentText) {
    const encoder = new TextEncoder();
    const commentBytes = encoder.encode(commentText);

    const dataSize = 16 + commentBytes.length;
    const cmtSize = 8 + dataSize;
    const ilstSize = 8 + cmtSize;
    const hdlrSize = 33;
    const metaSize = 12 + hdlrSize + ilstSize;
    const udtaSize = 8 + metaSize;

    const buffer = new ArrayBuffer(udtaSize);
    const b = new Uint8Array(buffer);
    const v = new DataView(buffer);
    let p = 0;

    v.setUint32(p, udtaSize, false);
    b[p + 4] = 0x75;
    b[p + 5] = 0x64;
    b[p + 6] = 0x74;
    b[p + 7] = 0x61;
    p += 8;

    v.setUint32(p, metaSize, false);
    b[p + 4] = 0x6d;
    b[p + 5] = 0x65;
    b[p + 6] = 0x74;
    b[p + 7] = 0x61;
    v.setUint32(p + 8, 0, false);
    p += 12;

    v.setUint32(p, hdlrSize, false);
    b[p + 4] = 0x68;
    b[p + 5] = 0x64;
    b[p + 6] = 0x6c;
    b[p + 7] = 0x72;
    v.setUint32(p + 8, 0, false);
    v.setUint32(p + 12, 0, false);
    b[p + 16] = 0x6d;
    b[p + 17] = 0x64;
    b[p + 18] = 0x69;
    b[p + 19] = 0x72;
    b[p + 20] = 0x61;
    b[p + 21] = 0x70;
    b[p + 22] = 0x70;
    b[p + 23] = 0x6c;
    v.setUint32(p + 24, 0, false);
    v.setUint32(p + 28, 0, false);
    b[p + 32] = 0x00;
    p += hdlrSize;

    v.setUint32(p, ilstSize, false);
    b[p + 4] = 0x69;
    b[p + 5] = 0x6c;
    b[p + 6] = 0x73;
    b[p + 7] = 0x74;
    p += 8;

    v.setUint32(p, cmtSize, false);
    b[p + 4] = 0xa9;
    b[p + 5] = 0x63;
    b[p + 6] = 0x6d;
    b[p + 7] = 0x74;
    p += 8;

    v.setUint32(p, dataSize, false);
    b[p + 4] = 0x64;
    b[p + 5] = 0x61;
    b[p + 6] = 0x74;
    b[p + 7] = 0x61;
    v.setUint32(p + 8, 1, false);
    v.setUint32(p + 12, 0, false);
    b.set(commentBytes, p + 16);

    return b;
}

export function injectCommentUdta(inputBytes, inputView, commentText) {
    const fileSize = inputBytes.length;
    const topBoxes = parseBoxes(inputBytes, inputView, 0, fileSize);
    const moovBox = topBoxes.find((b) => b.type === "moov");
    if (!moovBox) return null;

    const mdatBox = topBoxes.find((b) => b.type === "mdat");
    const moovBeforeMdat = mdatBox && moovBox.offset < mdatBox.offset;

    const udtaBytes = buildCommentUdta(commentText);
    const delta = udtaBytes.length;
    const insertAt = moovBox.end;

    const newBuffer = new ArrayBuffer(fileSize + delta);
    const newBytes = new Uint8Array(newBuffer);
    const newView = new DataView(newBuffer);

    newBytes.set(inputBytes.subarray(0, insertAt), 0);
    newBytes.set(udtaBytes, insertAt);
    newBytes.set(inputBytes.subarray(insertAt), insertAt + delta);

    updateBoxSize(newView, moovBox.offset, moovBox, delta);

    if (moovBeforeMdat) {
        updateChunkOffsets(
            newBytes,
            newView,
            moovBox.offset + getBoxHeaderSize(moovBox),
            moovBox.end + delta,
            delta,
        );
    }

    return { newBuffer, newBytes, newView };
}

export function stripTkhdMatrix(bytes, view) {
    const fileSize = bytes.length;
    const topBoxes = parseBoxes(bytes, view, 0, fileSize);
    const moovBox = topBoxes.find((b) => b.type === "moov");
    if (!moovBox) return { patched: false };

    const moovChildren = parseBoxes(
        bytes,
        view,
        moovBox.offset + getBoxHeaderSize(moovBox),
        moovBox.end,
    );
    let patched = false;

    for (const trak of moovChildren.filter((b) => b.type === "trak")) {
        const trakChildren = parseBoxes(
            bytes,
            view,
            trak.offset + getBoxHeaderSize(trak),
            trak.end,
        );
        const tkhdBox = trakChildren.find((b) => b.type === "tkhd");
        if (!tkhdBox) continue;

        const contentStart = tkhdBox.offset + getBoxHeaderSize(tkhdBox);
        const version = bytes[contentStart];
        let matrixOffset;

        if (version === 0) matrixOffset = contentStart + 40;
        else if (version === 1) matrixOffset = contentStart + 52;
        else continue;

        if (matrixOffset + 36 > tkhdBox.end) continue;

        view.setUint32(matrixOffset + 0, 0x00010000, false);
        view.setUint32(matrixOffset + 4, 0x00000000, false);
        view.setUint32(matrixOffset + 8, 0x00000000, false);
        view.setUint32(matrixOffset + 12, 0x00000000, false);
        view.setUint32(matrixOffset + 16, 0x00010000, false);
        view.setUint32(matrixOffset + 20, 0x00000000, false);
        view.setUint32(matrixOffset + 24, 0x00000000, false);
        view.setUint32(matrixOffset + 28, 0x00000000, false);
        view.setUint32(matrixOffset + 32, 0x40000000, false);
        patched = true;
    }

    return { patched };
}
