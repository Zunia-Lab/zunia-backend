import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { loadProxyTrust, loadPublicWsBase } from "../../config/connect.js";
import { WindowLimiter } from "./limits.js";
import {
  bearerToken,
  clientIp,
  forwardedHttps,
  offeredProtocols,
  tokenFromProtocols,
  verifiedOriginFrom,
} from "./request.js";
import { hashToken, newSessionId, newToken, tokenMatches } from "./tokens.js";

const TOKEN = "a".repeat(43);

describe("connect/tokens", () => {
  it("creates 256-bit tokens and 128-bit session ids as base64url", () => {
    assert.match(newToken(), /^[A-Za-z0-9_-]{43}$/);
    assert.match(newSessionId(), /^[A-Za-z0-9_-]{22}$/);
    assert.notEqual(newToken(), newToken());
  });

  it("stores a SHA-256 hash and compares against it", () => {
    const token = newToken();
    const hash = hashToken(token);
    assert.equal(hash, createHash("sha256").update(token).digest("hex"));
    assert.equal(tokenMatches(token, hash), true);
    assert.equal(tokenMatches(newToken(), hash), false);
    assert.equal(tokenMatches(token, null), false);
    assert.equal(tokenMatches(token, "abcd"), false);
  });
});

describe("connect/request", () => {
  it("accepts only plain http(s) origins as verified", () => {
    assert.equal(verifiedOriginFrom("https://app.example.com"), "https://app.example.com");
    assert.equal(verifiedOriginFrom("http://localhost:5173"), "http://localhost:5173");
    assert.equal(verifiedOriginFrom(undefined), null);
    assert.equal(verifiedOriginFrom("null"), null);
    assert.equal(verifiedOriginFrom("chrome-extension://abcdef"), null);
    assert.equal(verifiedOriginFrom("https://app.example.com/path"), null);
    assert.equal(verifiedOriginFrom("https://App.Example.com"), null);
    assert.equal(verifiedOriginFrom("not a url"), null);
  });

  it("reads the client address according to the proxy trust", () => {
    const headers = new Headers({
      "x-forwarded-for": "6.6.6.6, 203.0.113.9",
      "cf-connecting-ip": "198.51.100.4",
    });
    assert.equal(clientIp(headers, "10.0.0.2", { mode: "none" }), "10.0.0.2");
    assert.equal(clientIp(headers, "10.0.0.2", { mode: "cloudflare" }), "198.51.100.4");
    assert.equal(clientIp(headers, "10.0.0.2", { mode: "hops", hops: 1 }), "203.0.113.9");
    assert.equal(clientIp(headers, "10.0.0.2", { mode: "hops", hops: 2 }), "6.6.6.6");
    assert.equal(clientIp(headers, "10.0.0.2", { mode: "hops", hops: 3 }), "10.0.0.2");
    assert.equal(
      clientIp({ "x-forwarded-for": ["1.1.1.1", "2.2.2.2"] }, undefined, { mode: "hops", hops: 1 }),
      "2.2.2.2",
    );
    assert.equal(clientIp(new Headers(), undefined, { mode: "none" }), "unknown");
  });

  it("trusts X-Forwarded-Proto only behind a trusted proxy", () => {
    const headers = new Headers({ "x-forwarded-proto": "https" });
    assert.equal(forwardedHttps(headers, { mode: "none" }), false);
    assert.equal(forwardedHttps(headers, { mode: "hops", hops: 1 }), true);
  });

  it("takes the token from the subprotocol list only next to zunia.connect.v2", () => {
    const offered = offeredProtocols(`zunia.connect.v2, zunia.token.${TOKEN}`);
    assert.deepEqual(offered, ["zunia.connect.v2", `zunia.token.${TOKEN}`]);
    assert.equal(tokenFromProtocols(offered), TOKEN);
    assert.equal(tokenFromProtocols([`zunia.token.${TOKEN}`]), null);
    assert.equal(tokenFromProtocols(["zunia.connect.v2"]), null);
    assert.equal(
      tokenFromProtocols(["zunia.connect.v2", `zunia.token.${TOKEN}`, `zunia.token.${"b".repeat(43)}`]),
      null,
    );
    assert.equal(tokenFromProtocols(["zunia.connect.v2", "zunia.token.short"]), null);
  });

  it("parses bearer tokens strictly", () => {
    assert.equal(bearerToken(`Bearer ${TOKEN}`), TOKEN);
    assert.equal(bearerToken(`bearer ${TOKEN}`), null);
    assert.equal(bearerToken(`Bearer ${TOKEN}x`), null);
    assert.equal(bearerToken(undefined), null);
  });
});

describe("connect/limits", () => {
  it("counts hits per window", () => {
    const limiter = new WindowLimiter(2, 1000);
    assert.equal(limiter.hit("a", 0), true);
    assert.equal(limiter.hit("a", 10), true);
    assert.equal(limiter.hit("a", 20), false);
    assert.equal(limiter.hit("b", 20), true);
    assert.equal(limiter.hit("a", 1000), true);
  });

  it("keeps a bounded key set and fails closed when it is full", () => {
    const limiter = new WindowLimiter(5, 1000, 2);
    assert.equal(limiter.hit("a", 0), true);
    assert.equal(limiter.hit("b", 0), true);
    assert.equal(limiter.hit("c", 500), false);
    assert.equal(limiter.hit("c", 1000), true);
    assert.equal(limiter.size, 1);
  });
});

describe("config/connect", () => {
  it("parses TRUST_PROXY", () => {
    assert.deepEqual(loadProxyTrust(undefined), { mode: "none" });
    assert.deepEqual(loadProxyTrust("none"), { mode: "none" });
    assert.deepEqual(loadProxyTrust("cloudflare"), { mode: "cloudflare" });
    assert.deepEqual(loadProxyTrust("1"), { mode: "hops", hops: 1 });
    assert.throws(() => loadProxyTrust("yes"));
    assert.throws(() => loadProxyTrust("-1"));
  });

  it("requires a ws or wss public base", () => {
    assert.equal(loadPublicWsBase(undefined), undefined);
    assert.equal(loadPublicWsBase("wss://api.zunialab.com/"), "wss://api.zunialab.com");
    assert.throws(() => loadPublicWsBase("https://api.zunialab.com"));
  });
});
