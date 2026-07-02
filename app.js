function playTutorialVideo(videoUrl) {
    tutorialVideo.setAttribute("src", videoUrl);
    tutorialVideoContainer.style.display = "block";
    tutorialPlaceholder.style.display = "none";
}

// ===== YOUTUBE VIDEO URLs =====
const UPLOAD_VIDEO_URL = "https://www.youtube.com/embed/--x7yN3thgI";
const PATCH_VIDEO_URL = "https://www.youtube.com/embed/lT7GCn85VRk";

if (tutorialUploadBtn) {
    tutorialUploadBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        console.log("Upload button clicked, playing:", UPLOAD_VIDEO_URL);
        playTutorialVideo(UPLOAD_VIDEO_URL);
    });
}

if (tutorialPatchBtn) {
    tutorialPatchBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        console.log("Patch button clicked, playing:", PATCH_VIDEO_URL);
        playTutorialVideo(PATCH_VIDEO_URL);
    });
}
