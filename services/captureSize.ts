/** Every capture frame is downscaled to at most 1080p before the scanners see
 *  it. Reward titles cap their OCR strip at 720 px, so a larger frame only buys
 *  copies: a 4K desktop otherwise pays for four times the pixels in the
 *  compositor transfer, NativeImage conversions and memory. */

export const CAPTURE_MAX_WIDTH = 1920;
export const CAPTURE_MAX_HEIGHT = 1080;

export interface CaptureSize {
  width: number;
  height: number;
}

/** Aspect-preserving cap. Never upscales and never returns a zero dimension. */
export function capCaptureSize(
  width: number,
  height: number,
  max: CaptureSize = { width: CAPTURE_MAX_WIDTH, height: CAPTURE_MAX_HEIGHT },
): CaptureSize {
  const sourceWidth = Math.max(1, Math.round(Number(width) || 0));
  const sourceHeight = Math.max(1, Math.round(Number(height) || 0));
  const maxWidth = Math.max(1, Math.round(max.width));
  const maxHeight = Math.max(1, Math.round(max.height));
  if (sourceWidth <= maxWidth && sourceHeight <= maxHeight) {
    return { width: sourceWidth, height: sourceHeight };
  }
  const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight);
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}

/** Maps a rect measured on the native frame onto the capped frame. */
export function scaleCaptureRect(
  rect: { x: number; y: number; width: number; height: number },
  native: CaptureSize,
  capped: CaptureSize,
): { x: number; y: number; width: number; height: number } {
  if (!(native.width > 0) || !(native.height > 0)) {
    return {
      x: Math.max(0, Math.round(rect.x)),
      y: Math.max(0, Math.round(rect.y)),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
    };
  }
  const scaleX = capped.width / native.width;
  const scaleY = capped.height / native.height;
  return {
    x: Math.max(0, Math.round(rect.x * scaleX)),
    y: Math.max(0, Math.round(rect.y * scaleY)),
    width: Math.max(1, Math.round(rect.width * scaleX)),
    height: Math.max(1, Math.round(rect.height * scaleY)),
  };
}
