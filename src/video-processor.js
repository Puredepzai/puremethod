// Barrel re-export — each feature in its own module under src/video/
export { destroyFFmpegInstance, getFFmpeg, resolveInputExtension } from "./video/ffmpeg-manager.js";
export { runVFI } from "./video/vfi-engine.js";
export { runHDR } from "./video/hdr-engine.js";
export { extractMovThumbnail, extractThumbnailFromInstance } from "./video/thumbnail-utils.js";
