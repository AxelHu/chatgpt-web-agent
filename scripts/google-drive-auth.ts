import fs from "node:fs/promises";
import path from "node:path";
import { authenticate } from "@google-cloud/local-auth";

const SCOPES = ["https://www.googleapis.com/auth/drive"];

function resolvePath(value: string | undefined, fallback: string): string {
  return path.resolve(value?.trim() || fallback);
}

const workspace = resolvePath(process.env.CHATGPT_WEB_AGENT_WORKSPACE, process.cwd());
const credentialsPath = resolvePath(
  process.env.CHATGPT_WEB_AGENT_DRIVE_CREDENTIALS,
  path.join(workspace, ".credentials/google-drive/credentials.json"),
);
const tokenPath = resolvePath(
  process.env.CHATGPT_WEB_AGENT_DRIVE_TOKEN,
  path.join(workspace, ".credentials/google-drive/token.json"),
);

async function main(): Promise<void> {
  const credentials = JSON.parse(await fs.readFile(credentialsPath, "utf8")) as {
    installed?: { client_id?: string; client_secret?: string };
    web?: { client_id?: string; client_secret?: string };
  };
  const keys = credentials.installed ?? credentials.web;
  if (!keys?.client_id || !keys.client_secret) {
    throw new Error(`OAuth credentials file does not contain installed/web client keys: ${credentialsPath}`);
  }

  const client = await authenticate({ scopes: SCOPES, keyfilePath: credentialsPath });
  const refreshToken = client.credentials.refresh_token;
  if (!refreshToken) {
    throw new Error("Google OAuth completed without a refresh token; revoke prior app consent and retry");
  }

  await fs.mkdir(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(
    tokenPath,
    `${JSON.stringify(
      {
        type: "authorized_user",
        client_id: keys.client_id,
        client_secret: keys.client_secret,
        refresh_token: refreshToken,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  await fs.chmod(tokenPath, 0o600);
  process.stdout.write(`Google Drive OAuth token saved to ${tokenPath}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[google-drive-auth] ${message}\n`);
  process.exitCode = 1;
});
