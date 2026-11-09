export function hasGenerationPrompt(prompt, connectedNodes = []) {
  if (typeof prompt === "string" && prompt.trim()) return true;
  return connectedNodes.some((node) => {
    if (node?.type !== "text") return false;
    return Boolean((node.metadata?.content || node.metadata?.prompt || "").trim());
  });
}
