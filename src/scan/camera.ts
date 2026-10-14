import { expandQuad, locateCard, warpCard } from './locate';
import { CARD_ASPECT } from './parse';

/**
 * Card images are normalised to this height before OCR. The bottom-line print is only ~1.5% of
 * the card's height, so keep plenty of pixels.
 */
export const CARD_HEIGHT = 2000;

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
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
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
  /**
   * Grab the card under `guide` (the on-screen outline). The video is shown with object-fit:
   * cover, so map the guide's screen rect back to video pixels, take a margin around it, and look
   * for the card's actual edges there; if they can't be found, use the guide area as is.
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
    // 15% margin each side, clamped to the frame.
    const mx = sw * 0.15;
    const my = sh * 0.15;
    const x0 = Math.max(0, sx - mx);
    const y0 = Math.max(0, sy - my);
    const x1 = Math.min(v.videoWidth, sx + sw + mx);
    const y1 = Math.min(v.videoHeight, sy + sh + my);
    const area = document.createElement('canvas');
    area.width = Math.round(x1 - x0);
    area.height = Math.round(y1 - y0);
    area.getContext('2d')!.drawImage(v, x0, y0, area.width, area.height, 0, 0, area.width, area.height);
    return findCard(area, area.width, area.height) ?? toCardCanvas(v, sx, sy, sw, sh);
  }
}

/** Margin (fraction of the card, each side) kept around a detected card. */
export const CARD_MARGIN = { x: 0.03, y: 0.035 };

function findCard(src: CanvasImageSource, sw: number, sh: number): HTMLCanvasElement | null {
  const quad = locateCard(src, sw, sh);
  if (!quad) return null;
  const out = warpCard(src, sw, sh, expandQuad(quad, CARD_MARGIN.x, CARD_MARGIN.y), Math.round(CARD_HEIGHT * CARD_ASPECT), CARD_HEIGHT);
  out.dataset.margin = 'yes';
  return out;
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
 * A photo from the file picker: find the card in it and straighten it. If no card outline is
 * found, use the photo whole when it's roughly card-shaped (already cropped, or a catalog scan),
 * else the largest centred card-shaped crop.
 */
export async function canvasFromFile(file: Blob): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const aspect = bmp.width / bmp.height;
    // Already exactly card-shaped (a scan, a cropped photo, a catalog image): use it whole. Phone
    // photos are 3:4 (0.75), clearly wider than a Pokémon (0.716) or Yu-Gi-Oh! (0.686) card.
    const cropped = Math.abs(aspect - CARD_ASPECT) < 0.02 || Math.abs(aspect - 59 / 86) < 0.02;
    if (cropped) return toCardCanvas(bmp, 0, 0, bmp.width, bmp.height);
    const found = findCard(bmp, bmp.width, bmp.height);
    if (found) return found;
    let w = bmp.width;
    let h = bmp.height;
    if (aspect > CARD_ASPECT) w = h * CARD_ASPECT;
    else h = w / CARD_ASPECT;
    return toCardCanvas(bmp, (bmp.width - w) / 2, (bmp.height - h) / 2, w, h);
  } finally {
    bmp.close();
  }
}
