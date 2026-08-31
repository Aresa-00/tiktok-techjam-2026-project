/**
 * Secret redaction used by the {@link RedactingRunner} middleware.
 *
 * The redactor is a pure function: it takes the text an Agent is about to
 * return (or an error message on the failure path) and produces a copy with
 * anything that looks like a credential replaced by {@link PLACEHOLDER}. It
 * also reports what it removed so callers can record the event without ever
 * touching the secret value itself.
 */

export interface RedactionMatch {
  /** Stable identifier for the kind of secret that was found. */
  rule: string;
  /** Length of the original match. Never the value, so it is safe to log. */
  length: number;
}

export interface RedactionOutcome {
  /** The input with every detected secret replaced. */
  text: string;
  /** One entry per replacement, in the order they were applied. */
  matches: RedactionMatch[];
}

export type Redactor = (input: string) => RedactionOutcome;

export interface RedactorOptions {
  /**
   * Exact secret values that must never appear in output, for example the
   * configured Ark API key or the shared demo token. Empty, whitespace, and
   * very short values are ignored so we never blanket-redact common words.
   */
  literals?: readonly (string | undefined)[];
}

export const PLACEHOLDER = "[REDACTED]";
const MIN_LITERAL_LENGTH = 6;

/**
 * A rule's `mask` returns the replacement text, or `null` to signal "this
 * looked like a secret but is a placeholder / documentation value" — the match
 * is then left untouched and not counted.
 */
interface Rule {
  name: string;
  pattern: RegExp;
  mask: (match: string, groups: readonly (string | undefined)[]) => string | null;
}

const maskWhole = (): string => PLACEHOLDER;

/** Value token that stops before quotes, separators, and our own placeholder. */
const VALUE = "[^\\s\"',;{}\\[\\]]{3,}";
const SECRET_KEYS =
  "password|passwd|passphrase|pass|pwd|secret|api[_-]?key|apikey" +
  "|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret" +
  "|auth[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?token|token";

/** Lowercased values that are obviously not real secrets. */
const NON_SECRET_VALUES = new Set([
  "required", "optional", "true", "false", "null", "none", "nil", "undefined",
  "todo", "tbd", "changeme", "change-me", "example", "your-api-key",
  "your_api_key", "your-token", "redacted", "placeholder", "string", "number",
  "value", "xxx", "xxxx", "xxxxxxxx", "test", "dummy", "fake", "secret",
]);

function isPlaceholderValue(value: string): boolean {
  if (NON_SECRET_VALUES.has(value.toLowerCase())) return true;
  if (/^[<{[(].*[>}\])]$/.test(value)) return true; // <your-key>, {{TOKEN}}
  if (/^\$[A-Za-z_{(]/.test(value)) return true; // $VAR, ${VAR}, $(VAR)
  if (/^[*.\-_·•]+$/.test(value)) return true; // ****, ----, ...
  if (/replace[-_]?(with|me)?/i.test(value)) return true; // replace-with-your-id
  return false;
}

const RULES: readonly Rule[] = [
  {
    name: "private-key-block",
    pattern:
      /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
    mask: maskWhole,
  },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
    mask: maskWhole,
  },
  {
    name: "anthropic-key",
    pattern: /\bsk-ant-[A-Za-z0-9-]{2,}-[A-Za-z0-9_-]{20,}/g,
    mask: maskWhole,
  },
  {
    name: "openai-key",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
    mask: maskWhole,
  },
  {
    name: "github-token",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
    mask: maskWhole,
  },
  {
    name: "github-fine-grained-token",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    mask: maskWhole,
  },
  {
    name: "aws-access-key-id",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    mask: maskWhole,
  },
  {
    name: "google-api-key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    mask: maskWhole,
  },
  {
    name: "google-oauth-token",
    pattern: /\bya29\.[A-Za-z0-9._-]{20,}/g,
    mask: maskWhole,
  },
  {
    name: "slack-token",
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
    mask: maskWhole,
  },
  {
    name: "stripe-key",
    pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{10,}/g,
    mask: maskWhole,
  },
  {
    name: "sendgrid-key",
    pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
    mask: maskWhole,
  },
  {
    name: "npm-token",
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/g,
    mask: maskWhole,
  },
  {
    name: "twilio-key",
    pattern: /\bSK[0-9a-fA-F]{32}\b/g,
    mask: maskWhole,
  },
  {
    name: "url-credentials",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi,
    mask: (_match, groups) => (groups[0] ?? "") + PLACEHOLDER + "@",
  },
  {
    name: "authorization-scheme",
    pattern: /\b(Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{8,})/gi,
    mask: (_match, groups) => (groups[0] ?? "") + " " + PLACEHOLDER,
  },
  {
    name: "secret-assignment",
    // Lookbehind rather than \b so that `DB_PASSWORD` / `AWS_SECRET_KEY` (where
    // the keyword follows an underscore) still match, while `mypassword` does not.
    pattern: new RegExp(
      "(?<![A-Za-z0-9])(" +
        SECRET_KEYS +
        ")([\"']?\\s*[:=]\\s*[\"']?)(" +
        VALUE +
        ")([\"']?)",
      "gi",
    ),
    mask: (_match, groups) => {
      if (isPlaceholderValue(groups[2] ?? "")) return null;
      return (groups[0] ?? "") + (groups[1] ?? "") + PLACEHOLDER + (groups[3] ?? "");
    },
  },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a redactor. The returned function is stateless and reusable across
 * turns and Agents.
 */
export function createRedactor(options: RedactorOptions = {}): Redactor {
  const literalRules: Rule[] = [];
  const seen = new Set<string>();
  for (const literal of options.literals ?? []) {
    const value = literal?.trim();
    if (!value || value.length < MIN_LITERAL_LENGTH || seen.has(value)) {
      continue;
    }
    seen.add(value);
    literalRules.push({
      name: "known-secret",
      pattern: new RegExp(escapeRegExp(value), "g"),
      mask: maskWhole,
    });
  }
  const rules: readonly Rule[] = [...literalRules, ...RULES];

  return (input: string): RedactionOutcome => {
    const matches: RedactionMatch[] = [];
    let text = input;
    for (const rule of rules) {
      text = text.replace(rule.pattern, (...args: unknown[]): string => {
        const match = args[0] as string;
        const groups = args.slice(1, -2) as (string | undefined)[];
        const masked = rule.mask(match, groups);
        if (masked === null || masked === match) {
          return match;
        }
        matches.push({ rule: rule.name, length: match.length });
        return masked;
      });
    }
    return { text, matches };
  };
}
