# Sites status dashboard

> **Exploration archive:** the active implementation moved to `Agents/chatgpt-sites`.
> This document and the adjacent implementation snapshot are retained as part of the original Sites capability investigation; future Site-specific work belongs in the standalone repository.

A small push-based status path for a private ChatGPT Site.

```text
local collector (10 min)
  -> Codex app-server account/rateLimits/read + account/usage/read
  -> bounded host/systemd/Gitea checks
  -> HTTPS POST with Sites SIWC bypass token + ingest key
  -> private Site /api/status-ingest
  -> D1 current snapshot + bounded history
  -> /status
```

The collector does not start a Codex model turn. It only uses account-level app-server RPCs and ordinary local checks.
The Site remains owner-only; the SIWC bypass token exists only for the machine publisher. The ingest route additionally
requires a separate `STATUS_INGEST_KEY` Site secret so a bypass token alone cannot write status rows.

## Local configuration

The systemd unit reads `%h/.config/chatgpt-sites-status/publisher.env`. It should contain only settings and secret **paths**:

```bash
CHATGPT_SITES_STATUS_SITE_URL=https://example.chatgpt.site
CHATGPT_SITES_STATUS_BYPASS_TOKEN_FILE=/home/user/.credentials/site-siwc-bypass-token
CHATGPT_SITES_STATUS_INGEST_KEY_FILE=/home/user/.credentials/site-status-ingest-key
CHATGPT_SITES_STATUS_GITEA_TOKEN_FILE=/home/user/.credentials/gitea-token
CHATGPT_SITES_STATUS_GITEA_BASE_URL=http://127.0.0.1:3000
CHATGPT_SITES_STATUS_GITEA_REPO=Agents/chatgpt-web-agent
CHATGPT_SITES_STATUS_LOCAL_REPO=/path/to/chatgpt-web-agent
CHATGPT_SITES_STATUS_CODEX_BIN=/path/to/codex
CHATGPT_SITES_STATUS_SERVICES=openclaw-gateway.service,openai-tunnel-chatgpt-web-agent.service
HTTPS_PROXY=http://127.0.0.1:1080
HTTP_PROXY=http://127.0.0.1:1080
NO_PROXY=127.0.0.1,localhost
```

Test collection without any Site credential:

```bash
python3 scripts/sites-status-publisher.py --collect-only --pretty
```

Enable the timer only after the private Site ingest path and SIWC bypass token are validated end-to-end.
