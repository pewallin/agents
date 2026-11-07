// Files and images pasted or dropped into the view's field. An image goes to the agent as an
// image when it takes images (its promptCapabilities); anything else goes as a link to the file:
// its own path when the drop says it (a file:// URI), else a copy the pane's host saves where the
// agent can read it.
import type { ContentBlock } from "@agentclientprotocol/sdk";

export interface Attachment {
  id: string;
  name: string;
  kind: "image" | "file";
  mimeType: string;
  /** The file's bytes, base64, for one that came as data (a paste, a drop from another app). */
  data?: string;
  /** The file's own path, for one dropped as a file:// URI. */
  path?: string;
  /** A picture of an image, as a data URL. */
  preview?: string;
}

let next = 0;

function base64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

/** A file from a paste or a drop, read into the field. */
export async function readAttachment(file: File): Promise<Attachment> {
  const data = base64(await file.arrayBuffer());
  const image = file.type.startsWith("image/");
  const name = file.name && file.name !== "image.png" ? file.name : image ? `Pasted image ${new Date().toTimeString().slice(0, 8)}.${file.type.split("/")[1] ?? "png"}` : file.name || "Pasted file";
  return {
    id: `att-${(next += 1)}`, name, kind: image ? "image" : "file", mimeType: file.type || "application/octet-stream", data,
    preview: image ? `data:${file.type};base64,${data}` : undefined,
  };
}

const IMAGE_NAME = /\.(png|jpe?g|gif|webp|heic|bmp|tiff?)$/i;

/** Files named by path (a file:// URI list: a chip dragged from the view, a file from Finder). */
export function attachmentsFromURIs(list: string): Attachment[] {
  return list.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("file://")).map((uri) => {
    const path = decodeURI(uri.replace(/^file:\/\/(localhost)?/, ""));
    const name = path.split("/").filter(Boolean).pop() ?? path;
    return { id: `att-${(next += 1)}`, name, kind: IMAGE_NAME.test(name) ? "image" : "file", mimeType: "", path } satisfies Attachment;
  });
}

export function fileURI(path: string): string {
  return `file://${encodeURI(path)}`;
}

/** A small text file's text, for an agent that takes it embedded; null for anything else. */
function textOf(attachment: Attachment): string | null {
  if (!attachment.data || attachment.data.length > 200_000) return null;
  const textual = /^text\/|json|xml|yaml|javascript|typescript|markdown|csv/.test(attachment.mimeType)
    || /\.(md|txt|json|ya?ml|toml|csv|tsv|log|swift|ts|tsx|js|py|rb|go|rs|sh|css|html?)$/i.test(attachment.name);
  if (!textual) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(attachment.data), (char) => char.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** What the attachments add to a prompt: an image as an image when the agent takes images and the
 *  view has its bytes, a small text file as its text when the agent takes embedded files, and
 *  everything else as a link to the file (saved first when it has no path). */
export async function attachmentBlocks(
  attachments: Attachment[],
  takes: { image: boolean; embeddedContext: boolean },
  save: (attachment: Attachment) => Promise<string>,
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];
  for (const attachment of attachments) {
    if (attachment.kind === "image" && attachment.data && takes.image) {
      blocks.push({ type: "image", mimeType: attachment.mimeType || "image/png", data: attachment.data });
      continue;
    }
    const text = takes.embeddedContext ? textOf(attachment) : null;
    if (text !== null) {
      blocks.push({ type: "resource", resource: { uri: attachment.path ? fileURI(attachment.path) : `pasted:${encodeURIComponent(attachment.name)}`, mimeType: attachment.mimeType || "text/plain", text } });
      continue;
    }
    const path = attachment.path ?? await save(attachment);
    blocks.push({ type: "resource_link", uri: fileURI(path), name: attachment.name, ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}) });
  }
  return blocks;
}
