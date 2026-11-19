# ffmpeg slot

Place a static ffmpeg binary here (name it exactly `ffmpeg`, keep the exec bit)
before packaging. It is copied to <userData>/bbvideo/bin on first launch and
prepended to the server PATH so bb-video render scripts find it.

macOS arm64 static builds: https://evermeet.cx/ffmpeg/ or osxexperts.net.
