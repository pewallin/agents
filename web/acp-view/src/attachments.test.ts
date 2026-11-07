import { describe, expect, it } from "vitest";
import { attachmentBlocks, attachmentsFromURIs, readAttachment } from "./attachments";

describe("attachments", () => {
  it("reads a pasted image with a picture of it", async () => {
    const image = await readAttachment(new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" }));
    expect(image).toMatchObject({ kind: "image", name: "shot.png", mimeType: "image/png", data: "iVBORw==" });
    expect(image.preview).toBe("data:image/png;base64,iVBORw==");
  });

  it("takes files named by file:// URIs as they are", () => {
    expect(attachmentsFromURIs("file:///Users/p/My%20Shot.png\r\nhttps://example.com\nfile:///tmp/notes.md")).toMatchObject([
      { kind: "image", name: "My Shot.png", path: "/Users/p/My Shot.png" },
      { kind: "file", name: "notes.md", path: "/tmp/notes.md" },
    ]);
  });

  it("sends an image as an image when the agent takes images, else as a link to a saved copy", async () => {
    const image = await readAttachment(new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" }));
    const [file] = attachmentsFromURIs("file:///code/app/README.md");
    const saved: string[] = [];
    const save = async (attachment: { name: string }) => { saved.push(attachment.name); return `/tmp/x/${attachment.name}`; };
    expect(await attachmentBlocks([image, file], { image: true, embeddedContext: false }, save)).toEqual([
      { type: "image", mimeType: "image/png", data: "AQID" },
      { type: "resource_link", uri: "file:///code/app/README.md", name: "README.md" },
    ]);
    expect(saved).toEqual([]);
    expect(await attachmentBlocks([image], { image: false, embeddedContext: false }, save)).toEqual([
      { type: "resource_link", uri: "file:///tmp/x/a.png", name: "a.png", mimeType: "image/png" },
    ]);
    expect(saved).toEqual(["a.png"]);
  });

  it("sends a small text file as its text when the agent takes embedded files", async () => {
    const note = await readAttachment(new File(["The word is PELICAN.\n"], "secret.txt", { type: "text/plain" }));
    expect(await attachmentBlocks([note], { image: true, embeddedContext: true }, async () => "/never")).toEqual([
      { type: "resource", resource: { uri: "pasted:secret.txt", mimeType: "text/plain", text: "The word is PELICAN.\n" } },
    ]);
  });
});
