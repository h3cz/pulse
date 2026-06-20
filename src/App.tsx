import { useEffect, useRef, useState, type DragEvent } from "react";
import { createPortal } from "react-dom";
import { Helmet } from "react-helmet-async";
import { Brain, Moon, Pause, PictureInPicture2, Play, Upload } from "lucide-react";
import { toast } from "sonner";

import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useAudioEngine } from "@/hooks/useAudioEngine";
import { PROGRAMS } from "@/lib/pulse/programs";
import { FOCUS_STATES, HZ_MAX, HZ_MIN, STATES, type StateKey } from "@/lib/pulse/states";

const GLYPH: Record<string, string> = { deep: "◆", light: "◇", calm: "○" };
const TIMERS = [0, 25, 50] as const;

function fmt(ms: number): string {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function Pulse() {
  const eng = useAudioEngine();
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [mode, setMode] = useState<"focus" | "sleep">("focus");
  const [lastFocus, setLastFocus] = useState<StateKey>("deep");
  const [advanced, setAdvanced] = useState(false);
  const [pipWindow, setPipWindow] = useState<Window | null>(null);
  const sleep = mode === "sleep";
  const pipSupported = typeof window !== "undefined" && "documentPictureInPicture" in window;

  // The focus chip highlight follows the effective frequency, so dragging the Advanced
  // frequency slider auto-selects the matching state button on top.
  const effHz = eng.manualHz ?? STATES[eng.current].hz;
  const nearestFocus = FOCUS_STATES.reduce(
    (best, k) => (Math.abs(STATES[k].hz - effHz) < Math.abs(STATES[best].hz - effHz) ? k : best),
    FOCUS_STATES[0],
  );

  // spacebar = play/pause (the hint promised it; now it's true). Skips form
  // controls and slider thumbs so keyboard interaction there stays native.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // e.repeat guard: a held key would otherwise machine-gun togglePlay
      // (graph churn + one beacon row per repeat)
      if (e.repeat || e.code !== "Space") return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (
        t &&
        (/INPUT|BUTTON|TEXTAREA|SELECT/.test(t.tagName) ||
          t.isContentEditable ||
          t.closest('[role="slider"], [role="radio"], [role="switch"]'))
      )
        return;
      e.preventDefault();
      eng.togglePlay();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [eng]);

  // Make /pulse installable as a standalone desktop app — scope the manifest to this
  // route only so the rest of hecz.dev never offers an "install" prompt.
  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "manifest";
    link.href = "/pulse.webmanifest";
    document.head.appendChild(link);
    return () => link.remove();
  }, []);

  const chooseMode = (m: "focus" | "sleep") => {
    if (m === mode) return;
    setMode(m);
    if (m === "sleep") {
      if (eng.current !== "sleep") setLastFocus(eng.current);
      eng.setCurrent("sleep");
    } else {
      eng.setCurrent(lastFocus);
    }
  };

  const onPick = (f?: File | null) => {
    if (f) void eng.loadFile(f);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    onPick(e.dataTransfer.files?.[0]);
  };

  // Pop the controls into an always-on-top OS window that floats over other apps/tabs
  // (Document Picture-in-Picture). Audio keeps playing from this tab. Chrome/Edge/Brave.
  const openPip = async () => {
    const dpip = (window as unknown as { documentPictureInPicture?: { requestWindow: (o: { width: number; height: number }) => Promise<Window> } }).documentPictureInPicture;
    if (!dpip || pipWindow) return;
    let w: Window;
    try {
      w = await dpip.requestWindow({ width: 320, height: 132 });
    } catch {
      toast.error("Couldn't open the mini-player here — try Chrome, Edge, or Brave.");
      return;
    }
    w.document.title = "Pulse";
    const fonts = w.document.createElement("link");
    fonts.rel = "stylesheet";
    fonts.href =
      "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap";
    w.document.head.appendChild(fonts);
    const style = w.document.createElement("style");
    style.textContent =
      "*{box-sizing:border-box;margin:0}body{height:100vh;background:#09090F;color:#F2F2F2;font-family:'JetBrains Mono',monospace;display:flex;align-items:center;gap:14px;padding:0 16px;overflow:hidden}@keyframes mp-breathe{0%,100%{transform:scale(.9)}50%{transform:scale(1.06)}}button{font-family:inherit}";
    w.document.head.appendChild(style);
    w.addEventListener("pagehide", () => setPipWindow(null));
    setPipWindow(w);
  };

  return (
    <>
      <Helmet>
        <title>pulse — flow that goes where you go | Hecz</title>
        <meta
          name="description"
          content="A focus & calm tool tuned for open-ear and bone-conduction headphones. Modulated ambient audio over a synth pad or your own music. Runs in the browser."
        />
        <link rel="canonical" href="https://hecz.dev/pulse" />
      </Helmet>

      <style>{`
        @keyframes pulse-breathe {0%,100%{transform:scale(.86);filter:saturate(.9)}50%{transform:scale(1.04);filter:saturate(1.1)}}
        @keyframes pulse-ring {0%,100%{transform:scale(.7);opacity:.5}50%{transform:scale(1.18);opacity:0}}
        @keyframes pulse-eq {0%,100%{transform:scaleY(.3)}50%{transform:scaleY(1)}}
        .pulse-orb{animation:pulse-breathe var(--breath,8s) ease-in-out infinite}
        .pulse-ring{animation:pulse-ring var(--breath,8s) ease-in-out infinite}
        .pulse-paused .pulse-orb{animation-play-state:paused;filter:saturate(.4) brightness(.7)}
        .pulse-paused .pulse-ring{animation-play-state:paused;opacity:.12}
        @media (prefers-reduced-motion: reduce){
          .pulse-orb,.pulse-ring,.pulse-eq-bar{animation:none!important}
          .pulse-playing .pulse-orb{filter:saturate(1.1);box-shadow:0 0 70px 10px rgba(139,125,168,.5)}
        }
      `}</style>

      <div
        className={`dark min-h-screen w-full flex flex-col items-center text-[#F2F2F2] px-5 pt-10 pb-16 transition-colors duration-700 ${
          sleep ? "bg-[#05050a]" : "bg-[#09090F]"
        } ${eng.playing ? "pulse-playing" : "pulse-paused"}`}
      >
        <div className="w-full max-w-[520px] flex flex-col items-center">
          <a
            href="https://hecz.dev"
            className="self-start mb-3 font-mono text-[11px] tracking-[0.08em] text-[#9a93a6]/70 transition-colors hover:text-[#F2F2F2]"
          >
            ← hecz.dev
          </a>

          {/* wordmark */}
          <header className="text-center mb-7">
            <div className="font-mono font-bold tracking-[0.42em] text-[13px] text-[#B0A3C4] pl-[0.42em]">
              PULSE
            </div>
            <div className="italic font-display text-[17px] text-[#9a93a6] mt-2">
              flow that goes where you go
            </div>
          </header>

          {/* breathing orb */}
          <div
            className="relative grid place-items-center my-2 mb-7"
            style={{ width: 230, height: 230, ["--breath" as string]: `${STATES[eng.current].breath}s` }}
          >
            <div className="pulse-ring absolute inset-0 rounded-full border border-[#8B7DA8]/20" />
            <div
              className="pulse-ring absolute inset-0 rounded-full border border-[#8B7DA8]/20"
              style={{ animationDelay: "-2.6s" }}
            />
            <div
              className="pulse-ring absolute inset-0 rounded-full border border-[#8B7DA8]/20"
              style={{ animationDelay: "-5.2s" }}
            />
            <div
              className="pulse-orb rounded-full"
              style={{
                width: 160,
                height: 160,
                background: sleep
                  ? "radial-gradient(circle at 38% 32%, #8079b3, #5b5590 42%, #211d39 100%)"
                  : "radial-gradient(circle at 38% 32%, #B0A3C4, #8B7DA8 42%, #463c5e 100%)",
                boxShadow: sleep
                  ? "0 0 50px 4px rgba(91,85,144,.3), inset 0 0 40px rgba(0,0,0,.4)"
                  : "0 0 60px 6px rgba(139,125,168,.35), inset 0 0 40px rgba(0,0,0,.3)",
              }}
            />
            {eng.playing && (
              <div className="absolute font-mono text-[10px] tracking-[0.22em] text-[#F2F2F2]/85">
                {STATES[eng.current].label.toUpperCase()} · PLAYING
              </div>
            )}
          </div>

          {/* mode: focus vs sleep */}
          <div className="flex gap-2 w-full mb-4">
            <ModeBtn active={!sleep} onClick={() => chooseMode("focus")}>
              <Brain size={14} /> Focus
            </ModeBtn>
            <ModeBtn active={sleep} onClick={() => chooseMode("sleep")}>
              <Moon size={14} /> Sleep
            </ModeBtn>
          </div>

          {/* state picker (focus) or sleep readout */}
          {sleep ? (
            <div className="w-full mb-5 rounded-2xl border border-[#5b5590]/30 bg-[#5b5590]/[0.08] py-5 text-center">
              <div className="font-display text-[16px] font-medium">Sleep</div>
              <div className="font-mono text-[11px] text-[#9a93a6] mt-1">
                {eng.manualHz ?? STATES.sleep.hz} Hz · delta · wind down
              </div>
            </div>
          ) : (
            <ToggleGroup
              type="single"
              value={nearestFocus}
              onValueChange={(v) => v && eng.setCurrent(v as StateKey)}
              className="grid grid-cols-3 gap-2.5 w-full mb-5"
            >
              {FOCUS_STATES.map((key) => (
                <ToggleGroupItem
                  key={key}
                  value={key}
                  className="h-auto flex-col gap-1 rounded-2xl border border-[#8B7DA8]/20 bg-white/[0.03] py-4 px-2.5 data-[state=on]:border-[#8B7DA8] data-[state=on]:bg-[#8B7DA8]/15 hover:bg-[#8B7DA8]/10"
                >
                  <span className="text-[22px] leading-none">{GLYPH[key]}</span>
                  <span className="font-display text-[15px] font-medium">{STATES[key].label}</span>
                  <span className="font-mono text-[10px] text-[#9a93a6]">
                    {STATES[key].hz} Hz · {STATES[key].band}
                  </span>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          )}

          {/* play */}
          <button
            onClick={eng.togglePlay}
            aria-label={eng.playing ? "Pause" : "Play"}
            aria-pressed={eng.playing}
            className="my-1.5 mb-6 grid h-[74px] w-[74px] place-items-center rounded-full text-[#09090F] transition-transform hover:scale-105 active:scale-95"
            style={{
              background: "linear-gradient(145deg,#B0A3C4,#8B7DA8)",
              boxShadow: "0 10px 30px -8px rgba(139,125,168,.6)",
            }}
          >
            {eng.playing ? <Pause size={26} fill="currentColor" /> : <Play size={26} fill="currentColor" />}
          </button>

          {/* controls */}
          <div className="w-full rounded-[20px] border border-[#8B7DA8]/15 bg-white/[0.03] p-5 flex flex-col gap-5">
            {/* bone */}
            <div className="flex items-center justify-between gap-3.5 rounded-[14px] border border-[#7e9477]/25 bg-[#7e9477]/[0.08] p-3.5">
              <div className="flex flex-col gap-1">
                <div className="font-display font-semibold text-[15px] flex items-center gap-2">
                  🦴 Bone Conduction Mode
                </div>
                <div className="font-mono text-[12px] leading-relaxed text-[#9a93a6] max-w-[280px]">
                  {eng.boneOn
                    ? "ON · bass trimmed, mids boosted for open-ear"
                    : "OFF · full-range, made for over/in-ear"}
                </div>
              </div>
              <Switch checked={eng.boneOn} onCheckedChange={eng.setBone} aria-label="Bone conduction mode" />
            </div>

            {/* source */}
            <div>
              <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-[#9a93a6] mb-2.5">
                Sound Source
              </div>
              <div className="flex gap-2">
                <SourceBtn active={eng.source === "synth"} onClick={eng.chooseSynth}>
                  ◈ Synth pad
                </SourceBtn>
                <SourceBtn
                  active={eng.source === "track"}
                  onClick={() => (eng.trackStatus === "loaded" ? undefined : fileRef.current?.click())}
                >
                  ♪ Your track
                </SourceBtn>
              </div>

              {eng.source === "track" && (
                <div className="mt-2.5">
                  {eng.trackStatus === "decoding" ? (
                    <div className="h-[52px] rounded-[14px] bg-[#8B7DA8]/10 animate-pulse grid place-items-center font-mono text-[12px] text-[#9a93a6]">
                      decoding {eng.trackName}…
                    </div>
                  ) : eng.trackStatus === "loaded" ? (
                    <div className="flex items-center gap-3 rounded-[14px] border border-[#8B7DA8]/20 bg-white/[0.03] px-4 py-3">
                      <div className="flex items-end gap-[3px] h-5">
                        {[0, 1, 2, 3].map((i) => (
                          <span
                            key={i}
                            className="pulse-eq-bar w-[3px] bg-[#B0A3C4] rounded-full origin-bottom"
                            style={{
                              height: "100%",
                              animation: eng.playing
                                ? `pulse-eq ${0.6 + i * 0.18}s ease-in-out infinite`
                                : "none",
                              opacity: eng.playing ? 1 : 0.4,
                            }}
                          />
                        ))}
                      </div>
                      <span className="font-mono text-[12px] truncate text-[#F2F2F2]/85">{eng.trackName}</span>
                      <button
                        onClick={() => fileRef.current?.click()}
                        className="ml-auto font-mono text-[11px] text-[#9a93a6] hover:text-[#F2F2F2]"
                      >
                        change
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => fileRef.current?.click()}
                      onDragOver={(e) => {
                        e.preventDefault();
                        setDragOver(true);
                      }}
                      onDragLeave={() => setDragOver(false)}
                      onDrop={onDrop}
                      className={`w-full rounded-[14px] border border-dashed px-4 py-5 grid place-items-center gap-1.5 transition-colors ${
                        dragOver ? "border-[#B0A3C4] bg-[#8B7DA8]/10" : "border-[#8B7DA8]/35"
                      }`}
                    >
                      <Upload size={18} className="text-[#9a93a6]" />
                      <span className="font-mono text-[12px] text-[#9a93a6]">
                        drop a track or click to choose
                      </span>
                    </button>
                  )}
                </div>
              )}
              <input
                ref={fileRef}
                type="file"
                accept="audio/*"
                hidden
                onChange={(e) => onPick(e.target.files?.[0])}
              />
            </div>

            {/* neural effect */}
            <CtlSlider
              label="Neural Effect"
              value={eng.depth}
              onChange={eng.setDepth}
              min={10}
              max={100}
            />
            {/* volume */}
            <CtlSlider label="Volume" value={eng.vol} onChange={eng.setVol} min={0} max={100} />

            {/* session */}
            <div>
              <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-[#9a93a6] mb-2.5">
                Session
              </div>
              <div className="flex gap-2">
                {TIMERS.map((m) => (
                  <button
                    key={m}
                    onClick={() => eng.setTimer(m)}
                    className={`flex-1 rounded-xl border px-3 py-2.5 font-mono text-[12px] transition-colors ${
                      eng.timer === m
                        ? "border-[#8B7DA8] text-[#B0A3C4] bg-[#8B7DA8]/10"
                        : "border-[#8B7DA8]/20 text-[#9a93a6] hover:text-[#F2F2F2]"
                    }`}
                  >
                    {m === 0 ? "∞ Open" : `${m} min`}
                  </button>
                ))}
              </div>

              {/* arcs: sessions with a beginning, middle, and end */}
              <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-[#9a93a6] mt-4 mb-2.5">
                Arcs
              </div>
              <div className="flex gap-2">
                {PROGRAMS.map((p) => (
                  <button
                    key={p.key}
                    onClick={() => eng.setProgramByKey(eng.program?.key === p.key ? null : p.key)}
                    title={p.desc}
                    aria-pressed={eng.program?.key === p.key}
                    className={`flex-1 rounded-xl border px-2 py-2.5 font-mono text-[11px] transition-colors ${
                      eng.program?.key === p.key
                        ? "border-[#8B7DA8] text-[#B0A3C4] bg-[#8B7DA8]/10"
                        : "border-[#8B7DA8]/20 text-[#9a93a6] hover:text-[#F2F2F2]"
                    }`}
                  >
                    {p.label} · {p.minutes}m
                  </button>
                ))}
              </div>

              <div className="text-center font-mono text-[13px] text-[#9a93a6] mt-2.5 min-h-4 tracking-[0.1em]" aria-live="polite">
                {eng.sessionDone
                  ? "session complete · nice work"
                  : eng.remaining != null
                    ? `${eng.program ? `${eng.program.label} · ` : ""}${fmt(eng.remaining)} remaining`
                    : ""}
              </div>
            </div>

            {/* advanced: manual Hz */}
            <div className="border-t border-[#8B7DA8]/10 pt-3">
              <button
                onClick={() => setAdvanced((a) => !a)}
                className="font-mono text-[11px] uppercase tracking-[0.08em] text-[#9a93a6] hover:text-[#F2F2F2]"
                aria-expanded={advanced}
              >
                {advanced ? "▾" : "▸"} advanced
              </button>
              {advanced && (
                <div className="mt-3">
                  <div className="flex justify-between font-mono text-[11px] uppercase tracking-[0.08em] text-[#9a93a6] mb-2.5">
                    <span>Frequency</span>
                    <span className="text-[#B0A3C4]">
                      {(eng.manualHz ?? STATES[eng.current].hz).toFixed(1)} Hz
                      {eng.manualHz == null ? " · auto" : ""}
                    </span>
                  </div>
                  <Slider
                    value={[eng.manualHz ?? STATES[eng.current].hz]}
                    onValueChange={(v) => eng.setManualHz(v[0])}
                    min={HZ_MIN}
                    max={HZ_MAX}
                    step={0.5}
                    aria-label="Manual frequency in Hz"
                    className="py-2"
                  />
                  {eng.manualHz != null && (
                    <button
                      onClick={() => eng.setManualHz(null)}
                      className="mt-2 font-mono text-[11px] text-[#9a93a6] hover:text-[#F2F2F2]"
                    >
                      reset to {STATES[eng.current].label} default
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {pipSupported && (
            <button
              onClick={() => (pipWindow ? pipWindow.close() : void openPip())}
              className="mt-5 flex items-center gap-2 rounded-xl border border-[#8B7DA8]/20 px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.08em] text-[#9a93a6] transition-colors hover:text-[#F2F2F2] hover:border-[#8B7DA8]/40"
            >
              <PictureInPicture2 size={13} />
              {pipWindow ? "close mini-player" : "pop out mini-player"}
            </button>
          )}

          <div className="text-center font-mono text-[10px] tracking-[0.12em] text-[#9a93a6]/60 mt-4">
            space to play · settings save automatically
          </div>

          <footer className="mt-7 text-center text-[12px] leading-relaxed text-[#9a93a6] max-w-[420px]">
            A focus &amp; calm <b className="text-[#7e9477] font-semibold">tool</b> — not a medical
            device. Put on your headphones, flip Bone Conduction Mode on, and hear how the engine
            re-tunes itself for an open-ear fit.
          </footer>
        </div>
      </div>

      {pipWindow &&
        createPortal(
          <MiniPlayer
            playing={eng.playing}
            onToggle={eng.togglePlay}
            label={sleep ? "Sleep · delta" : STATES[eng.current].label}
            sleep={sleep}
          />,
          pipWindow.document.body,
        )}
    </>
  );
}

function SourceBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`flex-1 rounded-xl border px-3 py-2.5 font-mono text-[12px] transition-colors ${
        active
          ? "border-[#8B7DA8] text-[#B0A3C4] bg-[#8B7DA8]/10"
          : "border-[#8B7DA8]/20 text-[#9a93a6] hover:text-[#F2F2F2]"
      }`}
    >
      {children}
    </button>
  );
}

function ModeBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`flex-1 flex items-center justify-center gap-2 rounded-xl border px-3 py-2 font-mono text-[12px] uppercase tracking-[0.08em] transition-colors ${
        active
          ? "border-[#8B7DA8] text-[#B0A3C4] bg-[#8B7DA8]/12"
          : "border-[#8B7DA8]/15 text-[#9a93a6] hover:text-[#F2F2F2]"
      }`}
    >
      {children}
    </button>
  );
}

function CtlSlider({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
}) {
  return (
    <div>
      <div className="flex justify-between font-mono text-[11px] uppercase tracking-[0.08em] text-[#9a93a6] mb-2.5">
        <span>{label}</span>
        <span className="text-[#B0A3C4]">{value}%</span>
      </div>
      <Slider
        value={[value]}
        onValueChange={(v) => onChange(v[0])}
        min={min}
        max={max}
        step={1}
        aria-label={label}
        className="py-2"
      />
    </div>
  );
}

/** Compact controls rendered (via portal) inside the Document-PiP floating window. */
function MiniPlayer({
  playing,
  onToggle,
  label,
  sleep,
}: {
  playing: boolean;
  onToggle: () => void;
  label: string;
  sleep: boolean;
}) {
  return (
    <>
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: "50%",
          flex: "none",
          background: sleep
            ? "radial-gradient(circle at 38% 32%, #8079b3, #5b5590 60%, #211d39)"
            : "radial-gradient(circle at 38% 32%, #B0A3C4, #8B7DA8 60%, #463c5e)",
          boxShadow: "0 0 22px rgba(139,125,168,.4)",
          animation: playing ? "mp-breathe 6s ease-in-out infinite" : "none",
          filter: playing ? "none" : "saturate(.4) brightness(.7)",
        }}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 11, letterSpacing: ".2em", color: "#B0A3C4" }}>PULSE</span>
        <span
          style={{
            fontSize: 12,
            color: "#9a93a6",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {label}
        </span>
      </div>
      <button
        onClick={onToggle}
        aria-label={playing ? "Pause" : "Play"}
        style={{
          flex: "none",
          width: 44,
          height: 44,
          borderRadius: "50%",
          border: "none",
          cursor: "pointer",
          color: "#09090F",
          background: "linear-gradient(145deg,#B0A3C4,#8B7DA8)",
          fontSize: 15,
          display: "grid",
          placeItems: "center",
        }}
      >
        {playing ? "❚❚" : "▶"}
      </button>
    </>
  );
}
