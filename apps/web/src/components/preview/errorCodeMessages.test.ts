import { describe, expect, it } from "vite-plus/test";

import { formatPreviewErrorReport } from "./errorCodeMessages";

describe("formatPreviewErrorReport", () => {
  it.each([
    [
      "ERR_CONNECTION_REFUSED",
      -102,
      "The preview can't reach http://localhost:3000/\nERR_CONNECTION_REFUSED: Connection refused",
    ],
    ["Proxy said no", -1, "The preview can't reach http://localhost:3000/\nProxy said no"],
    ["", -105, "The preview can't reach http://localhost:3000/\nERR_105: Network error"],
  ])("reports %j", (description, code, expected) => {
    expect(formatPreviewErrorReport({ url: "http://localhost:3000/", code, description })).toBe(
      expected,
    );
  });
});
