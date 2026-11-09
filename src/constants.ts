/** Agent name → display color in `agents ls`. */
export const AGENT_COLORS: Record<string, string> = {
  claude: "#d08770", copilot: "#81a1c1", opencode: "#4c566a", pi: "#b48ead",
  kiro: "#a3be8c",
};
export function agentColor(name: string): string { return AGENT_COLORS[name] || "#88c0d0"; }
