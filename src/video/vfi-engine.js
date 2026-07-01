// ===== CONFIG CHẤT LƯỢNG CAO =====
const CRF = 15;             // Gần lossless (mặc định FFmpeg là 18-20)
const PRESET = "slower";    // Chậm nhưng chất lượng tốt nhất
const MAXRATE = "50M";      // Bitrate tối đa
const BUFSIZE = "100M";     // Buffer cho bitrate
const PIX_FMT = applyHDR ? "yuv420p10le" : "yuv420p";
const ENCODER = applyHDR ? "libx265" : "libx264";

// ===== GHOST MODE (BYPASS NẾU CRASH) =====
const GHOST_MODE = false;   // Set TRUE để chạy ảo, FALSE để xử lý thật

// ===== FILTER TỐI ƯU =====
const filter = applyHDR
    ? `minterpolate=fps=60:mi_mode=mci:me_mode=bidir:search_param=8,eq=brightness=0.10:contrast=1.30:saturation=1.10,zscale=transfer=linear,zscale=transfer=smpte2084:primaries=bt2020:matrix=bt2020nc,format=yuv420p10le`
    : `minterpolate=fps=60:mi_mode=mci:me_mode=bidir:search_param=8,eq=brightness=0.05:contrast=1.20:saturation=1.05,format=yuv420p`;

// ===== BUILD ARGS =====
const args = applyHDR ? [
    "-i", inputName,
    "-vf", filter,
    "-c:v", ENCODER,
    "-preset", PRESET,
    "-crf", String(CRF),
    "-pix_fmt", PIX_FMT,
    "-x265-params", "hdr10=1:repeat-headers=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50):max-cll=1000,400",
    "-c:a", "copy",
    "-video_track_timescale", "90000",
    "-threads", String(threads),
    "-maxrate", MAXRATE,
    "-bufsize", BUFSIZE,
    outputName,
] : [
    "-i", inputName,
    "-vf", filter,
    "-c:v", ENCODER,
    "-preset", PRESET,
    "-crf", String(CRF),
    "-pix_fmt", PIX_FMT,
    "-c:a", "copy",
    "-video_track_timescale", "90000",
    "-threads", String(threads),
    "-maxrate", MAXRATE,
    "-bufsize", BUFSIZE,
    outputName,
];

// ===== CHUNK PROCESSING =====
const fileSizeMB = file.size / (1024 * 1024);
const useChunk = fileSizeMB > 100; // Chỉ chunk khi > 100MB

if (useChunk) {
    // ... (giữ nguyên chunk cũ)
} else {
    if (logMessage) logMessage(`Encoding with CRF ${CRF}, preset ${PRESET}...`, "info");
    const ret = await instance.exec(args);
    if (ret !== 0 && ret !== undefined) {
        throw new Error(`FFmpeg exited with code ${ret}`);
    }
}
