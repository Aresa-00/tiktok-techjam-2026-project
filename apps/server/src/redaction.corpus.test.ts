import { describe, expect, it } from "vitest";
import { createRedactor, PLACEHOLDER } from "./redaction.js";

/**
 * Coverage corpus for the redaction middleware. Two guards:
 *
 *  - `MUST_REDACT`   — realistic credential shapes (fake values). A regression
 *                      here means a real secret format slipped through.
 *  - `MUST_NOT_TOUCH` — text that merely *looks* secret-adjacent. A regression
 *                      here means the middleware is now mangling normal output.
 *
 * Known gaps are documented at the bottom rather than hidden.
 */

const redact = createRedactor();

/** [label, input, the secret substring that must be gone afterwards] */
const MUST_REDACT: ReadonlyArray<readonly [string, string, string]> = [
  ["AWS access key id", "user AKIAIOSFODNN7EXAMPLE here", "AKIAIOSFODNN7EXAMPLE"],
  [
    "AWS secret access key (assignment)",
    "aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  ],
  [
    "GitHub classic PAT",
    "token ghp_16C7e42F292c6912E7710c838347Ae178B4a01 ok",
    "ghp_16C7e42F292c6912E7710c838347Ae178B4a01",
  ],
  [
    "GitHub fine-grained PAT",
    "github_pat_11ABCDEFG0aBcDeFgHiJkL1234567890abcdef done",
    "github_pat_11ABCDEFG0aBcDeFgHiJkL1234567890abcdef",
  ],
  [
    "GitHub OAuth token",
    "gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    "gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  ],
  [
    "Slack bot token",
    "SLACK=xoxb-2404880832-2404880832-nBnBTt6VllTeststringXX",
    "xoxb-2404880832-2404880832-nBnBTt6VllTeststringXX",
  ],
  ["Slack user token", "xoxp-1234567890-abcdefghijklmn", "xoxp-1234567890-abcdefghijklmn"],
  ["Stripe live secret key", "sk_live_4eC39HqLyjWDarjtT1zdp7dc", "sk_live_4eC39HqLyjWDarjtT1zdp7dc"],
  ["Stripe restricted key", "rk_test_abcdefghijklmnop1234", "rk_test_abcdefghijklmnop1234"],
  ["Google API key", "key=AIza" + "C".repeat(35), "AIza" + "C".repeat(35)],
  [
    "Google OAuth token",
    "ya29.a0AfH6SMByourtokenstringhere1234567890",
    "ya29.a0AfH6SMByourtokenstringhere1234567890",
  ],
  [
    "OpenAI project key",
    "sk-proj-T3BlbkFJabcdefghijklmnopqrstuvwxyz0123",
    "sk-proj-T3BlbkFJabcdefghijklmnopqrstuvwxyz0123",
  ],
  ["OpenAI legacy key", "sk-T3BlbkFJ1234567890abcdefghijklmnop", "sk-T3BlbkFJ1234567890abcdefghijklmnop"],
  [
    "Anthropic key",
    "sk-ant-api03-abcABC012_-defDEF345ghiGHI678jklJKL9",
    "sk-ant-api03-abcABC012_-defDEF345ghiGHI678jklJKL9",
  ],
  [
    "JWT",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
  ],
  [
    "RSA private key block",
    "key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAabc\n-----END RSA PRIVATE KEY-----\n",
    "MIIEpAIBAAKCAQEAabc",
  ],
  [
    "OPENSSH private key block",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA\n-----END OPENSSH PRIVATE KEY-----",
    "b3BlbnNzaC1rZXktdjEA",
  ],
  ["Bearer auth header", "authorization: Bearer abcdef1234567890XYZ", "abcdef1234567890XYZ"],
  ["Basic auth header", "Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA=="],
  [
    "credentials in https URL",
    "git clone https://ci-bot:p4ssw0rd-secret@github.com/org/repo.git",
    "p4ssw0rd-secret",
  ],
  [
    "credentials in postgres URL",
    "DATABASE_URL=postgres://admin:s3cr3tpasshere@db.internal:5432/app",
    "s3cr3tpasshere",
  ],
  [
    "SendGrid key",
    "SG.aBcDeFgHiJkLmNoPqRsTuV.wXyZ0123456789aBcDeFgHiJkLmNoPqRs",
    "SG.aBcDeFgHiJkLmNoPqRsTuV.wXyZ0123456789aBcDeFgHiJkLmNoPqRs",
  ],
  ["npm token", "//registry.npmjs.org/:_authToken=npm_" + "a".repeat(36), "npm_" + "a".repeat(36)],
  ["Twilio API key SID", "SK0a1b2c3d4e5f67890a1b2c3d4e5f6789", "SK0a1b2c3d4e5f67890a1b2c3d4e5f6789"],
  ["password assignment", "DB_PASSWORD=s3cr3t-p4ss-w0rd", "s3cr3t-p4ss-w0rd"],
  ['JSON "api_key" field', '{ "api_key": "abcd1234efgh5678ijkl", "n": 1 }', "abcd1234efgh5678ijkl"],
  ["client_secret assignment", "client_secret=abcdefghijklmnopqrstuvwxyz", "abcdefghijklmnopqrstuvwxyz"],
  ["passphrase assignment", "passphrase: correct-horse-battery-staple", "correct-horse-battery-staple"],
];

/** Text that must survive untouched — the false-positive guard. */
const MUST_NOT_TOUCH: ReadonlyArray<readonly [string, string]> = [
  ["a git commit SHA", "reverting commit 9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1908 fixed it"],
  ["a UUID", "request id 550e8400-e29b-41d4-a716-446655440000 completed in 12ms"],
  ["prose mentioning secrets", "I rotated the API key and reset the password policy after the incident."],
  [
    "an npm lockfile integrity hash",
    '"integrity": "sha512-Q5xR8lZ0Xp8kY2mN3oP4qR5sT6uV7wX8yZ9aA0bB1cC2dD3eE4fF5gG6hH7iI8jJ9kK=="',
  ],
  ["a base64 data URI", "background: url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA)"],
  ["an env var name with no value", "Set the ARK_API_KEY environment variable before starting."],
  ["a requirement note", "API_KEY is required and must be at least 20 characters."],
  ["the word bearer in prose", "the bearer of this message may not be the sender"],
  ["a hex colour and short hash", "swatch #a1b2c3, cache key ab12cd34"],
  ["the token bucket algorithm", "the token bucket algorithm smooths bursty traffic nicely"],
  ["a camelCase key named tokenBucket", '{ "userId": 42, "tokenBucket": 100, "retries": 3 }'],
  ["a phone number and extension", "call +1-415-555-0132 or dial extension 4400"],
  ["a filesystem path", "credentials live in /home/deploy/.aws/credentials on that host"],
];

/** Documentation / template values that look like assignments but are not real. */
const PLACEHOLDER_VALUES: ReadonlyArray<readonly [string, string]> = [
  ["angle-bracket placeholder", "api_key: <your-api-key-here>"],
  ["named placeholder", "password=changeme"],
  ["replace-with instruction", "api_key=replace-with-your-key"],
  ["curly template", "token = {{GITHUB_TOKEN}}"],
  ["shell interpolation", "password=${DB_PASSWORD}"],
  ["asterisk mask", "password: ********"],
];

describe("redaction corpus — MUST redact", () => {
  it.each(MUST_REDACT)("redacts %s", (_label, input, secret) => {
    const { text, matches } = redact(input);
    expect(matches.length).toBeGreaterThan(0);
    expect(text).toContain(PLACEHOLDER);
    expect(text).not.toContain(secret);
  });
});

describe("redaction corpus — MUST NOT touch (no false positives)", () => {
  it.each(MUST_NOT_TOUCH)("leaves %s untouched", (_label, input) => {
    const { text, matches } = redact(input);
    expect(text).toBe(input);
    expect(matches).toEqual([]);
  });

  it.each(PLACEHOLDER_VALUES)("does not redact %s", (_label, input) => {
    const { text, matches } = redact(input);
    expect(text).toBe(input);
    expect(matches).toEqual([]);
  });
});

/**
 * Known gaps — intentionally not covered by the current rule set. Documented
 * here so the demo can be honest about scope. Adding entropy-based detection
 * (Tier 3, item 9) would close most of these.
 */
describe("redaction corpus — known gaps", () => {
  it.each([
    ["a bare 40-char hex token with no keyword", "deploy key 1f3d5b7902468ace1f3d5b7902468ace1f3d5b79"],
    ["a bare high-entropy base64 blob", "value dGhpcyBpcyBub3QgcmVhbGx5IGEgc2VjcmV0IGJsb2I="],
  ])("does not yet catch %s", (_label, input) => {
    expect(redact(input).text).toBe(input);
  });
});
