# Changelog

All notable changes to the NoBlur project are documented in this file.

## [2.6.0] - 2026-07-01

### Added
- Reprocess button when settings change after completion (no re-upload needed)
- Retry Failed button for error files
- Single-pass VFI+HDR pipeline (prevents OOM)
- Modular `src/video/` (vfi-engine, hdr-engine, ffmpeg-manager, thumbnail-utils)

### Changed
- VFI-only reverted to H.264 (`libx264 fast CRF20`) — lower WASM memory than HEVC
- Audio stream copy (`-c:a copy`) on all pipelines
- Thumbnail extraction moved after `readFile` to reduce peak memory

### Fixed
- VFI OOM on 1080p videos (H.264 encoder uses less WASM heap)
- Settings checkbox/resolution changes not updating button state

## [2.5.0] - 2026-06-18

**HDR10 Conversion Pipeline + Unified HEVC Encoding**

### Added
- SDR to HDR10 conversion via PQ transfer (`smpte2084`) with BT.2020 color space
- Tone expansion filters: `eq=brightness=0.20:contrast=1.25` + `zscale` PQ transfer
- HEVC 10-bit HDR output (libx265, preset fast, CRF 18, maxrate 20M, bufsize 40M) with full HDR10 metadata (master-display, max-cll=1000,400)
- HEVC 8-bit VFI output (libx265, preset ultrafast, CRF 20) for WASM memory safety
- Two-stage VFI+HDR pipeline (sequential FFmpeg instances to prevent WASM OOM)
- HDR preview thumbnail extraction from FFmpeg instance
- Resolution selector enabled for HDR mode
- MOV input auto re-encodes PCM audio to AAC 256k
- FFmpeg exec exit code validation and output file size verification
- Deduplicated system log messages (removed double engine load, redundant progress messages)


## [2.4.0] - 2026-06-18

**Pipeline Simplification — Single-Pass Frame Density Inflation**

- Confirmed: Frame Density Inflation alone bypasses TikTok recompression
- Non-Interpolation path reduced from 7 passes to 1 (container normalize + inflate)
- Removed: ZeroLoss Track Bypass (`rebuildWithElstBypass`), Quantum Matrix (`patchMvhdMatrix`), Udta Strip (`stripUdtaAtom`), Tkhd Matrix Reset (`stripTkhdMatrix`), Comment Udta Injection (`injectCommentUdta`)
- Deleted `src/mp4-strip.mjs` (3 unused exports) and `src/mp4-patches.mjs` (3 unused exports including internal `buildEdtsAtom`)
- Pipeline is now: `normalizeContainer` → `inflateSampleTableVideo(10x)` → download

## [2.3.0] - 2026-06-17

- VFI audio now uses `-c:a copy` (preserves original, faster processing)
- Default density multiplier changed from 5x to 10x
- `stripUdtaAtom()` force-applies (creates empty udta if missing for consistency)

## [2.2.0] - 2026-06-17

**Major Refactor — No FFmpeg Re-encode in Main Pipeline**

- Main path now uses pure binary patching only (preserves 100% video quality, 10-100x faster)
- FFmpeg lazy-loaded only when VFI enabled
- Fixed critical chunk offset corruption in `normalizeContainer()` for streaming-optimized MP4s
- Added VFR, co64, and codec-aware support to frame density inflation
- Added rotation preservation, timescale-aware ELST, and container normalization
- Moved resolution selector to VFI panel, updated modal text dynamically
- Removed dead code (transform-utils.mjs, static FFmpeg imports, unused variables)
- Infrastructure: Playwright → devDependencies, FFmpeg → dependencies, Biome pinned

## [2.1.0] - 2026-06-17

### Added
- **Hybrid Interpolation Pipeline:** When interpolation is enabled, the VFI engine runs first to produce a 60fps video, then the output is fed into the full 7-pass non-interpolation pipeline (CBR re-encode + binary patches). This ensures VFI output gets the same TikTok bypass treatment as the standard path.
- **FFmpeg Instance Reset:** After VFI completes, the FFmpeg instance is destroyed and recreated for the re-encode pipeline to prevent stale WASM state errors.

### Changed
- **Interpolation Resolution:** VFI now uses the output resolution selector (1080p / 2K) directly, eliminating the need for metadata extraction.
- **Container Dimension Parser:** Interpolation path now uses `getDimensionsFromMp4Container()` to read width/height from the MP4 container instead of `getVideoDurationAndResolution()`, reducing overhead.
- **Removed Duration Guard:** The 30-second video duration limit has been removed. Videos of any length are now processed.
- **Simplified VFI Encoding:** Removed codec detection logic. VFI now hardcodes libx264 encoder, matching the 7-pass pipeline.

### Removed
- **Dead Code Cleanup:** Removed unused functions `CODEC_ENCODER_MAP`, `probeSourceFps()`, `probeInputCodec()`, and `execWithEncoder()`.

### Fixed
- **Stale FFmpeg Instance:** Fixed intermittent errors when running re-encode after VFI by resetting the FFmpeg instance between stages.
- **Modal Scroll Lock:** All modals (TikTok, VFI) now properly lock background scroll on mobile and desktop.
- **TikTok Modal Button Alignment:** Fixed "Open TikTok Studio" button text centering on mobile.
- **Changelog Scroll Isolation:** Added `overscroll-behavior: contain` to prevent scroll-through in the changelog panel.

### UI/UX
- **Custom Scrollbar:** Global scrollbar styled to 2px width with theme-colored thumb.
- **Changelog Panel Position:** Moved to bottom-right corner with slide-in animation from right to left.

## [2.0.0] - 2026-06-16

### Added
- **TikTok Frame Density Bypass:** Non-Interpolation path inflates the MP4 sample table — a clip is rewritten to declare more virtual frames (real samples kept + dummy 8-byte samples whose chunk offsets point to a safe padding region at EOF). TikTok detects this as high-density content and skips heavy recompression, preserving original visual quality.
- **Selectable Density Multiplier (5x default):** The inflation multiplier is configurable. 5x is the confirmed sweetspot — it passes TikTok compression while keeping the dummy-frame tail (and the brief end-of-video freeze) short. 10x also works but produces a longer freeze.
- **Output Resolution Selector (1080p / 2K):** Output can be scaled to 1080p or 2K (1440p) via a UI dropdown. Bitrate auto-scales with resolution — 1080p uses 14261k, 2K uses 25000k. Both confirmed to bypass TikTok compression.
- **Modular Binary Patching Architecture:** Extracted all MP4 binary patching functions from `app.js` into four dedicated ES modules under `src/`.
- **7-Pass Non-Interpolation Pipeline:** Expanded from 3 passes to 7 passes.
- **Aligned Interpolation Pipeline:** The 60fps VFI path now shares the same metadata treatment — timescale 90000, AAC 250k audio, udta strip, tkhd matrix reset, and comment udta injection.
- **H.264 Output Profile:** Switched Non-Interpolation encoder from libx265 CRF 18 to libx264 CBR, Main profile Level 4.2, matching the reference output profile that bypasses TikTok compression.
- **MP4 Container Dimension Parser:** Added `getDimensionsFromMp4Container` to read video width/height/rotation directly from the `tkhd` box binary.
- **Output Thumbnail Capture:** History thumbnails are now captured from the processed output buffer instead of the original input file.
- **Screen Wake Lock:** The screen stays awake during processing on supported mobile browsers.
- **Upload to TikTok Studio Button:** Added a direct link to TikTok Studio web upload, with a mobile-only modal guiding users to enable desktop mode first.

### Changed
- **Non-Interpolation Output Format:** Replaced libx265 CRF encoding with libx264 CBR pipeline.
- **Rotation Handling:** Removed `-noautorotate` FFmpeg flag. FFmpeg now bakes rotation metadata into pixel data during encode.
- **UI Copy & Layout:** Updated header subtitle and system stats to reflect the re-encode + frame density engine.

### Fixed
- **Audio Corruption After Inflation:** Fixed critical bug where audio chunk offsets were not shifted after moov expansion during sample table inflation.
- **Portrait/Landscape Detection for HEVC:** Container-level dimension parsing now correctly identifies orientation for HEVC inputs.

## [1.4.0] - 2026-06-16

### Added
- **Adaptive Rotation Scaling:** Interpolation OFF path now detects video orientation and applies adaptive scaling.
- **Full 3-Pass Pipeline for Non-VFI:** Extended the interpolation OFF path from 1-pass to 3-pass architecture.

### Changed
- **Container Reencode (Pass 1/3):** Clarified terminology — the FFmpeg pass performs re-encoding, not remuxing.

## [1.3.0] - 2026-06-15

### Changed
- **FFmpeg-Native Container Reencode:** Added FFmpeg.wasm re-encoding pass using libx265 with CRF 18.
- **Video Timing Normalization:** Uses `setts=ts='2*TS'` to convert 60fps source to 30fps playback.
- **Audio Timing Normalization:** Synchronizes audio duration with the re-encoded video duration.
- **Metadata Strip:** Strips all source metadata including GPS location, device identifiers.
- **Track Timescale Lock:** Normalizes the video track timescale to the standard 90kHz value.
- **VFI Path Preserved:** The 60fps VFI interpolation path retains the original ZeroLoss + Quantum Matrix pipeline.

## [1.2.0] - 2026-05-26

### Added
- **64-Bit Edit List Support:** Dynamically writes version 1 `elst` boxes with 64-bit track durations.
- **Duplicate Upload Warning Notice:** Visible log alerts inside `addFiles` for duplicate files.
- **Same-Codec Output Alignment:** Matches output encoder/codec properties with the detected input codec.
- **Fast Motion-Compensated VFI:** Upgraded from linear blending to bilateral motion-compensated interpolation.
- **VFI Workload Lightening:** Integrated `mpdecimate` filters to drop duplicate frames prior to interpolation.

### Fixed
- **Active VFI Worker Interruption:** Instant termination of active WebAssembly worker threads on cancellation.
- **Portrait Video Rotation Protection:** Skips display matrix patching if a non-identity matrix is present.
- **Stream-Specific Codec Probing:** Corrected input codec detection to target exact video stream logs.
- **Lightweight DB Size Audits:** Cursor-based IndexedDB storage footprint calculation.

## [1.1.0] - 2026-05-25

### Added
- **60FPS Hybrid Interpolator (Beta):** Client-side video frame rate interpolation using Web Worker-based FFmpeg.wasm.
- **Vite Dev Server COOP/COEP Headers:** Cross-origin isolation natively on localhost.
- **Hardware Decoder Memory Guard:** Explicitly releases `<video>` memory to prevent tab crashes.
- **10-Second Metadata Timeout:** Strict timeout limits to prevent hangs on corrupted media files.
- **Loopback Service Worker Bypass:** Proactive cleanup sequence for sticky service worker headers.

### Fixed
- **FFmpeg Crash State Recovery:** Added `try-catch` resetting to safely reboot the FFmpeg engine on crash.
- **Always-Even & Adaptive Full HD Scaling:** Dynamic portrait/landscape aspect-ratio Full HD boundaries.
- **Safe Database Transactions:** Replaced insecure dynamic indexing with explicit store references.

## [1.0.0] - 2026-05-24

### Added
- **Initial Release:** NoBlur premium container patch utility.
- **ZeroLoss Track Bypass:** Automated metadata parsing injecting `edts`/`elst` atom hierarchy.
- **Quantum Matrix Patch:** Big-endian integer manipulation patching the `mvhd` display matrix.
- **Tactile Neo-Brutalist Layout:** Premium high-contrast dark card interface with flat offset shadows.
- **Local Persistence Storage:** IndexedDB local history tracking with 12-hour pruning and 200MB limit.
