import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  estimateTokens,
  estimateMessageTokens,
  detectCodeComplexity,
  detectMathComplexity,
  detectReasoningDepth,
  detectContextSize,
  detectToolCalling,
  detectDomainSpecificity,
  getSpecificityBreakdown,
  detectConversationDepth,
  detectFileReferences,
  detectErrorContext,
  detectEnhancedContextSize,
  getEnhancedSpecificityBreakdown,
} from "../../open-sse/services/specificityRules.ts";
import type { RuleInput } from "../../open-sse/services/specificityTypes.ts";

function input(overrides: Partial<RuleInput> = {}): RuleInput {
  return { messages: [], ...overrides };
}

describe("estimateTokens", () => {
  it("estimates roughly 4 chars per token", () => {
    assert.equal(estimateTokens("abcd"), 1);
    assert.equal(estimateTokens("abcdefgh"), 2);
  });

  it("returns 0 for empty string", () => {
    assert.equal(estimateTokens(""), 0);
  });

  it("rounds up for partial tokens", () => {
    assert.equal(estimateTokens("abcde"), 2);
  });
});

describe("estimateMessageTokens", () => {
  it("sums tokens across string-content messages", () => {
    const total = estimateMessageTokens([{ content: "abcd" }, { content: "abcdefgh" }]);
    assert.equal(total, 3);
  });

  it("handles array content with text parts", () => {
    const total = estimateMessageTokens([
      { content: [{ text: "abcd" }, { text: "abcd" }] },
    ]);
    assert.equal(total, 2);
  });

  it("ignores array parts without a text field", () => {
    const total = estimateMessageTokens([{ content: [{ type: "image_url" }] }]);
    assert.equal(total, 0);
  });

  it("ignores non-string, non-array content", () => {
    const total = estimateMessageTokens([{ content: undefined }, { content: 42 as unknown as string }]);
    assert.equal(total, 0);
  });

  it("returns 0 for an empty messages array", () => {
    assert.equal(estimateMessageTokens([]), 0);
  });
});

describe("detectCodeComplexity", () => {
  it("returns 0 for plain prose", () => {
    assert.equal(detectCodeComplexity(input({ messages: [{ content: "hello there" }] })), 0);
  });

  it("scores fenced code blocks", () => {
    const score = detectCodeComplexity(
      input({ messages: [{ content: "```js\nconst x = 1;\n```" }] })
    );
    assert.ok(score > 0);
  });

  it("scores inline code lower than fenced blocks", () => {
    const fenced = detectCodeComplexity(input({ messages: [{ content: "```\ncode\n```" }] }));
    const inline = detectCodeComplexity(input({ messages: [{ content: "`code`" }] }));
    assert.ok(fenced >= inline);
  });

  it("detects language indicators like function/class/import", () => {
    const score = detectCodeComplexity(
      input({
        messages: [
          { content: "function foo() {} class Bar {} import x from 'y'" },
        ],
      })
    );
    assert.ok(score > 0);
  });

  it("caps the score at 25", () => {
    const repeated = "```js\nconst x = 1;\n```\n".repeat(50);
    const score = detectCodeComplexity(input({ messages: [{ content: repeated }] }));
    assert.equal(score, 25);
  });

  it("ignores non-string message content", () => {
    assert.equal(detectCodeComplexity(input({ messages: [{ content: undefined }] })), 0);
  });
});

describe("detectMathComplexity", () => {
  it("returns 0 for text without math", () => {
    assert.equal(detectMathComplexity(input({ messages: [{ content: "just words" }] })), 0);
  });

  it("scores LaTeX blocks", () => {
    const score = detectMathComplexity(input({ messages: [{ content: "$$x^2 + y^2 = z^2$$" }] }));
    assert.ok(score > 0);
  });

  it("scores math keywords like sin/cos/sqrt", () => {
    const score = detectMathComplexity(
      input({ messages: [{ content: "compute sin(x) and sqrt(y)" }] })
    );
    assert.ok(score > 0);
  });

  it("caps the score at 20", () => {
    const repeated = "$$1+1=2$$ sin cos tan sqrt sum ".repeat(50);
    const score = detectMathComplexity(input({ messages: [{ content: repeated }] }));
    assert.equal(score, 20);
  });
});

describe("detectReasoningDepth", () => {
  it("returns the message-depth bonus alone for plain text", () => {
    const score = detectReasoningDepth(input({ messages: [{ content: "hi" }] }));
    assert.equal(score, 1);
  });

  it("scores reasoning indicator phrases", () => {
    const withReasoning = detectReasoningDepth(
      input({ messages: [{ content: "First, we need to consider this. Therefore, thus we conclude." }] })
    );
    const withoutReasoning = detectReasoningDepth(input({ messages: [{ content: "hi" }] }));
    assert.ok(withReasoning > withoutReasoning);
  });

  it("adds a message-depth bonus capped at 5", () => {
    const messages = Array.from({ length: 10 }, () => ({ content: "plain" }));
    const score = detectReasoningDepth(input({ messages }));
    assert.equal(score, 5);
  });

  it("caps the total score at 20", () => {
    const repeated = "First, therefore, thus, because, since, let me think, step by step. ".repeat(20);
    const messages = Array.from({ length: 10 }, () => ({ content: repeated }));
    const score = detectReasoningDepth(input({ messages }));
    assert.equal(score, 20);
  });
});

describe("detectContextSize", () => {
  it("returns 0 for short conversations", () => {
    assert.equal(detectContextSize(input({ messages: [{ content: "hi" }] })), 0);
  });

  it("returns increasing tiers as token count grows", () => {
    const makeMessages = (tokens: number) => [{ content: "a".repeat(tokens * 4) }];
    assert.equal(detectContextSize(input({ messages: makeMessages(1500) })), 2);
    assert.equal(detectContextSize(input({ messages: makeMessages(5000) })), 4);
    assert.equal(detectContextSize(input({ messages: makeMessages(9000) })), 6);
    assert.equal(detectContextSize(input({ messages: makeMessages(17000) })), 9);
    assert.equal(detectContextSize(input({ messages: makeMessages(33000) })), 12);
    assert.equal(detectContextSize(input({ messages: makeMessages(65000) })), 15);
  });
});

describe("detectToolCalling", () => {
  it("returns 0 when no tools are provided", () => {
    assert.equal(detectToolCalling(input()), 0);
    assert.equal(detectToolCalling(input({ tools: [] })), 0);
  });

  it("scales with the number of tools", () => {
    const toolOf = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ function: { name: `tool${i}` } }));
    assert.equal(detectToolCalling(input({ tools: toolOf(1) })), 2);
    assert.equal(detectToolCalling(input({ tools: toolOf(3) })), 4);
    assert.equal(detectToolCalling(input({ tools: toolOf(6) })), 6);
    assert.equal(detectToolCalling(input({ tools: toolOf(11) })), 8);
    assert.equal(detectToolCalling(input({ tools: toolOf(21) })), 10);
  });
});

describe("detectDomainSpecificity", () => {
  it("returns 0 for generic text", () => {
    assert.equal(detectDomainSpecificity(input({ messages: [{ content: "hello world" }] })), 0);
  });

  it("detects medical domain terms", () => {
    const score = detectDomainSpecificity(
      input({ messages: [{ content: "The patient's diagnosis and treatment plan look clinical." }] })
    );
    assert.ok(score > 0);
  });

  it("detects legal domain terms", () => {
    const score = detectDomainSpecificity(
      input({ messages: [{ content: "Pursuant to the statute, liability falls under this jurisdiction." }] })
    );
    assert.ok(score > 0);
  });

  it("caps the score at 10", () => {
    const score = detectDomainSpecificity(
      input({
        messages: [
          {
            content:
              "diagnosis symptoms treatment patient clinical pursuant statute liability jurisdiction hereby",
          },
        ],
      })
    );
    assert.equal(score, 10);
  });
});

describe("getSpecificityBreakdown", () => {
  it("combines all rule scores into a breakdown object", () => {
    const breakdown = getSpecificityBreakdown(
      input({ messages: [{ content: "```js\nconst x = 1;\n```" }] })
    );
    assert.ok(breakdown.codeComplexity > 0);
    assert.equal(breakdown.mathComplexity, 0);
    assert.ok("reasoningDepth" in breakdown);
    assert.ok("contextSize" in breakdown);
    assert.ok("toolCalling" in breakdown);
    assert.ok("domainSpecificity" in breakdown);
  });
});

describe("detectConversationDepth", () => {
  it("returns 0 for short conversations", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    assert.equal(detectConversationDepth(input({ messages })), 0);
  });

  it("scales with the number of user+assistant turns", () => {
    const turnsOf = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: "msg",
      }));
    assert.equal(detectConversationDepth(input({ messages: turnsOf(6) })), 2);
    assert.equal(detectConversationDepth(input({ messages: turnsOf(11) })), 4);
    assert.equal(detectConversationDepth(input({ messages: turnsOf(21) })), 6);
    assert.equal(detectConversationDepth(input({ messages: turnsOf(31) })), 8);
  });

  it("ignores messages with no role", () => {
    assert.equal(detectConversationDepth(input({ messages: [{ content: "x" }] })), 0);
  });
});

describe("detectFileReferences", () => {
  it("returns 0 for text without file-like references", () => {
    assert.equal(detectFileReferences(input({ messages: [{ content: "just words" }] })), 0);
  });

  it("detects file paths", () => {
    const score = detectFileReferences(
      input({ messages: [{ content: "see /src/lib/db/core.ts for details" }] })
    );
    assert.ok(score > 0);
  });

  it("detects diff/patch keywords", () => {
    const score = detectFileReferences(input({ messages: [{ content: "please review this diff/patch" }] }));
    assert.ok(score > 0);
  });

  it("caps the score at 5", () => {
    const repeated = "/a/b/c.ts /d/e/f.ts README CHANGELOG TODO diff patch merge ".repeat(5);
    const score = detectFileReferences(input({ messages: [{ content: repeated }] }));
    assert.equal(score, 5);
  });
});

describe("detectErrorContext", () => {
  it("returns 0 for text without error indicators", () => {
    assert.equal(detectErrorContext(input({ messages: [{ content: "all good here" }] })), 0);
  });

  it("detects error/exception keywords", () => {
    const score = detectErrorContext(
      input({ messages: [{ content: "TypeError: cannot read property of undefined" }] })
    );
    assert.ok(score > 0);
  });

  it("detects stack trace lines", () => {
    const score = detectErrorContext(
      input({ messages: [{ content: "at handleRequest (server.js:42:10)" }] })
    );
    assert.ok(score > 0);
  });

  it("caps the score at 5", () => {
    const repeated = "Error Exception TypeError ReferenceError SyntaxError throw catch finally failed crashed ".repeat(5);
    const score = detectErrorContext(input({ messages: [{ content: repeated }] }));
    assert.equal(score, 5);
  });
});

describe("detectEnhancedContextSize", () => {
  it("returns 0 for a small conversation with no system prompt or tools", () => {
    assert.equal(detectEnhancedContextSize(input({ messages: [{ content: "hi" }] })), 0);
  });

  it("includes system prompt tokens in the total", () => {
    const withSystemPrompt = detectEnhancedContextSize(
      input({ messages: [{ content: "hi" }], systemPrompt: "x".repeat(20000) })
    );
    assert.ok(withSystemPrompt > 0);
  });

  it("includes tool schema tokens in the total", () => {
    const withTools = detectEnhancedContextSize(
      input({
        messages: [{ content: "hi" }],
        tools: [{ function: { name: "search", description: "y".repeat(20000) } }],
      })
    );
    assert.ok(withTools > 0);
  });

  it("returns higher tiers for very large combined context", () => {
    const score = detectEnhancedContextSize(
      input({ messages: [{ content: "z".repeat(500000) }] })
    );
    assert.equal(score, 15);
  });
});

describe("getEnhancedSpecificityBreakdown", () => {
  it("uses the enhanced context-size detector instead of the basic one", () => {
    const largeInput = input({
      messages: [{ content: "hi" }],
      systemPrompt: "x".repeat(20000),
    });
    const basic = getSpecificityBreakdown(largeInput);
    const enhanced = getEnhancedSpecificityBreakdown(largeInput);
    // The basic breakdown ignores systemPrompt tokens entirely, while the
    // enhanced one factors them into contextSize.
    assert.equal(basic.contextSize, 0);
    assert.ok(enhanced.contextSize > 0);
  });
});
