import path from "node:path";

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveToolWorkdir(
  workspaceDir: string,
  requestedWorkdir: string | undefined,
  workspaceOnly: boolean,
  toolName: string,
): string {
  const workdir = path.resolve(workspaceDir, requestedWorkdir?.trim() || ".");
  if (workspaceOnly && !isInside(workspaceDir, workdir)) {
    throw new Error(`${toolName} workdir must stay inside workspace: ${workspaceDir}`);
  }
  return workdir;
}
