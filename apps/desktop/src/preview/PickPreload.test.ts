import { expect, it, vi } from "vite-plus/test";

import type { PreviewAnnotationPayload } from "@t3tools/contracts";

import { ELEMENT_PICKED_CHANNEL, START_PICK_CHANNEL } from "./GuestProtocol.ts";
import "./PickPreload.ts";

const ipcListeners = vi.hoisted(() => new Map<string, Array<(...args: unknown[]) => void>>());
const ipcSend = vi.hoisted(() => ({ listener: (_channel: string, ..._args: unknown[]) => {} }));

vi.mock("electron", () => ({
  ipcRenderer: {
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      ipcListeners.set(channel, [...(ipcListeners.get(channel) ?? []), listener]);
    },
    off: () => {},
    send: (channel: string, ...args: unknown[]) => ipcSend.listener(channel, ...args),
    invoke: async () => undefined,
  },
}));

vi.mock("react-grab/primitives", () => ({ getElementContext: async () => null }));

const startAnnotation = (): ShadowRoot => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  using attachShadow = vi.spyOn(Element.prototype, "attachShadow");
  for (const listener of ipcListeners.get(START_PICK_CHANNEL) ?? []) listener({}, undefined, false);
  const shadowRoot = attachShadow.mock.results[0]?.value;
  if (!(shadowRoot instanceof ShadowRoot)) throw new Error("annotation overlay did not start");
  return shadowRoot;
};

it("switches tools from the keyboard after a toolbar button is clicked", () => {
  const shadowRoot = startAnnotation();
  const region = Array.from(shadowRoot.querySelectorAll("button")).find(
    (button) => button.textContent === "Region",
  );
  if (!region) throw new Error("Region toolbar button not found");

  region.focus();
  region.click();
  expect(document.documentElement.getAttribute("data-t3code-annotation-tool")).toBe("marquee");

  region.dispatchEvent(new KeyboardEvent("keydown", { key: "v", bubbles: true, composed: true }));

  expect(
    document.documentElement.getAttribute("data-t3code-annotation-tool"),
    "V should switch to Select while focus is on a toolbar button",
  ).toBe("select");
});

it("keeps the tool while typing a tool key in the comment", () => {
  const shadowRoot = startAnnotation();
  const comment = shadowRoot.querySelector("textarea");
  if (!comment) throw new Error("comment textarea not found");

  comment.focus();
  comment.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true, composed: true }));

  expect(document.documentElement.getAttribute("data-t3code-annotation-tool")).toBe("select");
});

it("keeps the box and viewport from when the element was picked", async () => {
  const shadowRoot = startAnnotation();
  const button = document.createElement("button");
  document.body.append(button);
  // jsdom has no hit testing.
  Object.defineProperty(document, "elementsFromPoint", {
    configurable: true,
    value: () => [button, document.body],
  });
  using rect = vi
    .spyOn(button, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(24, 310, 120, 36));
  vi.stubGlobal("innerWidth", 1280);
  vi.stubGlobal("innerHeight", 800);
  window.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 30, clientY: 320 }));

  rect.mockReturnValue(new DOMRect(24, 210, 120, 36));
  vi.stubGlobal("innerWidth", 900);
  const sent = new Promise<PreviewAnnotationPayload>((resolve) => {
    ipcSend.listener = (channel, annotation) => {
      if (channel === ELEMENT_PICKED_CHANNEL) resolve(annotation as PreviewAnnotationPayload);
    };
  });
  const attach = Array.from(shadowRoot.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === "Attach",
  );
  if (!attach) throw new Error("Attach button not found");
  attach.click();

  const element = (await sent).elements[0]?.element;
  expect(element?.rect).toEqual({ x: 24, y: 310, width: 120, height: 36 });
  expect(element?.viewport).toEqual({ width: 1280, height: 800 });
});
