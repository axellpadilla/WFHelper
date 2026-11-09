import { describe, expect, it } from "vitest";

import {
  CAPTURE_MAX_HEIGHT,
  CAPTURE_MAX_WIDTH,
  capCaptureSize,
  scaleCaptureRect,
} from "../../services/captureSize";

describe("capCaptureSize", () => {
  it("keeps frames that already fit", () => {
    expect(capCaptureSize(1920, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(capCaptureSize(1280, 720)).toEqual({ width: 1280, height: 720 });
    expect(capCaptureSize(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it("scales 4K down to 1080p", () => {
    expect(capCaptureSize(3840, 2160)).toEqual({ width: 1920, height: 1080 });
  });

  it("scales 1440p down to 1080p", () => {
    expect(capCaptureSize(2560, 1440)).toEqual({ width: 1920, height: 1080 });
  });

  it("preserves an ultrawide aspect", () => {
    const capped = capCaptureSize(3440, 1440);
    expect(capped.width).toBe(1920);
    expect(capped.height).toBe(804);
    expect(capped.width / capped.height).toBeCloseTo(3440 / 1440, 2);
  });

  it("accepts a custom ceiling", () => {
    expect(capCaptureSize(3840, 2160, { width: 2560, height: 1440 })).toEqual({
      width: 2560,
      height: 1440,
    });
  });

  it("never returns a zero dimension", () => {
    expect(capCaptureSize(0, 0)).toEqual({ width: 1, height: 1 });
    expect(capCaptureSize(Number.NaN, 1080)).toEqual({ width: 1, height: 1080 });
  });

  it("uses the published ceiling", () => {
    expect(CAPTURE_MAX_WIDTH).toBe(1920);
    expect(CAPTURE_MAX_HEIGHT).toBe(1080);
  });
});

describe("scaleCaptureRect", () => {
  it("maps a native window rect onto the capped frame", () => {
    expect(
      scaleCaptureRect(
        { x: 200, y: 100, width: 2000, height: 1000 },
        { width: 3840, height: 2160 },
        { width: 1920, height: 1080 },
      ),
    ).toEqual({ x: 100, y: 50, width: 1000, height: 500 });
  });

  it("leaves a same-size frame untouched", () => {
    expect(
      scaleCaptureRect(
        { x: 40, y: 10, width: 400, height: 250 },
        { width: 480, height: 270 },
        { width: 480, height: 270 },
      ),
    ).toEqual({ x: 40, y: 10, width: 400, height: 250 });
  });

  it("does not divide by zero", () => {
    expect(
      scaleCaptureRect(
        { x: 0, y: 0, width: 10, height: 10 },
        { width: 0, height: 0 },
        { width: 1920, height: 1080 },
      ),
    ).toEqual({ x: 0, y: 0, width: 10, height: 10 });
  });
});
