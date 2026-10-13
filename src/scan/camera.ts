import { CARD_ASPECT } from './parse';

/** Card images are normalised to this height before OCR. */
export const CARD_HEIGHT = 1400;

export class Camera {
  private stream: MediaStream | null = null;

  constructor(readonly video: HTMLVideoElement) {
    video.playsInline = true;
    video.muted = true;
  }

  static supported(): boolean {
    return !!navigator.mediaDevices?.getUserMedia && window.isSecureContext;
  }

  get running(): boolean {
    return !!this.stream;
  }

  async start(): Promise<void> {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    this.video.srcObject = this.stream;
    await this.video.play();
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  /** Torch (flash) on phones that expose it. Returns false where unsupported. */
  async setTorch(on: boolean): Promise<boolean> {
    const track = this.stream?.getVideoTracks()[0];
    const caps = track?.getCapabilities?.() as (MediaTrackCapabilities & { torch?: boolean }) | undefined;
    if (!track || !caps?.torch) return false;
    await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
    return true;
  }

  /**
   * Grab the part of the current frame under `guide` (the on-screen card outline). The video
   * is shown with object-fit: cover, so map the guide's screen rect back to video pixels.
   */
  captureGuide(guide: HTMLElement): HTMLCanvasElement {
    const v = this.video;
    const vr = v.getBoundingClientRect();
    const gr = guide.getBoundingClientRect();
    const scale = Math.max(vr.width / v.videoWidth, vr.height / v.videoHeight);
    const offX = (vr.width - v.videoWidth * scale) / 2;
    const offY = (vr.height - v.videoHeight * scale) / 2;
    const sx = (gr.left - vr.left - offX) / scale;
    const sy = (gr.top - vr.top - offY) / scale;
    const sw = gr.width / scale;
    const sh = gr.height / scale;
    return toCardCanvas(v, sx, sy, sw, sh);
  }
}

function toCardCanvas(src: CanvasImageSource, sx: number, sy: number, sw: number, sh: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.height = CARD_HEIGHT;
  c.width = Math.round(CARD_HEIGHT * CARD_ASPECT);
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

/**
 * A photo from the file picker. If it's roughly card-shaped (already cropped, or a catalog
 * scan) use it whole; otherwise take the largest centred card-shaped crop, which matches how
 * people photograph a single card.
 */
export async function canvasFromFile(file: Blob): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  let w = bmp.width;
  let h = bmp.height;
  const landscape = w > h;
  const aspect = w / h;
  // A landscape photo of a portrait card: crop the middle.
  if (landscape || Math.abs(aspect - CARD_ASPECT) > 0.06) {
    if (aspect > CARD_ASPECT) w = h * CARD_ASPECT;
    else h = w / CARD_ASPECT;
  }
  const c = toCardCanvas(bmp, (bmp.width - w) / 2, (bmp.height - h) / 2, w, h);
  bmp.close();
  return c;
}
