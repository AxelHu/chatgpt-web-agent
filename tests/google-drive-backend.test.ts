import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { drive_v3 } from "googleapis";
import { GoogleDriveBackend } from "../src/backend/google-drive.js";
import type { GoogleDriveConfig } from "../src/config.js";

function fakeDrive() {
  const files = {
    list: vi.fn(async () => ({
      data: {
        files: [{ id: "file-1", name: "report.txt", mimeType: "text/plain" }],
        nextPageToken: "next-token",
      },
    })),
    get: vi.fn(async (params: { fileId?: string; alt?: string }) =>
      params.alt === "media"
        ? { data: Readable.from(["download-body"]) }
        : { data: { id: params.fileId, name: "report.txt", mimeType: "text/plain" } },
    ),
    create: vi.fn(async (params: { requestBody?: { name?: string; mimeType?: string } }) => ({
      data: {
        id: params.requestBody?.mimeType ? "folder-1" : "upload-1",
        name: params.requestBody?.name,
        mimeType: params.requestBody?.mimeType ?? "application/octet-stream",
      },
    })),
    export: vi.fn(async () => ({ data: Readable.from(["export-body"]) })),
  };
  return { drive: { files } as unknown as drive_v3.Drive["files"], files };
}

describe("GoogleDriveBackend", () => {
  let tempDir: string;
  let localRoot: string;
  let config: GoogleDriveConfig;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt-web-drive-"));
    localRoot = path.join(tempDir, "exchange");
    await fs.mkdir(localRoot);
    config = {
      credentialsPath: path.join(tempDir, "credentials.json"),
      tokenPath: path.join(tempDir, "token.json"),
      localRoot,
      localRootOnly: true,
    };
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("publishes the Drive primitive tool set", async () => {
    const fake = fakeDrive();
    const backend = new GoogleDriveBackend(config, async () => ({ files: fake.drive.files } as drive_v3.Drive));
    const names = (await backend.listTools()).map((tool) => tool.name).sort();
    expect(names).toEqual([
      "drive_download",
      "drive_export",
      "drive_list",
      "drive_mkdir",
      "drive_search",
      "drive_stat",
      "drive_upload",
    ]);
  });

  it("lists, searches, and reads metadata without touching local files", async () => {
    const fake = fakeDrive();
    const backend = new GoogleDriveBackend(config, async () => ({ files: fake.drive.files } as drive_v3.Drive));

    const listed = await backend.callTool("drive_list", { folderId: "folder-123" }, { callId: "list" });
    expect(listed.isError).not.toBe(true);
    expect(fake.files.list).toHaveBeenCalledWith(
      expect.objectContaining({ q: "'folder-123' in parents and trashed = false" }),
      expect.any(Object),
    );

    const searched = await backend.callTool(
      "drive_search",
      { q: "name contains 'report'" },
      { callId: "search" },
    );
    expect(searched.isError).not.toBe(true);
    expect(fake.files.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: "(name contains 'report') and trashed = false" }),
      expect.any(Object),
    );

    const stat = await backend.callTool("drive_stat", { fileId: "file-1" }, { callId: "stat" });
    expect(stat.isError).not.toBe(true);
    expect(fake.files.get).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: "file-1" }),
      expect.any(Object),
    );
  });

  it("uploads files and creates Drive folders", async () => {
    const fake = fakeDrive();
    const backend = new GoogleDriveBackend(config, async () => ({ files: fake.drive.files } as drive_v3.Drive));
    await fs.writeFile(path.join(localRoot, "upload.txt"), "upload-body");

    const upload = await backend.callTool(
      "drive_upload",
      { localPath: "upload.txt", folderId: "folder-123", mimeType: "text/plain" },
      { callId: "upload" },
    );
    expect(upload.isError).not.toBe(true);
    expect(fake.files.create).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: { name: "upload.txt", parents: ["folder-123"] },
        media: expect.objectContaining({ mimeType: "text/plain" }),
      }),
      expect.any(Object),
    );

    const mkdir = await backend.callTool(
      "drive_mkdir",
      { name: "New Folder", parentFolderId: "folder-123" },
      { callId: "mkdir" },
    );
    expect(mkdir.isError).not.toBe(true);
    expect(fake.files.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        requestBody: expect.objectContaining({
          name: "New Folder",
          mimeType: "application/vnd.google-apps.folder",
          parents: ["folder-123"],
        }),
      }),
      expect.any(Object),
    );
  });

  it("downloads and exports Drive streams into the staging root", async () => {
    const fake = fakeDrive();
    const backend = new GoogleDriveBackend(config, async () => ({ files: fake.drive.files } as drive_v3.Drive));

    const download = await backend.callTool(
      "drive_download",
      { fileId: "file-1", localPath: "incoming/report.txt" },
      { callId: "download" },
    );
    expect(download.isError).not.toBe(true);
    await expect(fs.readFile(path.join(localRoot, "incoming/report.txt"), "utf8")).resolves.toBe(
      "download-body",
    );

    const exported = await backend.callTool(
      "drive_export",
      { fileId: "doc-1", mimeType: "application/pdf", localPath: "incoming/doc.pdf" },
      { callId: "export" },
    );
    expect(exported.isError).not.toBe(true);
    await expect(fs.readFile(path.join(localRoot, "incoming/doc.pdf"), "utf8")).resolves.toBe(
      "export-body",
    );
  });

  it("blocks local path traversal and symlink escape before Drive I/O", async () => {
    const fake = fakeDrive();
    const backend = new GoogleDriveBackend(config, async () => ({ files: fake.drive.files } as drive_v3.Drive));
    const outside = path.join(tempDir, "outside.txt");
    await fs.writeFile(outside, "private");

    const traversal = await backend.callTool(
      "drive_upload",
      { localPath: "../outside.txt" },
      { callId: "escape-1" },
    );
    expect(traversal.isError).toBe(true);
    expect(fake.files.create).not.toHaveBeenCalled();

    await fs.symlink(tempDir, path.join(localRoot, "escape"));
    const symlink = await backend.callTool(
      "drive_upload",
      { localPath: "escape/outside.txt" },
      { callId: "escape-2" },
    );
    expect(symlink.isError).toBe(true);
    expect(fake.files.create).not.toHaveBeenCalled();
  });
});
