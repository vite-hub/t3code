import { PREVIEW_ERROR_CODE_MESSAGES } from "./previewConstants";

export function describePreviewError(description: string): string {
  const friendly = PREVIEW_ERROR_CODE_MESSAGES[description];
  if (friendly) return friendly;
  if (description.length > 0) return description;
  return "Network error";
}

export function previewErrorLabel(code: number, description: string): string {
  return description.length > 0 ? description : `ERR_${Math.abs(code) || "FAILED"}`;
}

export function formatPreviewErrorReport(input: {
  url: string;
  code: number;
  description: string;
}): string {
  const label = previewErrorLabel(input.code, input.description);
  const friendly = describePreviewError(input.description);
  const error = friendly === label ? label : `${label}: ${friendly}`;
  return `The preview can't reach ${input.url}\n${error}`;
}
