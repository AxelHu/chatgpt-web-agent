import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillsBackend, type SkillsBackendDeps } from "../src/backend/skills.js";
import type { SkillsConfig } from "../src/config.js";

describe("SkillsBackend", () => {
  let root: string;
  let skillFile: string;
  let config: SkillsConfig;
  let status: Awaited<ReturnType<SkillsBackendDeps["fetchStatus"]>>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt-web-agent-skills-"));
    const skillDir = path.join(root, "skills", "work-with-gitea");
    await fs.mkdir(skillDir, { recursive: true });
    skillFile = path.join(skillDir, "SKILL.md");
    await fs.writeFile(skillFile, "# Work with Gitea\n\nLocal workflow.\n", "utf8");
    config = {
      agentId: "chatgpt-web-agent",
      gatewayUrl: "ws://127.0.0.1:18789",
      catalogDir: path.join(root, "catalog"),
      qmdUrl: "http://m4.local:8181/mcp",
      qmdCollection: "skills-chatgpt-web-agent",
      defaultLimit: 8,
      maxLimit: 20,
      requestTimeoutMs: 1000,
      maxSkillFileBytes: 256_000,
    };
    status = {
      workspaceDir: root,
      skills: [
        {
          name: "work-with-gitea",
          description: "Gitea multi-agent collaboration workflow",
          source: "openclaw-managed",
          skillKey: "work-with-gitea",
          filePath: skillFile,
          eligible: true,
          modelVisible: true,
          disabled: false,
        },
        {
          name: "disabled-skill",
          description: "Must not surface",
          source: "openclaw-bundled",
          skillKey: "disabled-skill",
          filePath: path.join(root, "disabled", "SKILL.md"),
          eligible: false,
          modelVisible: false,
          disabled: true,
        },
      ],
    };
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function backend(overrides: Partial<SkillsBackendDeps> = {}) {
    return new SkillsBackend(config, 100_000, {
      fetchStatus: vi.fn(async () => status),
      semanticSearch: vi.fn(async () => []),
      ...overrides,
    });
  }

  it("publishes the two narrow read-only tools", async () => {
    const tools = await backend().listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["skills_list", "skill_read"]);
    expect(tools.find((tool) => tool.name === "skill_read")?.inputSchema).not.toHaveProperty("path");
  });

  it("returns only live eligible/model-visible names without a query", async () => {
    const result = await backend().callTool("skills_list", {}, { callId: "list" });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      mode: "catalog",
      count: 1,
      skills: [{ name: "work-with-gitea" }],
    });
  });

  it("uses semantic hits only when they map to the current catalog fingerprint", async () => {
    let hitFile = "";
    const semanticSearch = vi.fn(async () => [{ file: `qmd://skills-chatgpt-web-agent/${hitFile}`, score: 0.91 }]);
    const first = backend({ semanticSearch });
    await first.callTool("skills_list", { query: "coordinate work in Gitea" }, { callId: "prime" });
    const manifest = JSON.parse(
      await fs.readFile(path.join(config.catalogDir, ".manifest.json"), "utf8"),
    ) as { files: Record<string, string> };
    hitFile = Object.keys(manifest.files)[0]!;

    const result = await first.callTool(
      "skills_list",
      { query: "coordinate work in Gitea", limit: 5 },
      { callId: "semantic" },
    );
    expect(result.structuredContent).toMatchObject({
      mode: "semantic",
      count: 1,
      skills: [
        expect.objectContaining({
          name: "work-with-gitea",
          description: "Gitea multi-agent collaboration workflow",
        }),
      ],
    });
  });

  it("falls back to names-only when QMD is unavailable or stale", async () => {
    const result = await backend({
      semanticSearch: vi.fn(async () => {
        throw new Error("M4 offline");
      }),
    }).callTool("skills_list", { query: "Gitea workflow" }, { callId: "fallback" });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      mode: "fallback_catalog",
      skills: [{ name: "work-with-gitea" }],
    });
  });

  it("reads only the canonical live SKILL.md resolved by name", async () => {
    const result = await backend().callTool(
      "skill_read",
      { name: "WORK-WITH-GITEA" },
      { callId: "read" },
    );
    expect(result.isError).not.toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "# Work with Gitea\n\nLocal workflow.\n",
    });

    const rejected = await backend().callTool(
      "skill_read",
      { name: "../../etc/passwd" },
      { callId: "read-path" },
    );
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("not currently eligible/model-visible"),
    });
  });

  it("changes all catalog filenames when the live inventory changes", async () => {
    const semanticSearch = vi.fn(async () => []);
    const instance = backend({ semanticSearch });
    await instance.callTool("skills_list", { query: "Gitea" }, { callId: "v1" });
    const before = (await fs.readdir(config.catalogDir)).filter((name) => name.endsWith(".md"));
    status.skills[0]!.description = "Updated Gitea workflow description";
    await instance.callTool("skills_list", { query: "Gitea" }, { callId: "v2" });
    const after = (await fs.readdir(config.catalogDir)).filter((name) => name.endsWith(".md"));
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(before[0]);
  });
});
