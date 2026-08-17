import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { google, type drive_v3 } from "googleapis";
import type { GoogleDriveConfig } from "../config.js";
import { toolError } from "../result.js";
import type { LocalToolBackend, LocalToolDescriptor, ToolCallContext } from "./types.js";

const FILE_FIELDS = "id,name,mimeType,size,modifiedTime,parents,webViewLink,md5Checksum";

type DriveFactory = () => Promise<drive_v3.Drive>;

function jsonResult(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function stringArg(args: Record<string, unknown>, name: string, required = false): string | undefined {
  const value = args[name];
  if (value === undefined || value === null || value === "") {
    if (required) {
      throw new Error(`${name} is required`);
    }
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  return value;
}

function booleanArg(args: Record<string, unknown>, name: string, fallback = false): boolean {
  const value = args[name];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean`);
  }
  return value;
}

function integerArg(
  args: Record<string, unknown>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = args[name];
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function loadDrive(config: GoogleDriveConfig): Promise<drive_v3.Drive> {
  let token: unknown;
  try {
    token = JSON.parse(await fs.readFile(config.tokenPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Google Drive token is not available at ${config.tokenPath}; run pnpm drive:auth after installing OAuth credentials (${message})`,
    );
  }
  const auth = google.auth.fromJSON(token as Record<string, unknown>);
  if (!auth) {
    throw new Error(`Google Drive token file is not a supported Google auth credential: ${config.tokenPath}`);
  }
  return google.drive({ version: "v3", auth: auth as drive_v3.Options["auth"] });
}

export class GoogleDriveBackend implements LocalToolBackend {
  readonly id = "google-drive";
  readonly #config: GoogleDriveConfig;
  readonly #driveFactory: DriveFactory;
  #drive?: Promise<drive_v3.Drive>;

  constructor(config: GoogleDriveConfig, driveFactory: DriveFactory = () => loadDrive(config)) {
    this.#config = config;
    this.#driveFactory = driveFactory;
  }

  async listTools(): Promise<LocalToolDescriptor[]> {
    return [
      {
        name: "drive_list",
        description: "List files in a Google Drive folder. folderId defaults to Drive root.",
        inputSchema: {
          type: "object",
          properties: {
            folderId: { type: "string" },
            pageSize: { type: "integer", minimum: 1, maximum: 1000 },
            pageToken: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "drive_search",
        description: "Search Google Drive using Drive API v3 q syntax; trashed=false is added automatically.",
        inputSchema: {
          type: "object",
          properties: {
            q: { type: "string" },
            pageSize: { type: "integer", minimum: 1, maximum: 1000 },
            pageToken: { type: "string" },
          },
          required: ["q"],
          additionalProperties: false,
        },
      },
      {
        name: "drive_stat",
        description: "Get metadata for one Google Drive file or folder by file ID.",
        inputSchema: {
          type: "object",
          properties: { fileId: { type: "string" } },
          required: ["fileId"],
          additionalProperties: false,
        },
      },
      {
        name: "drive_upload",
        description: "Upload a local file to Google Drive. Local paths are restricted to the configured Drive staging root by default.",
        inputSchema: {
          type: "object",
          properties: {
            localPath: { type: "string" },
            folderId: { type: "string" },
            name: { type: "string" },
            mimeType: { type: "string" },
          },
          required: ["localPath"],
          additionalProperties: false,
        },
      },
      {
        name: "drive_download",
        description: "Download a binary/non-Google-native Drive file into the configured local staging root.",
        inputSchema: {
          type: "object",
          properties: {
            fileId: { type: "string" },
            localPath: { type: "string" },
            overwrite: { type: "boolean" },
          },
          required: ["fileId", "localPath"],
          additionalProperties: false,
        },
      },
      {
        name: "drive_export",
        description: "Export a Google Docs/Sheets/Slides file to a requested MIME type and local staging path.",
        inputSchema: {
          type: "object",
          properties: {
            fileId: { type: "string" },
            mimeType: { type: "string" },
            localPath: { type: "string" },
            overwrite: { type: "boolean" },
          },
          required: ["fileId", "mimeType", "localPath"],
          additionalProperties: false,
        },
      },
      {
        name: "drive_mkdir",
        description: "Create a folder in Google Drive. parentFolderId defaults to Drive root.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            parentFolderId: { type: "string" },
          },
          required: ["name"],
          additionalProperties: false,
        },
      },
    ];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    context: ToolCallContext,
  ): Promise<CallToolResult> {
    try {
      switch (name) {
        case "drive_list":
          return await this.#list(args, context.signal);
        case "drive_search":
          return await this.#search(args, context.signal);
        case "drive_stat":
          return await this.#stat(args, context.signal);
        case "drive_upload":
          return await this.#upload(args, context.signal);
        case "drive_download":
          return await this.#download(args, context.signal);
        case "drive_export":
          return await this.#export(args, context.signal);
        case "drive_mkdir":
          return await this.#mkdir(args, context.signal);
        default:
          return toolError(`Tool not available: ${name}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolError(`${name} failed: ${message}`);
    }
  }

  async #client(): Promise<drive_v3.Drive> {
    this.#drive ??= this.#driveFactory();
    return this.#drive;
  }

  async #list(args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    const folderId = stringArg(args, "folderId") ?? "root";
    const pageSize = integerArg(args, "pageSize", 100, 1, 1000);
    const pageToken = stringArg(args, "pageToken");
    const escapedFolderId = folderId.replaceAll("'", "\\'");
    const drive = await this.#client();
    const response = await drive.files.list(
      {
        q: `'${escapedFolderId}' in parents and trashed = false`,
        pageSize,
        pageToken,
        orderBy: "folder,name_natural",
        fields: `nextPageToken,files(${FILE_FIELDS})`,
      },
      { signal },
    );
    return jsonResult({ files: response.data.files ?? [], nextPageToken: response.data.nextPageToken ?? null });
  }

  async #search(args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    const q = stringArg(args, "q", true)!;
    const pageSize = integerArg(args, "pageSize", 100, 1, 1000);
    const pageToken = stringArg(args, "pageToken");
    const drive = await this.#client();
    const response = await drive.files.list(
      {
        q: `(${q}) and trashed = false`,
        pageSize,
        pageToken,
        orderBy: "modifiedTime desc",
        fields: `nextPageToken,files(${FILE_FIELDS})`,
      },
      { signal },
    );
    return jsonResult({ files: response.data.files ?? [], nextPageToken: response.data.nextPageToken ?? null });
  }

  async #stat(args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    const fileId = stringArg(args, "fileId", true)!;
    const drive = await this.#client();
    const response = await drive.files.get({ fileId, fields: FILE_FIELDS }, { signal });
    return jsonResult({ file: response.data });
  }

  async #upload(args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    const localPath = await this.#resolveLocalPath(stringArg(args, "localPath", true)!, "read");
    const stat = await fs.stat(localPath);
    if (!stat.isFile()) {
      throw new Error(`localPath is not a regular file: ${localPath}`);
    }
    const folderId = stringArg(args, "folderId") ?? "root";
    const name = stringArg(args, "name") ?? path.basename(localPath);
    const mimeType = stringArg(args, "mimeType") ?? "application/octet-stream";
    const drive = await this.#client();
    const response = await drive.files.create(
      {
        requestBody: { name, parents: [folderId] },
        media: { mimeType, body: createReadStream(localPath) },
        fields: FILE_FIELDS,
      },
      { signal },
    );
    return jsonResult({ file: response.data, localPath, bytes: stat.size });
  }

  async #download(args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    const fileId = stringArg(args, "fileId", true)!;
    const localPath = await this.#resolveLocalPath(stringArg(args, "localPath", true)!, "write");
    const overwrite = booleanArg(args, "overwrite");
    await this.#assertWritable(localPath, overwrite);
    const drive = await this.#client();
    const response = await drive.files.get({ fileId, alt: "media" }, { responseType: "stream", signal });
    if (!(response.data instanceof Readable)) {
      throw new Error("Google Drive download did not return a readable stream");
    }
    await this.#writeStream(localPath, response.data);
    const stat = await fs.stat(localPath);
    return jsonResult({ fileId, localPath, bytes: stat.size });
  }

  async #export(args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    const fileId = stringArg(args, "fileId", true)!;
    const mimeType = stringArg(args, "mimeType", true)!;
    const localPath = await this.#resolveLocalPath(stringArg(args, "localPath", true)!, "write");
    const overwrite = booleanArg(args, "overwrite");
    await this.#assertWritable(localPath, overwrite);
    const drive = await this.#client();
    const response = await drive.files.export({ fileId, mimeType }, { responseType: "stream", signal });
    if (!(response.data instanceof Readable)) {
      throw new Error("Google Drive export did not return a readable stream");
    }
    await this.#writeStream(localPath, response.data);
    const stat = await fs.stat(localPath);
    return jsonResult({ fileId, mimeType, localPath, bytes: stat.size });
  }

  async #mkdir(args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    const name = stringArg(args, "name", true)!;
    const parentFolderId = stringArg(args, "parentFolderId") ?? "root";
    const drive = await this.#client();
    const response = await drive.files.create(
      {
        requestBody: {
          name,
          mimeType: "application/vnd.google-apps.folder",
          parents: [parentFolderId],
        },
        fields: FILE_FIELDS,
      },
      { signal },
    );
    return jsonResult({ file: response.data });
  }

  async #resolveLocalPath(requested: string, mode: "read" | "write"): Promise<string> {
    await fs.mkdir(this.#config.localRoot, { recursive: true });
    const root = path.resolve(this.#config.localRoot);
    const candidate = path.resolve(root, requested);
    if (!this.#config.localRootOnly) {
      return candidate;
    }
    if (!isInside(root, candidate)) {
      throw new Error(`localPath must stay inside Google Drive staging root: ${root}`);
    }
    const realRoot = await fs.realpath(root);
    if (mode === "read") {
      const realCandidate = await fs.realpath(candidate);
      if (!isInside(realRoot, realCandidate)) {
        throw new Error(`localPath resolves outside Google Drive staging root: ${root}`);
      }
      return realCandidate;
    }
    await fs.mkdir(path.dirname(candidate), { recursive: true });
    const realParent = await fs.realpath(path.dirname(candidate));
    if (!isInside(realRoot, realParent)) {
      throw new Error(`localPath parent resolves outside Google Drive staging root: ${root}`);
    }
    try {
      const realCandidate = await fs.realpath(candidate);
      if (!isInside(realRoot, realCandidate)) {
        throw new Error(`localPath resolves outside Google Drive staging root: ${root}`);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
    }
    return candidate;
  }

  async #assertWritable(localPath: string, overwrite: boolean): Promise<void> {
    if (overwrite) {
      return;
    }
    try {
      await fs.access(localPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
    throw new Error(`localPath already exists; pass overwrite=true to replace it: ${localPath}`);
  }

  async #writeStream(localPath: string, source: Readable): Promise<void> {
    const temporary = `${localPath}.part-${process.pid}-${Date.now()}`;
    try {
      await pipeline(source, createWriteStream(temporary, { flags: "wx" }));
      await fs.rename(temporary, localPath);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
  }
}
