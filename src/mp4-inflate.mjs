// ===== TĂNG FPS (NHÂN FRAME) =====
export function inflateSampleTableVideo(inputBytes, inputView, multiplier = 1) {
    // Nếu multiplier <= 1, không làm gì cả
    if (multiplier <= 1) return null;

    const fileSize = inputBytes.length;
    const topBoxes = parseBoxes(inputBytes, inputView, 0, fileSize);
    const moovBox = topBoxes.find((b) => b.type === "moov");
    if (!moovBox) return null;

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
