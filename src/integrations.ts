export type AgentIntegrationName = "claude" | "codex" | "copilot" | "pi" | "opencode";
export type IntegrationInstallMethod = "config-hooks" | "cli-extension" | "plugin-package";
export type LifecycleCapability = "working" | "idle" | "approval" | "question";
export type MetadataCapability = "provider" | "modelId" | "modelLabel" | "contextUsage" | "externalSessionId";

export interface IntegrationCapabilitySet {
  working: boolean;
  idle: boolean;
  approval: boolean;
  question: boolean;
  provider: boolean;
  modelId: boolean;
  modelLabel: boolean;
  contextUsage: boolean;
  externalSessionId: boolean;
}

export interface AgentIntegrationSpec {
  agent: AgentIntegrationName;
  installMethod: IntegrationInstallMethod;
  configuredEvents: string[];
  capabilities: IntegrationCapabilitySet;
  optionalCapabilities?: Partial<IntegrationCapabilitySet>;
  notes?: string[];
}

export const LIFECYCLE_CAPABILITIES: LifecycleCapability[] = [
  "working",
  "idle",
  "approval",
  "question",
];

export const METADATA_CAPABILITIES: MetadataCapability[] = [
  "provider",
  "modelId",
  "modelLabel",
  "contextUsage",
  "externalSessionId",
];

export const INTEGRATION_SPECS: AgentIntegrationSpec[] = [
  {
    agent: "claude",
    installMethod: "config-hooks",
    configuredEvents: [
      "PreToolUse",
      "UserPromptSubmit",
      "Stop",
      "Notification:idle_prompt",
      "Notification:permission_prompt",
      "Notification:elicitation_dialog",
    ],
    capabilities: {
      working: true,
      idle: true,
      approval: true,
      question: true,
      provider: true,
      modelId: true,
      modelLabel: true,
      contextUsage: true,
      externalSessionId: true,
    },
    notes: [
      "Context usage comes from the Claude bridge file, not the hook payload itself.",
    ],
  },
  {
    agent: "codex",
    installMethod: "config-hooks",
    configuredEvents: ["UserPromptSubmit", "Stop"],
    capabilities: {
      working: true,
      idle: true,
      approval: true,
      question: true,
      provider: true,
      modelId: true,
      modelLabel: true,
      contextUsage: true,
      externalSessionId: true,
    },
    notes: [
      "Approval is detected by the scanner when Codex enters exec-approval, not by a dedicated Codex hook event.",
      "Context usage comes from hook payload when available and scanner inference otherwise.",
    ],
  },
  {
    agent: "copilot",
    installMethod: "cli-extension",
    configuredEvents: [
      "onUserPromptSubmitted",
      "onSessionEnd",
      "permission.requested",
      "tool.execution_start",
      "tool.execution_complete",
      "session.compaction_start",
      "session.compaction_complete",
      "session.idle",
    ],
    capabilities: {
      working: true,
      idle: true,
      approval: true,
      question: true,
      provider: true,
      modelId: true,
      modelLabel: true,
      contextUsage: true,
      externalSessionId: true,
    },
  },
  {
    agent: "pi",
    installMethod: "cli-extension",
    configuredEvents: [
      "agent_start",
      "agent_end",
      "tool_call",
      "session_before_compact",
      "session_compact",
      "session_shutdown",
    ],
    capabilities: {
      working: true,
      idle: true,
      approval: false,
      question: true,
      provider: true,
      modelId: true,
      modelLabel: true,
      contextUsage: true,
      externalSessionId: true,
    },
    optionalCapabilities: {
      approval: true,
    },
    notes: [
      "Approval is available when Dustbot's dustbot-sandbox extension is installed alongside the base Pi reporting extension.",
    ],
  },
  {
    agent: "opencode",
    installMethod: "plugin-package",
    configuredEvents: [
      "session.status",
      "session.idle",
      "session.compacted",
      "message.updated",
      "session.error",
      "permission.updated",
      "permission.replied",
      "tool.execute.before",
    ],
    capabilities: {
      working: true,
      idle: true,
      approval: true,
      question: true,
      provider: true,
      modelId: true,
      modelLabel: true,
      contextUsage: true,
      externalSessionId: true,
    },
    notes: [
      "Context usage is extracted opportunistically from OpenCode event payloads when usage fields are present.",
    ],
  },
];

export function integrationSpec(agent: AgentIntegrationName): AgentIntegrationSpec {
  const spec = INTEGRATION_SPECS.find((candidate) => candidate.agent === agent);
  if (!spec) {
    throw new Error(`Unknown integration spec: ${agent}`);
  }
  return spec;
}

export function missingLifecycleCapabilities(spec: AgentIntegrationSpec): LifecycleCapability[] {
  return LIFECYCLE_CAPABILITIES.filter((capability) => !spec.capabilities[capability]);
}

export function missingMetadataCapabilities(spec: AgentIntegrationSpec): MetadataCapability[] {
  return METADATA_CAPABILITIES.filter((capability) => !spec.capabilities[capability]);
}
