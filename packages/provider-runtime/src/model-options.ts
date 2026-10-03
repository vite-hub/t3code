import type { ModelSelection, ProviderInstanceId, ProviderSendTurnInput } from "@t3tools/contracts";

export function createRuntimeModelSelection(
  instanceId: ProviderInstanceId,
  model: string,
  modelOptions: Readonly<Record<string, string | boolean>> | undefined,
): ModelSelection {
  const options = modelOptions
    ? Object.entries(modelOptions).map(([id, value]) => ({ id, value }))
    : [];
  return {
    instanceId,
    model,
    ...(options.length > 0 ? { options } : {}),
  };
}

export function withRuntimeModelSelection(
  input: ProviderSendTurnInput,
  modelSelection: ModelSelection | undefined,
): ProviderSendTurnInput {
  return {
    ...input,
    modelSelection: input.modelSelection ?? modelSelection,
  };
}
