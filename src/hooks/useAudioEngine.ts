/**
 * useAudioEngine — thin React wrapper around PulseEngine.
 *
 * The audio graph lives in a ref (PulseEngine), never in state. React state here is
 * ONLY for UI display. Param changes call engine methods imperatively — dragging a
 * slider does NOT re-render the page, it pokes the live audio node.
 *
 * Lifecycle: the context is created lazily on first play and CLOSED on unmount, which
 * prevents the ~6-live-AudioContext leak when navigating in/out of /pulse repeatedly.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { track, trackPlay } from "@/lib/pulse/beacon";
import { PulseEngine } from "@/lib/pulse/engine";
import { clearMediaSession, updateMediaSession } from "@/lib/pulse/mediaSession";
import { PROGRAMS, hzAt, type Program } from "@/lib/pulse/programs";
import { STATES, type StateKey } from "@/lib/pulse/states";

export type SourceKind = "synth" | "track";
export type TrackStatus = "empty" | "decoding" | "loaded" | "error";
export type TimerMinutes = 0 | 25 | 50;

const STORE_KEY = "pulse.v1";

interface Persisted {
  state: StateKey;
  boneOn: boolean;
  depth: number;
  vol: number;
  timer: TimerMinutes;
}

function loadPersisted(): Partial<Persisted> {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
  } catch {
    return {};
  }
}

export function useAudioEngine() {
  const engineRef = useRef<PulseEngine | null>(null);
  const timerRef = useRef<number | null>(null);
  // live mirrors for values the media-session freeze/resume path must read
  // without stale closures
  const remainingRef = useRef<number | null>(null);
  const timerMinRef = useRef<TimerMinutes>(0);
  // an OS/hardware pause stashes the running session here so play resumes it
  const frozenRef = useRef<{
    programKey: string | null;
    remainingMs: number;
    timerMinutes: TimerMinutes;
  } | null>(null);
  // synchronous in-flight guard: start() has real await gaps during which
  // React `playing` is still false — button + media key can both get through
  const startingRef = useRef(false);
  const [persisted] = useState(loadPersisted);

  const [playing, setPlaying] = useState(false);
  const [current, setCurrentState] = useState<StateKey>(persisted.state ?? "deep");
  const [boneOn, setBoneState] = useState<boolean>(persisted.boneOn ?? false);
  const [depth, setDepthState] = useState<number>(persisted.depth ?? 60);
  const [vol, setVolState] = useState<number>(persisted.vol ?? 50);
  const [source, setSource] = useState<SourceKind>("synth");
  const [trackName, setTrackName] = useState<string>("");
  const [trackStatus, setTrackStatus] = useState<TrackStatus>("empty");
  const [timer, setTimerState] = useState<TimerMinutes>(persisted.timer ?? 0);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [sessionDone, setSessionDone] = useState(false);
  const [manualHz, setManualHzState] = useState<number | null>(null);
  const [program, setProgramState] = useState<Program | null>(null);
  // ref mirror so stop/setCurrent/complete can check "is an arc running"
  // without stale-closure issues
  const programRef = useRef<Program | null>(null);
  const setProgram = (p: Program | null) => {
    programRef.current = p;
    setProgramState(p);
  };

  // create engine + apply persisted params on mount; close ctx on unmount
  useEffect(() => {
    const engine = new PulseEngine();
    engine.state = persisted.state ?? "deep";
    engine.boneOn = persisted.boneOn ?? false;
    engine.depth = persisted.depth ?? 60;
    engine.vol = persisted.vol ?? 50;
    engineRef.current = engine;
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
      clearMediaSession();
      void engine.close();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persist = useCallback(() => {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({ state: current, boneOn, depth, vol, timer }),
      );
    } catch {
      /* private mode — non-fatal */
    }
  }, [current, boneOn, depth, vol, timer]);

  // debounce writes so dragging a slider doesn't hammer localStorage every tick
  useEffect(() => {
    const id = window.setTimeout(persist, 300);
    return () => window.clearTimeout(id);
  }, [persist]);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    remainingRef.current = null;
    setRemaining(null);
  }, []);

  const start = useCallback(async () => {
    if (startingRef.current || engineRef.current?.playing) return;
    startingRef.current = true;
    frozenRef.current = null; // a fresh user start abandons any frozen session
    try {
      setSessionDone(false);
      const e = engineRef.current;
      await e?.play();
      setPlaying(true);
      // the D1 beacon: one event per user-initiated play (engine-internal
      // rebuilds on state/track switches never pass through here)
      if (e) {
        trackPlay({
          source: e.useTrack ? "track" : "synth",
          bone: e.boneOn,
          state: e.state,
          hz: e.currentHz,
          program: programRef.current?.key ?? null,
        });
      }
    } finally {
      startingRef.current = false;
    }
  }, []);

  /** Abandon a running arc's Hz drive (keeps whatever is playing, playing). */
  const cancelArc = useCallback(() => {
    if (!programRef.current) return;
    engineRef.current?.setHz(null);
    setManualHzState(null);
    setProgram(null);
  }, []);

  const stop = useCallback(() => {
    engineRef.current?.stop();
    setPlaying(false);
    clearTimer();
    cancelArc();
  }, [clearTimer, cancelArc]);


  const togglePlay = useCallback(() => {
    if (playing) stop();
    else void start();
  }, [playing, start, stop]);

  const setCurrent = useCallback(
    (s: StateKey) => {
      if (programRef.current) {
        // a state pick during an arc abandons the arc (chord switch rebuilds
        // the graph; the arc's Hz drive would fight the new state's default)
        clearTimer();
        cancelArc();
      }
      setCurrentState(s);
      setManualHzState(null); // a fresh state resets any manual Hz override
      if (engineRef.current) engineRef.current.hzOverride = null;
      void engineRef.current?.setState(s);
    },
    [clearTimer, cancelArc],
  );

  const setManualHz = useCallback(
    (hz: number | null) => {
      if (programRef.current) {
        // user takes the wheel: the arc stops driving, session stays open
        clearTimer();
        cancelArc();
      }
      setManualHzState(hz);
      engineRef.current?.setHz(hz);
    },
    [clearTimer, cancelArc],
  );

  const setBone = useCallback((on: boolean) => {
    setBoneState(on);
    if (engineRef.current) {
      engineRef.current.boneOn = on;
      engineRef.current.applyBone();
    }
  }, []);

  const setDepth = useCallback((d: number) => {
    setDepthState(d);
    if (engineRef.current) {
      engineRef.current.depth = d;
      engineRef.current.applyDepth();
    }
  }, []);

  const setVol = useCallback((v: number) => {
    setVolState(v);
    if (engineRef.current) {
      engineRef.current.vol = v;
      engineRef.current.applyVol();
    }
  }, []);

  const chooseSynth = useCallback(() => {
    setSource("synth");
    void engineRef.current?.useSynth();
  }, []);

  const loadFile = useCallback(
    async (file: File) => {
      setSource("track");
      setTrackStatus("decoding");
      setTrackName(file.name);
      try {
        await engineRef.current?.loadTrack(file);
        setTrackStatus("loaded");
      } catch {
        // keep source on "track" so the dropzone stays visible for a retry;
        // engine falls back to synth on its own (useTrack only flips on success)
        setTrackStatus("error");
        toast.error("Couldn't read that file — try another audio file.");
      }
    },
    [],
  );

  // shared session completion: chime → fade out → "session complete" + beacon
  const complete = useCallback(
    (props: Record<string, unknown>) => {
      clearTimer();
      frozenRef.current = null;
      const e = engineRef.current;
      e?.playChime();
      e?.stop();
      setPlaying(false);
      setSessionDone(true);
      cancelArc();
      track("pulse_session_complete", props);
    },
    [clearTimer, cancelArc],
  );

  const setTimerBoth = useCallback((m: TimerMinutes) => {
    timerMinRef.current = m;
    setTimerState(m);
  }, []);

  // countdown runner — resumable: remainingMs may be less than the full span
  const runCountdown = useCallback(
    (minutes: TimerMinutes, remainingMs: number) => {
      const endAt = performance.now() + remainingMs;
      const tick = () => {
        const left = Math.max(0, endAt - performance.now());
        remainingRef.current = left;
        setRemaining(left);
        if (left <= 0) complete({ kind: "timer", minutes });
      };
      tick();
      timerRef.current = window.setInterval(tick, 1000);
    },
    [complete],
  );

  // arc runner — progress derives from the arc's FULL span, so a resumed arc
  // continues its Hz curve exactly where it froze
  const runArc = useCallback(
    (p: Program, remainingMs: number) => {
      setProgram(p);
      const total = p.minutes * 60_000;
      const endAt = performance.now() + remainingMs;
      const tick = () => {
        const left = Math.max(0, endAt - performance.now());
        remainingRef.current = left;
        setRemaining(left);
        const hz = hzAt(p, 1 - left / total);
        engineRef.current?.setHz(hz);
        setManualHzState(hz); // frequency readout + focus chips glide with the arc
        if (left <= 0) complete({ kind: "arc", program: p.key, minutes: p.minutes });
      };
      tick();
      timerRef.current = window.setInterval(tick, 1000);
    },
    [complete],
  );

  // plain session timer (timers and arcs are mutually exclusive)
  const setTimer = useCallback(
    (minutes: TimerMinutes) => {
      clearTimer();
      cancelArc();
      frozenRef.current = null;
      setTimerBoth(minutes);
      if (minutes === 0) return;
      if (!playing) void start();
      runCountdown(minutes, minutes * 60_000);
    },
    [clearTimer, cancelArc, setTimerBoth, playing, start, runCountdown],
  );

  // Session Arcs: a timed session whose Hz follows the program's curve via the
  // engine's smooth setHz ramps — once per second, no graph rebuilds.
  const setProgramByKey = useCallback(
    (key: string | null) => {
      clearTimer();
      cancelArc();
      frozenRef.current = null;
      setTimerBoth(0);
      if (!key) return;
      const p = PROGRAMS.find((x) => x.key === key);
      if (!p) return;
      if (!playing) void start();
      runArc(p, p.minutes * 60_000);
    },
    [clearTimer, cancelArc, setTimerBoth, playing, start, runArc],
  );

  // OS/hardware pause must be RESUMABLE: stash the running session, then stop.
  // Hardware play restores it — a lock-screen pause 20 minutes into a 25-minute
  // arc no longer silently destroys the arc.
  const mediaPause = useCallback(() => {
    const snapshot =
      programRef.current || remainingRef.current != null
        ? {
            programKey: programRef.current?.key ?? null,
            remainingMs: remainingRef.current ?? 0,
            timerMinutes: timerMinRef.current,
          }
        : null;
    stop();
    frozenRef.current = snapshot;
  }, [stop]);

  const mediaPlay = useCallback(() => {
    const f = frozenRef.current;
    frozenRef.current = null;
    void (async () => {
      await start();
      if (!f || f.remainingMs <= 0) return;
      if (f.programKey) {
        const p = PROGRAMS.find((x) => x.key === f.programKey);
        if (p) runArc(p, f.remainingMs);
      } else {
        setTimerBoth(f.timerMinutes);
        runCountdown(f.timerMinutes, f.remainingMs);
      }
    })();
  }, [start, runArc, runCountdown, setTimerBoth]);

  // Quiet Presence: lock-screen metadata + hardware media keys follow the
  // session. Pairs with the engine's MediaStream output shim.
  useEffect(() => {
    updateMediaSession(
      { title: STATES[current].label, playing },
      { onPlay: mediaPlay, onPause: mediaPause },
    );
  }, [playing, current, mediaPlay, mediaPause]);

  // The OS pausing our output element out from under us (earbuds off, incoming
  // call, audio-focus loss) is a pause too — freeze so play resumes the session.
  useEffect(() => {
    const e = engineRef.current;
    if (e) e.onOutputInterrupted = mediaPause;
  }, [mediaPause]);

  return {
    playing,
    togglePlay,
    current,
    setCurrent,
    boneOn,
    setBone,
    depth,
    setDepth,
    vol,
    setVol,
    source,
    chooseSynth,
    trackName,
    trackStatus,
    loadFile,
    timer,
    setTimer,
    remaining,
    sessionDone,
    manualHz,
    setManualHz,
    program,
    setProgramByKey,
  };
}
