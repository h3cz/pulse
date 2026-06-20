/**
 * PulseEngine — the Web Audio graph, ported verbatim from the verified prototype.
 *
 * Signal flow:
 *   sources → hp → mid → lp → (dry + reverb) → modGain[LFO] → limiter → master → out
 *
 * React never touches the graph. The hook (useAudioEngine) holds one instance in a ref
 * and calls these methods imperatively. The graph lives here, not in component state.
 *
 * SPA note: unlike the standalone file, this gets mounted/unmounted repeatedly. Chrome
 * caps ~6 live AudioContexts then new AudioContext() throws — so close() MUST run on
 * unmount. See useAudioEngine cleanup.
 */
import {
  STATES,
  type StateKey,
  lfoDepthFor,
  toneTargets,
} from "./states";

interface Nodes {
  master: GainNode;
  modGain: GainNode;
  lfo: OscillatorNode;
  lfoDepth: GainNode;
  hp: BiquadFilterNode;
  mid: BiquadFilterNode;
  lp: BiquadFilterNode;
  oscs: OscillatorNode[];
  noise: AudioBufferSourceNode | null;
  drift: OscillatorNode;
  swelling: OscillatorNode[];
}

export interface PulseEngineOptions {
  /** Inject a context factory for tests; defaults to the real AudioContext. */
  createContext?: () => AudioContext;
}

export class PulseEngine {
  private ctx: AudioContext | null = null;
  private nodes: Nodes | null = null;
  private readonly createCtx: () => AudioContext;

  // live params (the hook keeps React state in sync separately)
  state: StateKey = "deep";
  boneOn = false;
  depth = 60; // 0..100
  vol = 50; // 0..100
  hzOverride: number | null = null;
  useTrack = false;
  playing = false;

  private trackEl: HTMLAudioElement | null = null;
  private trackSrc: MediaElementAudioSourceNode | null = null;
  private trackUrl: string | null = null;

  // Quiet Presence: graph output flows into a MediaStream feeding a hidden
  // <audio> element, so even the synth pad registers as real media with the
  // OS — lock-screen controls, media keys, earbud taps. Falls back to direct
  // ctx.destination where MediaStream audio isn't supported.
  private msDest: MediaStreamAudioDestinationNode | null = null;
  private outEl: HTMLAudioElement | null = null;
  /** marks engine-initiated outEl.pause() so the interruption listener ignores it */
  private expectedPause = false;
  /** single deferred outEl.pause() handle — cleared on every play/stop/close */
  private pauseTimer: number | null = null;
  /**
   * Bumped on every stop/play. Async stop→wait→play rebuilds (setState,
   * loadTrack, useSynth) capture it before their gap and bail if it moved —
   * so a completion or user stop landing inside the gap aborts the restart.
   */
  private gen = 0;
  /**
   * Fires when the OS pauses our output element out from under us (route
   * change, incoming call, audio-focus loss). The hook syncs UI state here.
   */
  onOutputInterrupted: (() => void) | null = null;

  constructor(opts?: PulseEngineOptions) {
    this.createCtx =
      opts?.createContext ??
      (() =>
        new (window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext)());
  }

  get currentHz(): number {
    return this.hzOverride ?? STATES[this.state].hz;
  }

  private ensureCtx(): AudioContext {
    if (!this.ctx) this.ctx = this.createCtx();
    return this.ctx;
  }

  // ---- reverb impulse (generated, no asset) ----
  private makeImpulse(seconds: number, decay: number): AudioBuffer {
    const ctx = this.ensureCtx();
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  /** Hard-stop the live graph immediately (idempotency guard against stacking). */
  private teardownNow(): void {
    const n = this.nodes;
    if (!n) return;
    const safe = (x?: { stop: () => void } | null) => {
      try {
        x?.stop();
      } catch {
        /* already stopped */
      }
    };
    n.oscs.forEach(safe);
    safe(n.noise);
    safe(n.lfo);
    safe(n.drift);
    n.swelling.forEach(safe);
    try {
      n.master.disconnect();
    } catch {
      /* noop */
    }
    if (this.useTrack) {
      try {
        this.trackSrc?.disconnect();
      } catch {
        /* noop */
      }
    }
    this.nodes = null;
  }

  private buildGraph(): void {
    // never stack graphs: if a rapid rebuild beat the fade-out teardown, kill it now
    if (this.nodes) this.teardownNow();
    const ctx = this.ensureCtx();
    const st = STATES[this.state];

    // output stage: modulation → limiter → master
    const master = ctx.createGain();
    master.gain.value = 0; // fade in
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 12;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.004;
    limiter.release.value = 0.25;
    const modGain = ctx.createGain();
    modGain.gain.value = 1;
    modGain.connect(limiter);
    limiter.connect(master);
    let routed = false;
    try {
      if (!this.msDest) {
        this.msDest = ctx.createMediaStreamDestination();
        const el = new Audio();
        el.srcObject = this.msDest.stream;
        el.setAttribute("playsinline", "");
        // The OS pauses media elements on route changes (earbuds off, incoming
        // call, audio-focus loss) WITHOUT firing our media-session handlers.
        // Without this listener the graph would keep "playing" into a dead
        // sink while the UI claims playback — the exact open-ear scenario.
        el.addEventListener("pause", () => {
          if (this.expectedPause) {
            this.expectedPause = false;
            return;
          }
          if (!this.playing) return;
          this.onOutputInterrupted?.();
        });
        this.outEl = el;
      }
      master.connect(this.msDest);
      routed = true;
    } catch {
      this.msDest = null;
      this.outEl = null;
    }
    if (!routed) master.connect(ctx.destination);

    // LFO = the "neural effect" — pulses amplitude at the target Hz
    const lfo = ctx.createOscillator();
    lfo.frequency.value = this.currentHz;
    const lfoDepth = ctx.createGain();
    lfo.connect(lfoDepth);
    lfoDepth.connect(modGain.gain);
    lfo.start();

    // tone filters (Bone Conduction Mode reshapes these)
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 60;
    const mid = ctx.createBiquadFilter();
    mid.type = "peaking";
    mid.frequency.value = 900;
    mid.Q.value = 0.8;
    mid.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 2600;
    hp.connect(mid);
    mid.connect(lp);

    // spatial reverb: dry + wet blend
    const dry = ctx.createGain();
    dry.gain.value = 0.78;
    const wet = ctx.createGain();
    wet.gain.value = 0.42;
    const verb = ctx.createConvolver();
    verb.buffer = this.makeImpulse(2.6, 2.4);
    lp.connect(dry);
    lp.connect(verb);
    verb.connect(wet);
    dry.connect(modGain);
    wet.connect(modGain);

    // slow filter drift so the timbre breathes (evolving, not static)
    const drift = ctx.createOscillator();
    drift.frequency.value = 0.05;
    const driftAmt = ctx.createGain();
    driftAmt.gain.value = 420;
    drift.connect(driftAmt);
    driftAmt.connect(lp.frequency);
    drift.start();

    const oscs: OscillatorNode[] = [];
    const swelling: OscillatorNode[] = [];
    let noise: AudioBufferSourceNode | null = null;

    // SOURCE A: your own track → same chain (modulation + bone EQ ride on top)
    if (this.useTrack && this.trackEl) {
      if (!this.trackSrc) this.trackSrc = ctx.createMediaElementSource(this.trackEl);
      try {
        this.trackSrc.disconnect();
      } catch {
        /* not connected yet */
      }
      this.trackSrc.connect(hp);
    } else {
      // SOURCE B: ambient pad — detuned, panned voices per chord note
      st.chord.forEach((f, i) => {
        ([
          [-0.5, -5],
          [0.5, 4],
          [0, -0.3],
        ] as const).forEach(([pan, det], v) => {
          const o = ctx.createOscillator();
          o.type = i === 0 ? "sine" : "triangle";
          o.frequency.value = f;
          o.detune.value = det;
          const g = ctx.createGain();
          g.gain.value = i === 0 ? 0.15 : 0.07;
          const p = ctx.createStereoPanner();
          p.pan.value = pan;
          o.connect(g);
          g.connect(p);
          p.connect(hp);
          o.start();
          oscs.push(o);

          const slow = ctx.createOscillator();
          slow.frequency.value = 0.03 + 0.02 * ((i + v) % 3);
          const slowAmt = ctx.createGain();
          slowAmt.gain.value = g.gain.value * 0.45;
          slow.connect(slowAmt);
          slowAmt.connect(g.gain);
          slow.start();
          swelling.push(slow);
        });
      });

      // sub for warmth (trimmed in bone mode)
      const sub = ctx.createOscillator();
      sub.type = "sine";
      sub.frequency.value = st.chord[0] / 2;
      const subG = ctx.createGain();
      subG.gain.value = 0.1;
      sub.connect(subG);
      subG.connect(hp);
      sub.start();
      oscs.push(sub);

      // airy noise bed
      const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.035;
      noise = ctx.createBufferSource();
      noise.buffer = buf;
      noise.loop = true;
      const nf = ctx.createBiquadFilter();
      nf.type = "bandpass";
      nf.frequency.value = 1200;
      nf.Q.value = 0.6;
      noise.connect(nf);
      nf.connect(hp);
      noise.start();
    }

    this.nodes = {
      master,
      modGain,
      lfo,
      lfoDepth,
      hp,
      mid,
      lp,
      oscs,
      noise,
      drift,
      swelling,
    };
    this.applyDepth();
    this.applyBone();
    this.applyVol(true);
  }

  applyDepth(): void {
    if (!this.nodes || !this.ctx) return;
    const target = lfoDepthFor(this.depth / 100, this.boneOn);
    this.nodes.lfoDepth.gain.setTargetAtTime(target, this.ctx.currentTime, 0.15);
  }

  applyBone(): void {
    if (!this.nodes || !this.ctx) return;
    const t = this.ctx.currentTime;
    const { hp, lp, mid } = toneTargets(this.boneOn);
    this.nodes.hp.frequency.setTargetAtTime(hp, t, 0.2);
    this.nodes.lp.frequency.setTargetAtTime(lp, t, 0.2);
    this.nodes.mid.gain.setTargetAtTime(mid, t, 0.2);
    this.applyDepth(); // depth cap depends on bone state
  }

  applyVol(instant = false): void {
    if (!this.nodes || !this.ctx || !this.playing) return;
    const v = this.vol / 100;
    this.nodes.master.gain.setTargetAtTime(v * 0.9, this.ctx.currentTime, instant ? 0.6 : 0.1);
  }

  setHz(hz: number | null): void {
    this.hzOverride = hz;
    if (this.nodes && this.ctx) {
      this.nodes.lfo.frequency.setTargetAtTime(this.currentHz, this.ctx.currentTime, 0.1);
    }
  }

  /** Start playback. Resumes a suspended context (iOS/Safari unlock). */
  async play(): Promise<void> {
    this.gen++;
    if (this.pauseTimer) {
      window.clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }
    const ctx = this.ensureCtx();
    if (ctx.state === "suspended") await ctx.resume();
    this.buildGraph();
    this.playing = true;
    if (this.outEl) {
      // must start inside the user gesture so the OS treats it as real media
      try {
        await this.outEl.play();
      } catch {
        // autoplay refused — on the shim path master is connected ONLY to
        // msDest, so a paused element means total silence. Reroute live to
        // the direct output and drop the shim; the next buildGraph retries it.
        try {
          this.nodes?.master.disconnect();
        } catch {
          /* noop */
        }
        try {
          this.nodes?.master.connect(ctx.destination);
        } catch {
          /* noop */
        }
        try {
          if (this.outEl) this.outEl.srcObject = null;
        } catch {
          /* noop */
        }
        this.outEl = null;
        this.msDest = null;
      }
    }
    if (this.useTrack && this.trackEl) {
      try {
        await this.trackEl.play();
      } catch {
        /* autoplay guard — already inside a user gesture, ignore */
      }
    }
    this.applyVol(true);
  }

  /** Stop playback and tear down sources, but keep the context alive for reuse. */
  stop(): void {
    this.gen++;
    if (this.pauseTimer) {
      window.clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }
    if (this.nodes && this.ctx) {
      this.nodes.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.25);
      const n = this.nodes;
      const safeStop = (x?: { stop: () => void } | null) => {
        try {
          x?.stop();
        } catch {
          /* already stopped */
        }
      };
      window.setTimeout(() => {
        n.oscs.forEach(safeStop);
        safeStop(n.noise);
        safeStop(n.lfo);
        safeStop(n.drift);
        n.swelling.forEach(safeStop);
        if (this.useTrack) {
          try {
            this.trackSrc?.disconnect();
          } catch {
            /* noop */
          }
        }
      }, 420);
      // pause the media element well after fade AND a possible completion
      // chime (2.3s) have finished — pausing earlier clips them on the shim
      // path. Single stored handle: a newer stop/play always supersedes it.
      this.pauseTimer = window.setTimeout(() => {
        this.pauseTimer = null;
        if (!this.playing && this.outEl) {
          this.expectedPause = true;
          this.outEl.pause();
        }
      }, 2600);
      this.nodes = null;
    }
    this.playing = false;
    this.trackEl?.pause();
  }

  /** Switch focus state; rebuilds the graph if currently playing. */
  async setState(state: StateKey): Promise<void> {
    this.state = state;
    if (this.playing) {
      this.stop();
      const g = this.gen; // a stop/play landing in the gap aborts this restart
      await new Promise((r) => window.setTimeout(r, 140));
      if (g !== this.gen) return;
      await this.play();
    }
  }

  /**
   * Load a user track; rebuilds if playing. Revokes any previous object URL.
   * Resolves once the file is decodable, rejects on a non-audio / corrupt file
   * (drives the BYO error state in the hook).
   */
  async loadTrack(file: File): Promise<void> {
    if (!this.trackEl) {
      this.trackEl = new Audio();
      this.trackEl.loop = true;
      this.trackEl.crossOrigin = "anonymous";
    }
    const el = this.trackEl;
    if (this.trackUrl) URL.revokeObjectURL(this.trackUrl);
    this.trackUrl = URL.createObjectURL(file);

    await new Promise<void>((resolve, reject) => {
      const ok = () => {
        cleanup();
        resolve();
      };
      const fail = () => {
        cleanup();
        reject(new Error("Could not decode audio file"));
      };
      const cleanup = () => {
        el.removeEventListener("canplaythrough", ok);
        el.removeEventListener("loadeddata", ok);
        el.removeEventListener("error", fail);
      };
      el.addEventListener("canplaythrough", ok, { once: true });
      el.addEventListener("loadeddata", ok, { once: true });
      el.addEventListener("error", fail, { once: true });
      el.src = this.trackUrl as string;
      el.load();
    });

    this.useTrack = true;
    if (this.playing) {
      this.stop();
      const g = this.gen;
      await new Promise((r) => window.setTimeout(r, 160));
      if (g !== this.gen) return;
      await this.play();
    }
  }

  async useSynth(): Promise<void> {
    this.useTrack = false;
    if (this.playing) {
      this.stop();
      const g = this.gen;
      await new Promise((r) => window.setTimeout(r, 160));
      if (g !== this.gen) return;
      await this.play();
    }
  }

  /** Soft single tone for the session-complete cue (generated, no asset). */
  playChime(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.value = STATES[this.state].chord[1] * 2; // a gentle high note from the chord
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.18, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.2);
    o.connect(g);
    g.connect(this.msDest ?? ctx.destination); // via the media shim so it sounds on a locked phone
    o.start(t);
    o.stop(t + 2.3);
  }

  /** Full teardown — closes the context. Call on unmount (prevents the 6-context leak). */
  async close(): Promise<void> {
    this.stop();
    if (this.trackUrl) {
      URL.revokeObjectURL(this.trackUrl);
      this.trackUrl = null;
    }
    if (this.ctx && this.ctx.state !== "closed") {
      try {
        await this.ctx.close();
      } catch {
        /* already closing */
      }
    }
    this.ctx = null;
    this.trackSrc = null;
    this.trackEl = null;
    if (this.pauseTimer) {
      window.clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }
    if (this.outEl) {
      try {
        this.expectedPause = true;
        this.outEl.pause();
        this.outEl.srcObject = null;
      } catch {
        /* noop */
      }
    }
    this.outEl = null;
    this.msDest = null; // belongs to the closed context — rebuild fresh next time
    this.onOutputInterrupted = null;
  }
}
