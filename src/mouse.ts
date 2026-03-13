import { useEffect, useRef } from "react";
import { useStdin } from "ink";

export interface MouseEvent {
  button: number; // 0=left, 1=middle, 2=right
  x: number;      // 1-based column
  y: number;      // 1-based row
  type: "press" | "release" | "move";
}

type MouseHandler = (event: MouseEvent) => void;

const MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

/**
 * Enable SGR mouse tracking and parse click events.
 * Uses Ink's internal event emitter to receive input events,
 * avoiding conflicts with Ink's stdin stream handling.
 */
export function useMouse(handler: MouseHandler): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  // eslint-disable-next-line @typescript-eslint/naming-convention
  const { internal_eventEmitter } = useStdin();

  useEffect(() => {
    // Enable SGR extended mouse mode
    process.stdout.write("\x1b[?1000h"); // enable mouse press/release
    process.stdout.write("\x1b[?1006h"); // SGR extended coordinates

    const onInput = (input: string) => {
      const match = MOUSE_RE.exec(input);
      if (!match) return;

      const cb = parseInt(match[1], 10);
      const x = parseInt(match[2], 10);
      const y = parseInt(match[3], 10);
      const isRelease = match[4] === "m";

      const button = cb & 0x03; // 0=left, 1=middle, 2=right
      const isMotion = (cb & 0x20) !== 0;

      if (isMotion) return;

      const type = isRelease ? "release" : "press";
      if (type === "press") {
        handlerRef.current({ button, x, y, type });
      }
    };

    internal_eventEmitter?.on("input", onInput);

    return () => {
      internal_eventEmitter?.off("input", onInput);
      // Disable mouse tracking
      process.stdout.write("\x1b[?1006l");
      process.stdout.write("\x1b[?1000l");
    };
  }, [internal_eventEmitter]);
}
