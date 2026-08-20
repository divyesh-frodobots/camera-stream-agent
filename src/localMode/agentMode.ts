export type AgentRunMode = 'file' | 'env-single' | 'backend';

export function selectAgentMode(input: {
  camerasFileExists: boolean;
  hasConfiguredCamera: boolean;
  streamUrl?: string;
  agentApiKey?: string;
}): AgentRunMode {
  if (input.camerasFileExists || input.hasConfiguredCamera) return 'file';
  if (input.streamUrl) return 'env-single';
  if (input.agentApiKey) return 'backend';
  return 'file';
}

export function shouldStartControlServer(mode: AgentRunMode): boolean {
  return mode !== 'backend';
}
