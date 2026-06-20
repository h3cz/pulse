/**
 * /pulse — state table + pure audio math.
 *
 * Everything in this file is PURE (no Web Audio, no DOM) so it unit-tests in node.
 * The engine (engine.ts) imports these to drive the actual AudioContext graph.
 *
 * The "neural effect" is amplitude modulation at the target Hz — NOT binaural beats.
 * Binaural needs ear isolation; open-ear/bone headphones leak, so AM is the right tool.
 */

export type StateKey = "deep" | "light" | "calm" | "sleep";

export interface PulseState {
  /** modulation rate in Hz (the LFO pulses amplitude at this rate) */
  hz: number;
  /** orb breathing period in seconds — deliberately slow, NEVER the modulation Hz (seizure safety) */
  breath: number;
  /** chord root + intervals for the ambient pad, in Hz */
  chord: [number, number, number];
  label: string;
  band: string;
}

export const STATES: Record<StateKey, PulseState> = {
  deep: { hz: 16, breath: 6, chord: [110, 164.81, 220], label: "Deep Focus", band: "beta" },
  light: { hz: 10, breath: 8, chord: [98, 146.83, 196], label: "Light Focus", band: "alpha" },
  calm: { hz: 6, breath: 11, chord: [82.41, 123.47, 164.81], label: "Calm", band: "theta" },
  // Sleep: delta range (~2-4 Hz), lower + slower. Deferred UI, engine-ready.
  sleep: { hz: 3, breath: 14, chord: [65.41, 98, 130.81], label: "Sleep", band: "delta" },
};

/** States exposed in the MVP focus picker. Sleep ships later. */
export const FOCUS_STATES: StateKey[] = ["deep", "light", "calm"];

/** Manual-Hz mode bounds (advanced disclosure, deferred UI). */
export const HZ_MIN = 2;
export const HZ_MAX = 18;

// ---- pure math (the parameter logic the design doc says to unit-test) ----

/** Bone mode rides a lighter modulation cap so the pulse stays musical through the skull. */
export const depthCap = (boneOn: boolean): number => (boneOn ? 0.55 : 0.85);

/** lfoDepth = neural-effect slider (0..1) scaled by the bone-aware cap. */
export const lfoDepthFor = (depth01: number, boneOn: boolean): number =>
  clamp01(depth01) * depthCap(boneOn);

export interface ToneTargets {
  /** highpass cutoff Hz — trims bass the skull can't carry when bone mode is on */
  hp: number;
  /** lowpass cutoff Hz */
  lp: number;
  /** peaking gain (dB) at ~900 Hz — the bone-conduction sweet spot */
  mid: number;
}

/** Filter targets for the tone chain. Bone ON reshapes for open-ear hardware. */
export const toneTargets = (boneOn: boolean): ToneTargets =>
  boneOn ? { hp: 280, lp: 2200, mid: 6 } : { hp: 60, lp: 2600, mid: 0 };

export const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
