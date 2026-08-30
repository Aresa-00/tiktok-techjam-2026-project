import { describe, expect, it } from "vitest";
import { createRedactor, PLACEHOLDER } from "./redaction.js";

const redact = createRedactor();

describe("secret redaction", () => {
  it("masks the value of a key/value assignment but keeps the key", () => {
    const { text, matches } = redact("DB_PASSWORD=hunter2-super-secret rest");
    expect(text).toBe("DB_PASSWORD=" + PLACEHOLDER + " rest");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.rule).toBe("secret-assignment");
  });

  it("masks quoted JSON-style secrets", () => {
    const input = '{ "api_key": "abcd1234efgh5678", "port": 3000 }';
    const { text } = redact(input);
    expect(text).toBe('{ "api_key": "' + PLACEHOLDER + '", "port": 3000 }');
  });

  it.each([
    ["openai-key", "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX1234567890abcd"],
    ["anthropic-key", "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"],
    ["github-token", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"],
    ["github-fine-grained-token", "github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123"],
    ["aws-access-key-id", "AKIAIOSFODNN7EXAMPLE"],
    ["google-api-key", "AIza" + "b".repeat(35)],
    ["slack-token", "xoxb-123456789012-abcdefghijklmnop"],
    ["stripe-key", "sk_live_ABCDEFGHIJKLMNOP1234"],
  ])("masks a %s token anywhere in the text", (rule, token) => {
    const { text, matches } = redact("here it is: " + token + " ok");
    expect(text).toBe("here it is: " + PLACEHOLDER + " ok");
    expect(matches.map((match) => match.rule)).toContain(rule);
  });

  it("masks bearer and basic authorization headers", () => {
    const { text } = redact(
      "Authorization: Bearer eyJhbGciiOiJIUzI1Ni9.payloadpart.signature-part",
    );
    expect(text).toContain("Bearer " + PLACEHOLDER);
    expect(text).not.toContain("payloadpart");
  });

  it("masks credentials embedded in a URL", () => {
    const { text } = redact("clone https://ci-bot:s3cr3t-token@example.com/repo.git");
    expect(text).toBe(
      "clone https://ci-bot:" + PLACEHOLDER + "@example.com/repo.git",
    );
  });

  it("masks a PEM private key block", () => {
    const input =
      "key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----\ndone";
    const { text, matches } = redact(input);
    expect(text).toBe("key:\n" + PLACEHOLDER + "\ndone");
    expect(matches[0]?.rule).toBe("private-key-block");
  });

  it("masks exact known secret literals passed by configuration", () => {
    const withLiterals = createRedactor({
      literals: ["ark-live-key-9f8e7d6c", undefined, "short"],
    });
    const { text, matches } = withLiterals(
      "connecting with ark-live-key-9f8e7d6c now (short is fine)",
    );
    expect(text).toBe("connecting with " + PLACEHOLDER + " now (short is fine)");
    expect(matches).toEqual([{ rule: "known-secret", length: 21 }]);
  });

  it("leaves ordinary prose about secrets untouched", () => {
    const input =
      "I refactored the password reset flow and rotated the API key in the console.";
    const { text, matches } = redact(input);
    expect(text).toBe(input);
    expect(matches).toEqual([]);
  });

  it("returns the input unchanged when there is nothing to redact", () => {
    expect(redact("")).toEqual({ text: "", matches: [] });
    expect(redact("plain output, no secrets").matches).toEqual([]);
  });

  it("is idempotent", () => {
    const input =
      'password=topsecret123 and token: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"';
    const once = redact(input).text;
    expect(redact(once).text).toBe(once);
    expect(once).not.toContain("topsecret123");
    expect(once).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
  });
});
