// Utility functions for MP4 container transform (browser-independent)

export function parseBoxes(bytes, view, startOffset, endOffset) {
    const boxes = [];
    let offset = startOffset;
    while (offset + 8 <= endOffset) {
        const rawSize = view.getUint32(offset, false);
        let size,
            is64Bit = false;

        if (rawSize === 0) {
            size = endOffset - offset;
        } else if (rawSize === 1) {
            is64Bit = true;
            if (offset + 16 > endOffset) break;
            const hi = view.getUint32(offset + 8, false);
            const lo = view.getUint32(offset + 12, false);
            const sizeBig = (BigInt(hi) << 32n) + BigInt(lo);
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
                const currentOffset = newView.getBigUint64(pos, false);
                newView.setBigUint64(pos, currentOffset + BigInt(delta), false);
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

export function applyContainerTransform(bytes, view) {
    const topBoxes = parseBoxes(bytes, view, 0, bytes.length);
    const ftypBox = topBoxes.find((b) => b.type === "ftyp");
    const moovBox = topBoxes.find((b) => b.type === "moov");

    if (!ftypBox || !moovBox) {
        return { success: false, error: "Missing ftyp or moov box" };
    }

    const moovBoxes = parseBoxes(
        bytes,
        view,
        moovBox.offset + getBoxHeaderSize(moovBox),
        moovBox.end,
    );
    const mvhdBox = moovBoxes.find((b) => b.type === "mvhd");

    if (!mvhdBox) {
        return { success: false, error: "Missing mvhd box" };
    }

    // Parse mvhd
    const mvhdHeaderSize = getBoxHeaderSize(mvhdBox);
    const mvhdContentStart = mvhdBox.offset + mvhdHeaderSize;
    const mvhdVersion = bytes[mvhdContentStart];

    let mvhdTimescale, mvhdDuration;
    if (mvhdVersion === 0) {
        mvhdTimescale = view.getUint32(mvhdContentStart + 12, false);
        mvhdDuration = view.getUint32(mvhdContentStart + 16, false);
    } else {
        mvhdTimescale = view.getUint32(mvhdContentStart + 20, false);
        mvhdDuration = Number(view.getBigUint64(mvhdContentStart + 24, false));
    }

    // Collect track info
    const tracks = [];
    const trakBoxes = moovBoxes.filter((b) => b.type === "trak");

    for (const trakBox of trakBoxes) {
        const trakBoxes2 = parseBoxes(
            bytes,
            view,
            trakBox.offset + getBoxHeaderSize(trakBox),
            trakBox.end,
        );
        const mdiaBox = trakBoxes2.find((b) => b.type === "mdia");
        const tkhdBox = trakBoxes2.find((b) => b.type === "tkhd");

        if (!mdiaBox || !tkhdBox) continue;

        const mdiaBoxes = parseBoxes(
            bytes,
            view,
            mdiaBox.offset + getBoxHeaderSize(mdiaBox),
            mdiaBox.end,
        );
        const mdhdBox = mdiaBoxes.find((b) => b.type === "mdhd");

        if (!mdhdBox) continue;

        const mdhdHeaderSize = getBoxHeaderSize(mdhdBox);
        const mdhdContentStart = mdhdBox.offset + mdhdHeaderSize;
        const mdhdVersion = bytes[mdhdContentStart];

        let mdhdTimescale, mdhdDuration;
        if (mdhdVersion === 0) {
            mdhdTimescale = view.getUint32(mdhdContentStart + 12, false);
            mdhdDuration = view.getUint32(mdhdContentStart + 16, false);
        } else {
            mdhdTimescale = view.getUint32(mdhdContentStart + 20, false);
            mdhdDuration = Number(
                view.getBigUint64(mdhdContentStart + 24, false),
            );
        }

        const minfBox = mdiaBoxes.find((b) => b.type === "minf");
        if (!minfBox) continue;

        const minfBoxes = parseBoxes(
            bytes,
            view,
            minfBox.offset + getBoxHeaderSize(minfBox),
            minfBox.end,
        );
        const stblBox = minfBoxes.find((b) => b.type === "stbl");

        if (!stblBox) continue;

        const stblBoxes = parseBoxes(
            bytes,
            view,
            stblBox.offset + getBoxHeaderSize(stblBox),
            stblBox.end,
        );
        const sttsBox = stblBoxes.find((b) => b.type === "stts");

        if (!sttsBox) continue;

        const sttsHeaderSize = getBoxHeaderSize(sttsBox);
        const sttsContentStart = sttsBox.offset + sttsHeaderSize;
        const sttsEntryCount = view.getUint32(sttsContentStart + 4, false);

        let actualDuration = 0;
        for (let i = 0; i < sttsEntryCount; i++) {
            const sampleCount = view.getUint32(
                sttsContentStart + 8 + i * 8,
                false,
            );
            const sampleDelta = view.getUint32(
                sttsContentStart + 12 + i * 8,
                false,
            );
            actualDuration += sampleCount * sampleDelta;
        }

        tracks.push({
            trakBox,
            tkhdBox,
            mdiaBox,
            mdhdBox,
            minfBox,
            stblBox,
            sttsBox,
            mdhdTimescale,
            mdhdDuration,
            sttsEntryCount,
            actualDuration,
        });
    }

    if (tracks.length === 0) {
        return { success: false, error: "No valid tracks found" };
    }

    // Calculate new durations
    const newTimescale = 1000;
    const timescaleRatio = newTimescale / mvhdTimescale;
    const newMvhdDuration = Math.round(mvhdDuration * timescaleRatio);

    for (const track of tracks) {
        track.newMdhdDuration = track.actualDuration * 2;
        track.newTkhdDuration = Math.round(
            track.newMdhdDuration *
                timescaleRatio *
                (mvhdTimescale / track.mdhdTimescale),
        );
        track.newSttsEntryCount = track.sttsEntryCount + 1;
    }

    // Calculate new file size
    const ftypNewSize = 28;
    const ftypDelta = ftypNewSize - ftypBox.size;

    let moovDelta = 0;
    moovDelta += 0; // mvhd no change
    for (const track of tracks) {
        moovDelta += 0; // tkhd no change
        moovDelta += 0; // mdia no change
        moovDelta += 0; // mdhd no change
        moovDelta += 0; // minf no change
        moovDelta += 0; // stbl no change
        moovDelta += 8; // stts +8 bytes (1 extra entry)
    }

    const newFileSize = bytes.length + ftypDelta + moovDelta;
    const newBytes = new Uint8Array(newFileSize);
    const newView = new DataView(newBytes.buffer);

    // Write new ftyp
    newView.setUint32(0, ftypNewSize, false);
    newBytes.set([0x66, 0x74, 0x79, 0x70], 4); // ftyp
    newBytes.set([0x69, 0x73, 0x6f, 0x6d], 8); // isom
    newView.setUint32(12, 512, false); // minor version
    newBytes.set([0x69, 0x73, 0x6f, 0x6d], 16); // isom
    newBytes.set([0x69, 0x73, 0x6f, 0x32], 20); // iso2
    newBytes.set([0x6d, 0x70, 0x34, 0x31], 24); // mp41

    // Copy mdat
    const mdatBox = topBoxes.find((b) => b.type === "mdat");
    const mdatStart = mdatBox.offset;
    const mdatEnd = mdatBox.end;
    newBytes.set(bytes.subarray(mdatStart, mdatEnd), ftypNewSize);

    // Write new moov
    let writeOffset = ftypNewSize + (mdatEnd - mdatStart);
    const moovStartOffset = writeOffset;

    newView.setUint32(writeOffset, moovBox.size + moovDelta, false);
    newBytes.set([0x6d, 0x6f, 0x6f, 0x76], writeOffset + 4); // moov
    writeOffset += getBoxHeaderSize(moovBox);

    // Copy and patch mvhd
    newBytes.set(bytes.subarray(mvhdBox.offset, mvhdBox.end), writeOffset);
    const newMvhdContentStart = writeOffset + mvhdHeaderSize;

    // Zero timestamps
    if (mvhdVersion === 0) {
        newView.setUint32(newMvhdContentStart + 4, 0, false); // creation_time
        newView.setUint32(newMvhdContentStart + 8, 0, false); // modification_time
        newView.setUint32(newMvhdContentStart + 12, newTimescale, false);
        newView.setUint32(newMvhdContentStart + 16, newMvhdDuration, false);
    }

    writeOffset += mvhdBox.size;

    // Process tracks
    for (const track of tracks) {
        // Copy trak
        newBytes.set(
            bytes.subarray(
                track.trakBox.offset,
                track.trakBox.offset + getBoxHeaderSize(track.trakBox),
            ),
            writeOffset,
        );
        const trakStartOffset = writeOffset;
        writeOffset += getBoxHeaderSize(track.trakBox);

        // Copy and patch tkhd
        newBytes.set(
            bytes.subarray(track.tkhdBox.offset, track.tkhdBox.end),
            writeOffset,
        );
        const newTkhdContentStart =
            writeOffset + getBoxHeaderSize(track.tkhdBox);
        const tkhdVersion =
            bytes[track.tkhdBox.offset + getBoxHeaderSize(track.tkhdBox)];

        if (tkhdVersion === 0) {
            newView.setUint32(newTkhdContentStart + 4, 0, false); // creation_time
            newView.setUint32(newTkhdContentStart + 8, 0, false); // modification_time
            newView.setUint32(
                newTkhdContentStart + 20,
                track.newTkhdDuration,
                false,
            );
        }

        writeOffset += track.tkhdBox.size;

        // Copy mdia
        newBytes.set(
            bytes.subarray(
                track.mdiaBox.offset,
                track.mdiaBox.offset + getBoxHeaderSize(track.mdiaBox),
            ),
            writeOffset,
        );
        writeOffset += getBoxHeaderSize(track.mdiaBox);

        // Copy and patch mdhd
        newBytes.set(
            bytes.subarray(track.mdhdBox.offset, track.mdhdBox.end),
            writeOffset,
        );
        const newMdhdContentStart =
            writeOffset + getBoxHeaderSize(track.mdhdBox);
        const mdhdVersion =
            bytes[track.mdhdBox.offset + getBoxHeaderSize(track.mdhdBox)];

        if (mdhdVersion === 0) {
            newView.setUint32(newMdhdContentStart + 4, 0, false); // creation_time
            newView.setUint32(newMdhdContentStart + 8, 0, false); // modification_time
            newView.setUint32(
                newMdhdContentStart + 16,
                track.newMdhdDuration,
                false,
            );
            newView.setUint16(newMdhdContentStart + 20, 0x15c7, false); // language: eng
        }

        writeOffset += track.mdhdBox.size;

        // Copy minf
        newBytes.set(
            bytes.subarray(
                track.minfBox.offset,
                track.minfBox.offset + getBoxHeaderSize(track.minfBox),
            ),
            writeOffset,
        );
        writeOffset += getBoxHeaderSize(track.minfBox);

        // Copy stbl
        newBytes.set(
            bytes.subarray(
                track.stblBox.offset,
                track.stblBox.offset + getBoxHeaderSize(track.stblBox),
            ),
            writeOffset,
        );
        writeOffset += getBoxHeaderSize(track.stblBox);

        // Copy and patch stts
        const sttsHeaderSize = getBoxHeaderSize(track.sttsBox);
        const sttsContentStart = track.sttsBox.offset + sttsHeaderSize;
        const newSttsContentStart = writeOffset + sttsHeaderSize;

        newView.setUint32(writeOffset, track.sttsBox.size + 8, false);
        newBytes.set([0x73, 0x74, 0x74, 0x73], writeOffset + 4); // stts
        writeOffset += sttsHeaderSize;

        newView.setUint32(newSttsContentStart, 0, false); // version + flags
        newView.setUint32(
            newSttsContentStart + 4,
            track.newSttsEntryCount,
            false,
        );
        writeOffset += 8;

        // Copy stts entries and double sample_delta
        for (let i = 0; i < track.sttsEntryCount; i++) {
            const sampleCount = view.getUint32(
                sttsContentStart + 8 + i * 8,
                false,
            );
            const sampleDelta = view.getUint32(
                sttsContentStart + 12 + i * 8,
                false,
            );

            newView.setUint32(writeOffset, sampleCount, false);
            newView.setUint32(writeOffset + 4, sampleDelta * 2, false);
            writeOffset += 8;
        }

        // Add extra stts entry
        const avgDelta = Math.round(
            (track.actualDuration * 2) / track.sttsEntryCount,
        );
        newView.setUint32(writeOffset, 1, false);
        newView.setUint32(writeOffset + 4, avgDelta, false);
        writeOffset += 8;

        // Update stbl size
        const stblEndOffset = writeOffset;
        const stblSize =
            stblEndOffset - (stblEndOffset - track.stblBox.size - 8);
        newView.setUint32(
            stblEndOffset -
                track.stblBox.size -
                8 -
                track.minfBox.size -
                track.mdhdBox.size -
                track.tkhdBox.size -
                getBoxHeaderSize(track.trakBox) -
                getBoxHeaderSize(track.mdiaBox) -
                getBoxHeaderSize(track.minfBox) -
                getBoxHeaderSize(track.stblBox),
            stblSize,
            false,
        );
    }

    return {
        success: true,
        newBytes,
        newFileSize,
    };
}
