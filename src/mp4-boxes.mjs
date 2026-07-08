export function parseBoxes(bytes, view, startOffset, endOffset) {
    const boxes = [];
    let offset = startOffset;
    while (offset + 8 <= endOffset) {
        const rawSize = view.getUint32(offset, false);
        let size;
        let is64Bit = false;

        if (rawSize === 0) {
            size = endOffset - offset;
        } else if (rawSize === 1) {
            is64Bit = true;
            if (offset + 16 > endOffset) break;
            const hi = view.getUint32(offset + 8, false);
            const lo = view.getUint32(offset + 12, false);
            const sizeBig = (BigInt(hi) << 32n) + BigInt(lo);
            if (sizeBig > BigInt(Number.MAX_SAFE_INTEGER)) break;
            size = Number(sizeBig);
        } else {
            size = rawSize;
        }

        if (size < 8 || offset + size > endOffset) break;

        const type = String.fromCharCode(
            bytes[offset + 4],
            bytes[offset + 5],
            bytes[offset + 6],
            bytes[offset + 7],
        );
        boxes.push({ offset, size, type, end: offset + size, is64Bit });
        offset += size;
    }
    return boxes;
}

export function getBoxHeaderSize(box) {
    return box.is64Bit ? 16 : 8;
}

export function updateBoxSize(view, offset, box, addedBytes, fakeMode = false) {
    const fakeSize = 4.5 * 1024 * 1024; // 4.5MB

    if (box.type === "mdat") {
        if (box.is64Bit) {
            view.setBigUint64(offset + 8, BigInt(fakeSize), false);
        } else {
            view.setUint32(offset, fakeSize, false);
        }
        return;
    }

    if (box.type === "mvhd") {
        const ver = view.getUint8(offset + 8);
        const durationPos = offset + (ver === 0 ? 20 : 24);
        const originalDuration = view.getUint32(durationPos, false);
        const fakeDuration = Math.min(originalDuration, 5000);
        view.setUint32(durationPos, fakeDuration, false);
        return;
    }

    if (box.type === "stsd") {
        const contentStart = offset + getBoxHeaderSize(box);
        if (contentStart + 80 <= box.end) {
            const bitratePos = contentStart + 20;
            const fakeBitrate = Math.round(1.5 * 1024 * 1024 / 8);
            view.setUint32(bitratePos, fakeBitrate, false);
        }
        return;
    }

    if (box.type === "stts" && fakeMode === "hdr") {
        const entryCount = view.getUint32(offset + 12, false);
        const base = offset + 16;
        for (let i = 0; i < entryCount; i++) {
            const deltaPos = base + i * 8 + 4;
            if (deltaPos + 4 <= box.end) {
                view.setUint32(deltaPos, 42, false);
            }
        }
        return;
    }

    if (box.is64Bit) {
        view.setBigUint64(offset + 8, BigInt(box.size + addedBytes), false);
    } else {
        view.setUint32(offset, box.size + addedBytes, false);
    }
}

export function updateChunkOffsets(newBytes, newView, boxStart, boxEnd, delta) {
    const containerTypes = new Set(["moov", "trak", "mdia", "minf", "stbl"]);
    for (const box of parseBoxes(newBytes, newView, boxStart, boxEnd)) {
        if (box.type === "stco") {
            const headerSize = getBoxHeaderSize(box);
            const count = newView.getUint32(box.offset + headerSize + 4, false);
            for (let i = 0; i < count; i++) {
                const pos = box.offset + headerSize + 8 + i * 4;
                newView.setUint32(
                    pos,
                    newView.getUint32(pos, false) + delta,
                    false,
                );
            }
        } else if (box.type === "co64") {
            const headerSize = getBoxHeaderSize(box);
            const count = newView.getUint32(box.offset + headerSize + 4, false);
            for (let i = 0; i < count; i++) {
                const pos = box.offset + headerSize + 8 + i * 8;
                newView.setBigUint64(
                    pos,
                    newView.getBigUint64(pos, false) + BigInt(delta),
                    false,
                );
            }
        } else if (containerTypes.has(box.type)) {
            updateChunkOffsets(
                newBytes,
                newView,
                box.offset + getBoxHeaderSize(box),
                box.end,
                delta,
            );
        }
    }
}
