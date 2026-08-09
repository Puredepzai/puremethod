// ============================================================
// mp4-boxes.mjs - Parser và helper cho MP4 box
// ============================================================

/**
 * Parse tất cả các box trong một khoảng của file MP4
 */
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

/**
 * Lấy kích thước header của một box
 */
export function getBoxHeaderSize(box) {
    return box.is64Bit ? 16 : 8;
}

/**
 * Cập nhật kích thước của một box (không fake)
 */
export function updateBoxSize(view, offset, box, addedBytes) {
    // Không fake gì cả - cập nhật size chính xác
    if (box.is64Bit) {
        const newSize = BigInt(box.size + addedBytes);
        view.setBigUint64(offset + 8, newSize, false);
    } else {
        const newSize = box.size + addedBytes;
        // Kiểm tra overflow: nếu size > 2^32 - 1, cần chuyển sang 64-bit
        if (newSize > 0xFFFFFFFF) {
            // Chuyển sang 64-bit
            box.is64Bit = true;
            box.size = newSize;
            // Set size = 1 để báo hiệu 64-bit
            view.setUint32(offset, 1, false);
            view.setBigUint64(offset + 8, BigInt(newSize), false);
        } else {
            view.setUint32(offset, newSize, false);
        }
    }
}

/**
 * Cập nhật tất cả chunk offsets trong stco/co64 boxes
 */
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
