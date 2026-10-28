import { describe, expect, it } from "vitest";
import { clientSessionKey } from "../src/server.js";

describe("clientSessionKey", () => {
  it("is stable for one upstream session and separates another", () => {
    const one = { http: { req: new Request("http://localhost/mcp", { headers: { "x-openai-session": "v1/session-one-private-token" } }) } };
    const same = { http: { req: new Request("http://localhost/mcp", { headers: { "x-openai-session": "v1/session-one-private-token" } }) } };
    const other = { http: { req: new Request("http://localhost/mcp", { headers: { "x-openai-session": "v1/session-two-private-token" } }) } };
    expect(clientSessionKey(one)).toMatch(/^v1:[0-9a-f]{16}$/);
    expect(clientSessionKey(same)).toBe(clientSessionKey(one));
    expect(clientSessionKey(other)).not.toBe(clientSessionKey(one));
    expect(clientSessionKey(one)).not.toContain("session-one-private-token");
  });

  it("does not invent a key when the header is absent or malformed", () => {
    expect(clientSessionKey({})).toBeUndefined();
    expect(clientSessionKey({ http: { req: new Request("http://localhost/mcp") } })).toBeUndefined();
    expect(clientSessionKey({ http: { req: new Request("http://localhost/mcp", { headers: { "x-openai-session": "short" } }) } })).toBeUndefined();
  });
});
