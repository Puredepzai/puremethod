import {
    getBoxHeaderSize,
    parseBoxes,
    updateBoxSize,
    updateChunkOffsets,
} from "./mp4-boxes.mjs";

const DUMMY_SAMPLE_SIZE = 8;

function findVideoStbl(bytes, view, moovBox) {
    const moovChildren = parseBoxes(
        bytes,
        view,
        moovBox.offset + getBoxHeaderSize(moovBox),
        moovBox.end,
    );

    for (const trak of moovChildren.filter((b) => b.type === "trak")) {
        const trakChildren = parseBoxes(
            bytes,
            view,
            trak.offset + getBoxHeaderSize(trak),
            trak.end,
        );
        const mdiaBox = trakChildren.find((b) => b.type === "mdia");
        if (!mdiaBox) continue;

        const mdiaChildren = parseBoxes(
            bytes,
            view,
            mdiaBox.offset + getBoxHeaderSize(mdiaBox),
            mdiaBox.end,
        );
        const hdlrBox = mdiaChildren.find((b) => b.type === "hdlr");
        if (!hdlrBox) continue;

        const handlerType = String.fromCharCode(
            bytes[hdlrBox.offset + 16],
            bytes[hdlrBox.offset + 17],
            bytes[hdlrBox.offset + 18],
            bytes[hdlrBox.offset + 19],
        );
        if (handlerType !== "vide") continue;

        const minfBox = mdiaChildren.find((b) => b.type === "minf");
        if (!minfBox) continue;

        const minfChildren = parseBoxes(
            bytes,
            view,
            minfBox.offset + getBoxHeaderSize(minfBox),
            minfBox.end,
        );
        const stblBox = minfChildren.find((b) => b.type === "stbl");
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
    b[4] = 0x73;
    b[5] = 0x74;
    b[6] = 0x74;
    b[7] = 0x73;
    v.setUint32(8, 0, false);
    v.setUint32(12, 2, false);
    v.setUint32(16, realCount, false);
    v.setUint32(20, sampleDelta, false);
    v.setUint32(24, fakeCount, false);
    v.setUint32(28, sampleDelta, false);

    return b;
}

function buildStszAtom(inputBytes, inputView, stszBox, realCount, multiplier) {
    const totalCount = realCount * multiplier;
    const atomSize = 20 + totalCount * 4;
    const buffer = new ArrayBuffer(atomSize);
    const b = new Uint8Array(buffer);
    const v = new DataView(buffer);

    v.setUint32(0, atomSize, false);
    b[4] = 0x73;
    b[5] = 0x74;
    b[6] = 0x73;
    b[7] = 0x7a;
    v.setUint32(8, 0, false);
    v.setUint32(12, 0, false);
    v.setUint32(16, totalCount, false);

    const srcBase = stszBox.offset + 20;
    for (let i = 0; i < realCount; i++) {
        v.setUint32(
            20 + i * 4,
            inputView.getUint32(srcBase + i * 4, false),
            false,
        );
    }
    for (let i = realCount; i < totalCount; i++) {
        v.setUint32(20 + i * 4, DUMMY_SAMPLE_SIZE, false);
    }

    return b;
}

function buildStcoAtom(
    inputView,
    stcoBox,
    realCount,
    safeOffset,
    offsetDelta,
    multiplier,
) {
    const origCount = inputView.getUint32(stcoBox.offset + 12, false);
    const fakeCount = realCount * (multiplier - 1);
    const newCount = origCount + fakeCount;
    const atomSize = 16 + newCount * 4;
    const buffer = new ArrayBuffer(atomSize);
    const b = new Uint8Array(buffer);
    const v = new DataView(buffer);

    v.setUint32(0, atomSize, false);
    b[4] = 0x73;
    b[5] = 0x74;
    b[6] = 0x63;
    b[7] = 0x6f;
    v.setUint32(8, 0, false);
    v.setUint32(12, newCount, false);

    const srcBase = stcoBox.offset + 16;
    for (let i = 0; i < origCount; i++) {
        v.setUint32(
            16 + i * 4,
            inputView.getUint32(srcBase + i * 4, false) + offsetDelta,
            false,
        );
    }
    for (let i = 0; i < fakeCount; i++) {
        v.setUint32(16 + (origCount + i) * 4, safeOffset, false);
    }

    return b;
}

function buildStscPatch(inputBytes, inputView, stscBox, origStcoCount) {
    const origEntryCount = inputView.getUint32(stscBox.offset + 12, false);
    const newEntryCount = origEntryCount + 1;
    const atomSize = 16 + newEntryCount * 12;
    const buffer = new ArrayBuffer(atomSize);
    const b = new Uint8Array(buffer);
    const v = new DataView(buffer);

    v.setUint32(0, atomSize, false);
    b[4] = 0x73;
    b[5] = 0x74;
    b[6] = 0x73;
    b[7] = 0x63;
    v.setUint32(8, 0, false);
    v.setUint32(12, newEntryCount, false);

    const srcBase = stscBox.offset + 16;
    for (let i = 0; i < origEntryCount; i++) {
        const fc = inputView.getUint32(srcBase + i * 12, false);
        const spc = inputView.getUint32(srcBase + i * 12 + 4, false);
        const sdi = inputView.getUint32(srcBase + i * 12 + 8, false);
        v.setUint32(16 + i * 12, fc, false);
        v.setUint32(16 + i * 12 + 4, spc, false);
        v.setUint32(16 + i * 12 + 8, sdi, false);
    }

    v.setUint32(16 + origEntryCount * 12, origStcoCount + 1, false);
    v.setUint32(16 + origEntryCount * 12 + 4, 1, false);
    v.setUint32(16 + origEntryCount * 12 + 8, 1, false);

    return b;
}

export function inflateSampleTableVideo(inputBytes, inputView, multiplier = 5) {
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
    const stscBox = stblChildren.find((b) => b.type === "stsc");
    if (!sttsBox || !stszBox || !stcoBox || !stscBox) return null;

    const sttsEntryCount = inputView.getUint32(sttsBox.offset + 12, false);
    if (sttsEntryCount !== 1) return null;

    const realCount = inputView.getUint32(sttsBox.offset + 16, false);
    const sampleDelta = inputView.getUint32(sttsBox.offset + 20, false);
    if (realCount === 0) return null;

    const origStcoCount = inputView.getUint32(stcoBox.offset + 12, false);

    const newStts = buildSttsAtom(realCount, sampleDelta, multiplier);
    const newStsz = buildStszAtom(
        inputBytes,
        inputView,
        stszBox,
        realCount,
        multiplier,
    );
    const newStsc = buildStscPatch(
        inputBytes,
        inputView,
        stscBox,
        origStcoCount,
    );

    const sttsDelta = newStts.length - sttsBox.size;
    const stszDelta = newStsz.length - stszBox.size;
    const stscDelta = newStsc.length - stscBox.size;
    const fakeCount = realCount * (multiplier - 1);
    const stcoDelta = fakeCount * 4;
    const moovDelta = sttsDelta + stszDelta + stscDelta + stcoDelta;

    const safeOffset = fileSize + moovDelta;
    const newStco = buildStcoAtom(
        inputView,
        stcoBox,
        realCount,
        safeOffset,
        moovDelta,
        multiplier,
    );

    const replacements = [
        { box: sttsBox, bytes: newStts },
        { box: stszBox, bytes: newStsz },
        { box: stscBox, bytes: newStsc },
        { box: stcoBox, bytes: newStco },
    ].sort((a, b) => a.box.offset - b.box.offset);

    const paddingSize = fakeCount * DUMMY_SAMPLE_SIZE;
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

    const audioShiftStart = stcoBox.end;
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
            const stblChildren = parseBoxes(
                newBytes,
                newView,
                stblBox2.offset + getBoxHeaderSize(stblBox2),
                stblBox2.end,
            );
            const stcoBox2 = stblChildren.find((b) => b.type === "stco");
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
            const co64Box2 = stblChildren.find((b) => b.type === "co64");
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
