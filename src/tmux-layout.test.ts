import { describe, expect, it } from "vitest";
import { classicLayout } from "./tmux-layout.js";

describe("tmux layouts", () => {
  it("turns tmux 3.8's JSON layout into the classic one, and leaves a classic one as it is", () => {
    const json = '{"V":2,"L":{"t":"h","w":163,"h":59,"x":0,"y":0,"c":[{"t":"p","w":80,"h":59,"x":0,"y":0,"a":true,"i":0,"I":"%9"},{"t":"v","w":82,"h":59,"x":81,"y":0,"c":[{"t":"p","w":82,"h":29,"x":81,"y":0,"i":1,"I":"%39"},{"t":"p","w":82,"h":29,"x":81,"y":30,"i":2,"I":"%40"}]}]}}';
    expect(classicLayout(json)).toBe("c452,163x59,0,0{80x59,0,0,9,82x59,81,0[82x29,81,0,39,82x29,81,30,40]}");
    expect(classicLayout("b25d,200x50,0,0,1")).toBe("b25d,200x50,0,0,1");
    expect(classicLayout('{"V":2,"L":{"t":"f"}}')).toBe('{"V":2,"L":{"t":"f"}}');
  });
});
