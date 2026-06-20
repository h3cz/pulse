// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  STATES,
  FOCUS_STATES,
  depthCap,
  lfoDepthFor,
  toneTargets,
  clamp01,
} from "@/lib/pulse/states";

describe("pulse state table", () => {
  test("focus states use the documented frequencies", () => {
    expect(STATES.deep.hz).toBe(16); // beta
    expect(STATES.light.hz).toBe(10); // alpha
    expect(STATES.calm.hz).toBe(6); // theta
  });

  test("sleep mode lands in the delta range (2-4 Hz)", () => {
    expect(STATES.sleep.hz).toBeGreaterThanOrEqual(2);
    expect(STATES.sleep.hz).toBeLessThanOrEqual(4);
  });

  test("every state has a 3-note chord", () => {
    for (const s of Object.values(STATES)) {
      expect(s.chord).toHaveLength(3);
    }
  });

  test("orb breath period is never the modulation Hz (seizure safety)", () => {
    // breath is in seconds; a 6s breath = 0.16 Hz, far below any modulation rate.
    for (const s of Object.values(STATES)) {
      const breathHz = 1 / s.breath;
      expect(breathHz).toBeLessThan(0.5);
    }
  });

  test("MVP exposes exactly the three focus states", () => {
    expect(FOCUS_STATES).toEqual(["deep", "light", "calm"]);
  });
});

describe("modulation depth math", () => {
  test("bone mode caps modulation lighter than over-ear", () => {
    expect(depthCap(true)).toBe(0.55);
    expect(depthCap(false)).toBe(0.85);
  });

  test("lfoDepth scales the slider by the bone-aware cap", () => {
    expect(lfoDepthFor(1, false)).toBeCloseTo(0.85);
    expect(lfoDepthFor(1, true)).toBeCloseTo(0.55);
    expect(lfoDepthFor(0.6, false)).toBeCloseTo(0.51);
  });

  test("lfoDepth clamps out-of-range slider values", () => {
    expect(lfoDepthFor(2, false)).toBeCloseTo(0.85);
    expect(lfoDepthFor(-1, false)).toBe(0);
  });
});

describe("bone-conduction tone targets", () => {
  test("bone ON trims bass and boosts the mid sweet spot", () => {
    expect(toneTargets(true)).toEqual({ hp: 280, lp: 2200, mid: 6 });
  });

  test("bone OFF is full-range flat", () => {
    expect(toneTargets(false)).toEqual({ hp: 60, lp: 2600, mid: 0 });
  });
});

describe("clamp01", () => {
  test("clamps to [0,1]", () => {
    expect(clamp01(-5)).toBe(0);
    expect(clamp01(5)).toBe(1);
    expect(clamp01(0.5)).toBe(0.5);
  });
});
