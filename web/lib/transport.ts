class Transport {
  private audioCtx: AudioContext | null = null;
  private startTime = 0;
  private offset = 0;
  private playing = false;

  get context() {
    if (!this.audioCtx) {
      this.audioCtx = new AudioContext();
    }
    return this.audioCtx;
  }

  play() {
    this.startTime = this.context.currentTime - this.offset;
    this.playing = true;
  }

  pause() {
    this.offset = this.currentTime;
    this.playing = false;
  }

  stop() {
    this.offset = 0;
    this.playing = false;
  }

  get currentTime() {
    if (!this.playing) return this.offset;
    return this.context.currentTime - this.startTime;
  }

  get isPlaying() {
    return this.playing;
  }
}

export const transport = new Transport();
