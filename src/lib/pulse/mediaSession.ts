/**
 * Quiet Presence — OS citizenship for /pulse.
 *
 * Publishes lock-screen metadata and wires hardware media keys / earbud taps
 * to the engine. Pairs with the engine's MediaStream output shim (which makes
 * even the synth pad register as real media on mobile). Every call is guarded:
 * browsers without the API are simply skipped.
 */

export interface MediaSessionHandlers {
  onPlay: () => void;
  onPause: () => void;
}

const ART = [{ src: "/favicon.png", sizes: "256x256", type: "image/png" }];

export function updateMediaSession(
  meta: { title: string; playing: boolean },
  handlers: MediaSessionHandlers,
): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  const ms = navigator.mediaSession;
  try {
    ms.metadata = new MediaMetadata({
      title: meta.title,
      artist: "Pulse — focus & calm",
      album: "hecz.dev/pulse",
      artwork: ART,
    });
    ms.playbackState = meta.playing ? "playing" : "paused";
  } catch {
    /* metadata is progressive enhancement */
  }
  const set = (action: MediaSessionAction, fn: (() => void) | null) => {
    try {
      ms.setActionHandler(action, fn);
    } catch {
      /* action unsupported on this platform */
    }
  };
  set("play", handlers.onPlay);
  set("pause", handlers.onPause);
  set("stop", handlers.onPause);
}

export function clearMediaSession(): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  const ms = navigator.mediaSession;
  try {
    ms.metadata = null;
    ms.playbackState = "none";
  } catch {
    /* noop */
  }
  for (const action of ["play", "pause", "stop"] as MediaSessionAction[]) {
    try {
      ms.setActionHandler(action, null);
    } catch {
      /* noop */
    }
  }
}
