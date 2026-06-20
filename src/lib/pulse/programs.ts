/**
 * Session Arcs — Hz-over-time programs that give a session a beginning,
 * middle, and end. Pure data + interpolation; the hook drives the engine's
 * smooth setHz() ramps from these curves once per second.
 *
 * Arcs only shape the modulation frequency — the timbre chord stays with the
 * selected state, so an arc never rebuilds the audio graph mid-session.
 */

export interface ArcPoint {
  /** position in the session, 0..1 */
  at: number;
  hz: number;
}

export interface Program {
  key: string;
  label: string;
  desc: string;
  minutes: number;
  points: ArcPoint[];
}

export const PROGRAMS: Program[] = [
  {
    key: "descent",
    label: "Descent",
    desc: "16→10 Hz · settle into deep work",
    minutes: 25,
    points: [
      { at: 0, hz: 16 },
      { at: 0.55, hz: 13 },
      { at: 1, hz: 10 },
    ],
  },
  {
    key: "landing",
    label: "Landing",
    desc: "10→6 Hz · ease out of the day",
    minutes: 10,
    points: [
      { at: 0, hz: 10 },
      { at: 1, hz: 6 },
    ],
  },
  {
    key: "drift",
    label: "Sleep Drift",
    desc: "10→3 Hz · wind down to delta",
    minutes: 20,
    points: [
      { at: 0, hz: 10 },
      { at: 0.4, hz: 6 },
      { at: 1, hz: 3 },
    ],
  },
];

/** Piecewise-linear Hz at `progress` (0..1, clamped) along a program's curve. */
export function hzAt(program: Program, progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  const pts = program.points;
  if (p <= pts[0].at) return pts[0].hz;
  for (let i = 1; i < pts.length; i++) {
    if (p <= pts[i].at) {
      const a = pts[i - 1];
      const b = pts[i];
      const span = b.at - a.at || 1;
      const t = (p - a.at) / span;
      return Math.round((a.hz + (b.hz - a.hz) * t) * 10) / 10;
    }
  }
  return pts[pts.length - 1].hz;
}
