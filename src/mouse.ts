import { useEffect, useRef } from "react";

export interface MouseEvent {
  button: number; // 0=left, 1=middle, 2=right
  x: number;      // 1-based column
  y: number;      // 1-based row
  type: "press" | "release" | "move";
}

type MouseHandler = (event: MouseEvent) => void;

/**
 * Enable SGR mouse tracking and parse click events.
 * Calls handler on mouse press events only.
 */
export function useMouse(handler: MouseHandler): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const stdin = process.stdin;

    // Enable SGR extended mouse mode
    process.stdout.write("\x1b[?1000h"); // enable mouse press/release
    process.stdout.write("\x1b[?1006h"); // SGR extended coordinates

    let buf = "";

    const onData = (data: Buffer) => {
      buf += data.toString("utf-8");

      // Parse SGR mouse sequences: ESC [ < Cb ; Cx ; Cy M/m
      // M = press, m = release
      const re = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(buf)) !== null) {
        const cb = parseInt(match[1], 10);
        const x = parseInt(match[2], 10);
        const y = parseInt(match[3], 10);
        const isRelease = match[4] === "m";

        const button = cb & 0x03; // 0=left, 1=middle, 2=right
        const isMotion = (cb & 0x20) !== 0;

        if (isMotion) continue;

        const type = isRelease ? "release" : "press";
        if (type === "press") {
          handlerRef.current({ button, x, y, type });
        }
      }

      // Keep only unmatched tail (partial sequences)
      buf = buf.replace(/\x1b\[<\d+;\d+;\d+[Mm]/g, "");
      // Trim consumed data but keep potential partial escape at end
      const lastEsc = buf.lastIndexOf("\x1b");
      if (lastEsc > 0) {
        buf = buf.slice(lastEsc);
      } else if (!buf.includes("\x1b")) {
        buf = "";
      }
    };

    stdin.on("data", onData);

    return () => {
      stdin.off("data", onData);
      // Disable mouse tracking
      process.stdout.write("\x1b[?1006l");
      process.stdout.write("\x1b[?1000l");
    };
  }, []);
}
