import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { google } from "googleapis";

const SCOPES = ["https://www.googleapis.com/auth/drive"];
const WINDOWS_CHROME = "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe";

function resolvePath(value: string | undefined, fallback: string): string {
  return path.resolve(value?.trim() || fallback);
}

function openBrowser(url: string): void {
  if (process.platform === "linux" && fs.existsSync(WINDOWS_CHROME)) {
    spawn(WINDOWS_CHROME, [url], { detached: true, stdio: "ignore" }).unref();
    return;
  }

  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/d", "/c", "start", "", url] : [url];
  spawn(opener, args, { detached: true, stdio: "ignore" }).unref();
}

type InstalledKeys = {
  client_id?: string;
  client_secret?: string;
  redirect_uris?: string[];
};

async function main(): Promise<void> {
  const workspace = resolvePath(process.env.CHATGPT_WEB_AGENT_WORKSPACE, process.cwd());
  const credentialsPath = resolvePath(
    process.env.CHATGPT_WEB_AGENT_DRIVE_CREDENTIALS,
    path.join(workspace, ".credentials/google-drive/credentials.json"),
  );
  const tokenPath = resolvePath(
    process.env.CHATGPT_WEB_AGENT_DRIVE_TOKEN,
    path.join(workspace, ".credentials/google-drive/token.json"),
  );

  const credentials = JSON.parse(await fsp.readFile(credentialsPath, "utf8")) as {
    installed?: InstalledKeys;
    web?: InstalledKeys;
  };
  const keys = credentials.installed ?? credentials.web;
  if (!keys?.client_id || !keys.client_secret) {
    throw new Error(`OAuth credentials file does not contain installed/web client keys: ${credentialsPath}`);
  }

  const baseRedirect = new URL(keys.redirect_uris?.[0] ?? "http://localhost");
  if (baseRedirect.hostname !== "localhost" && baseRedirect.hostname !== "127.0.0.1") {
    throw new Error(`OAuth redirect must use a local loopback address: ${baseRedirect.toString()}`);
  }

  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not determine OAuth callback port");
  }

  baseRedirect.port = String(address.port);
  const redirectUri = baseRedirect.toString();
  const client = new google.auth.OAuth2(keys.client_id, keys.client_secret, redirectUri);
  const authorizeUrl = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });

  process.stdout.write(`Opening Google OAuth in the local browser. Callback: ${redirectUri}\n`);
  openBrowser(authorizeUrl);

  const authorized = await new Promise<typeof client>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Google OAuth timed out before the browser callback arrived"));
      server.close();
    }, 10 * 60 * 1000);
    timeout.unref();

    server.on("request", async (request, response) => {
      try {
        const requestUrl = new URL(request.url ?? "/", redirectUri);
        if (requestUrl.pathname !== baseRedirect.pathname) {
          response.statusCode = 404;
          response.end("Invalid callback path");
          return;
        }
        const oauthError = requestUrl.searchParams.get("error");
        if (oauthError) {
          response.statusCode = 400;
          response.end("Google Drive authorization was rejected. You may close this tab.");
          clearTimeout(timeout);
          reject(new Error(`Google OAuth rejected: ${oauthError}`));
          server.close();
          return;
        }
        const code = requestUrl.searchParams.get("code");
        if (!code) {
          response.statusCode = 400;
          response.end("No authorization code was returned. You may close this tab.");
          return;
        }

        const { tokens } = await client.getToken({ code, redirect_uri: redirectUri });
        client.setCredentials(tokens);
        response.end("Google Drive authorization succeeded. You may close this tab and return to ChatGPT.");
        clearTimeout(timeout);
        resolve(client);
        server.close();
      } catch (error) {
        response.statusCode = 500;
        response.end("Google Drive authorization failed. You may close this tab.");
        clearTimeout(timeout);
        reject(error);
        server.close();
      }
    });
  });

  const refreshToken = authorized.credentials.refresh_token;
  if (!refreshToken) {
    throw new Error("Google OAuth completed without a refresh token; retrying with consent should normally provide one");
  }

  await fsp.mkdir(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
  await fsp.writeFile(
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
  await fsp.chmod(tokenPath, 0o600);
  process.stdout.write(`Google Drive OAuth token saved to ${tokenPath}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[google-drive-auth] ${message}\n`);
  process.exitCode = 1;
});
