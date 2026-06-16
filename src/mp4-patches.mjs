import {
    getBoxHeaderSize,
    getTkhdDuration,
    parseBoxes,
    updateBoxSize,
    updateChunkOffsets,
} from "./mp4-boxes.mjs";

export function buildEdtsAtom(duration, mediaTime = 0) {
    const useVersion1 = duration > 0xffffffff;
    const elstSize = useVersion1 ? 36 : 28;
    const edtsSize = 8 + elstSize;
    const buffer = new ArrayBuffer(edtsSize);
    const b = new Uint8Array(buffer);
    const v = new DataView(buffer);

    v.setUint32(0, edtsSize, false);
    b[4] = 0x65;
    b[5] = 0x64;
    b[6] = 0x74;
    b[7] = 0x73;
    v.setUint32(8, elstSize, false);
    b[12] = 0x65;
    b[13] = 0x6c;
    b[14] = 0x73;
    b[15] = 0x74;

    if (useVersion1) {
        v.setUint32(16, 0x01000000, false);
        v.setUint32(20, 1, false);
        v.setBigUint64(24, BigInt(duration), false);
        v.setBigInt64(32, BigInt(mediaTime), false);
        v.setUint32(40, 0x00010000, false);
    } else {
        v.setUint32(16, 0, false);
        v.setUint32(20, 1, false);
        v.setUint32(24, duration, false);
        v.setInt32(28, mediaTime, false);
        v.setUint32(32, 0x00010000, false);
    }

    return b;
}

export function rebuildWithElstBypass(inputBytes, inputView) {
    const fileSize = inputBytes.length;
    const topBoxes = parseBoxes(inputBytes, inputView, 0, fileSize);
    const moovBox = topBoxes.find((b) => b.type === "moov");
    if (!moovBox) return null;

    const mdatBox = topBoxes.find((b) => b.type === "mdat");
    const moovBeforeMdat = mdatBox && moovBox.offset < mdatBox.offset;

    const moovChildren = parseBoxes(
        inputBytes,
        inputView,
        moovBox.offset + getBoxHeaderSize(moovBox),
        moovBox.end,
    );
    const modifications = [];

    for (const trak of moovChildren.filter((b) => b.type === "trak")) {
        const trakChildren = parseBoxes(
            inputBytes,
            inputView,
            trak.offset + getBoxHeaderSize(trak),
            trak.end,
        );
        const tkhdBox = trakChildren.find((b) => b.type === "tkhd");
        const duration = tkhdBox
            ? getTkhdDuration(inputBytes, inputView, tkhdBox.offset)
            : 0;
        const edtsBox = trakChildren.find((b) => b.type === "edts");
        const mdiaBox = trakChildren.find((b) => b.type === "mdia");

        let mediaTime = 0;
        if (mdiaBox) {
            const mdiaChildren = parseBoxes(
                inputBytes,
                inputView,
                mdiaBox.offset + getBoxHeaderSize(mdiaBox),
                mdiaBox.end,
            );
            const mdhdBox = mdiaChildren.find((b) => b.type === "mdhd");
            if (mdhdBox) {
                const mdhdS = mdhdBox.offset + getBoxHeaderSize(mdhdBox);
                const mdhdVer = inputBytes[mdhdS];
                const mdhdTsOff = mdhdVer === 0 ? 12 : 20;
                const mdhdTs = inputView.getUint32(mdhdS + mdhdTsOff, false);
                if (mdhdTs === 90000) mediaTime = 6000;
            }
        }

        if (edtsBox) {
            const edtsBytes = buildEdtsAtom(duration, mediaTime);
            modifications.push({
                removeStart: edtsBox.offset,
                removeEnd: edtsBox.end,
                trakBox: trak,
                edtsBytes,
                addedDelta: edtsBytes.length - edtsBox.size,
            });
        } else {
            const edtsBytes = buildEdtsAtom(duration, mediaTime);
            const insertAt = mdiaBox ? mdiaBox.offset : trak.end;
            modifications.push({
                removeStart: insertAt,
                removeEnd: insertAt,
                trakBox: trak,
                edtsBytes,
                addedDelta: edtsBytes.length,
            });
        }
    }

    if (modifications.length === 0) return null;

    modifications.sort((a, b) => a.removeStart - b.removeStart);

    const totalDelta = modifications.reduce(
        (sum, mod) => sum + mod.addedDelta,
        0,
    );
    const newBuffer = new ArrayBuffer(fileSize + totalDelta);
    const newBytes = new Uint8Array(newBuffer);
    const newView = new DataView(newBuffer);

    let readPos = 0;
    let writePos = 0;
    for (const mod of modifications) {
        newBytes.set(inputBytes.subarray(readPos, mod.removeStart), writePos);
        writePos += mod.removeStart - readPos;
        newBytes.set(mod.edtsBytes, writePos);
        writePos += mod.edtsBytes.length;
        readPos = mod.removeEnd;
    }
    newBytes.set(inputBytes.subarray(readPos), writePos);

    let cumulativeDelta = 0;
    for (const mod of modifications) {
        updateBoxSize(
            newView,
            mod.trakBox.offset + cumulativeDelta,
            mod.trakBox,
            mod.addedDelta,
        );
        cumulativeDelta += mod.addedDelta;
    }

    updateBoxSize(newView, moovBox.offset, moovBox, totalDelta);

    if (moovBeforeMdat) {
        updateChunkOffsets(
            newBytes,
            newView,
            moovBox.offset + getBoxHeaderSize(moovBox),
            moovBox.offset + moovBox.size + totalDelta,
            totalDelta,
        );
    }

    const replacedCount = modifications.filter(
        (m) => m.removeStart !== m.removeEnd,
    ).length;
    const injectedCount = modifications.length - replacedCount;
    return { newBytes, newBuffer, replacedCount, injectedCount };
}

export function patchMvhdMatrix(bytes, view) {
    const fileSize = bytes.length;
    const topBoxes = parseBoxes(bytes, view, 0, fileSize);
    const moovBox = topBoxes.find((b) => b.type === "moov");
    if (!moovBox) return null;

    const moovChildren = parseBoxes(
        bytes,
        view,
        moovBox.offset + getBoxHeaderSize(moovBox),
        moovBox.end,
    );
    const mvhdBox = moovChildren.find((b) => b.type === "mvhd");
    if (!mvhdBox) return null;

    const contentStart = mvhdBox.offset + getBoxHeaderSize(mvhdBox);
    if (contentStart >= mvhdBox.end) return null;

    const version = bytes[contentStart];
    let matrixOffset;
    if (version === 0) matrixOffset = contentStart + 36;
    else if (version === 1) matrixOffset = contentStart + 48;
    else return null;

    const matrixBOffset = matrixOffset + 4;
    if (matrixBOffset + 4 > mvhdBox.end) return null;

    const previousValue = view.getInt32(matrixBOffset, false);
    if (previousValue !== 0)
        return { previousValue, newValue: previousValue, skipped: true };

    view.setInt32(matrixBOffset, 1, false);
    return { previousValue, newValue: 1 };
}
