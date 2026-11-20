import { describe, expect, test } from "bun:test";
import { formatScheduledReply, isReplyJson, parseReply } from "./reply.ts";

describe("parseReply", () => {
  test("reads the structured reply", () => {
    expect(parseReply('{"reply":true,"message":"Pick one","choices":["a","b"]}')).toEqual({
      reply: true,
      message: "Pick one",
      choices: ["a", "b"],
      files: [],
    });
  });

  test("falls back to plain text when the reply is not the expected JSON", () => {
    expect(parseReply("just text")).toEqual({
      reply: true,
      message: "just text",
      choices: [],
      files: [],
    });
    expect(parseReply('{"text":"x"}')).toEqual({
      reply: true,
      message: '{"text":"x"}',
      choices: [],
      files: [],
    });
  });

  test("reply: false only when Codex says so explicitly", () => {
    expect(parseReply('{"reply":false,"message":"","choices":[]}').reply).toBe(false);
    expect(parseReply('{"message":"hi","choices":[]}').reply).toBe(true);
  });

  test("cleans choices: trims, drops blanks and duplicates, caps count and length", () => {
    const long = "x".repeat(100);
    const { choices } = parseReply(
      JSON.stringify({ message: "m", choices: [" a ", "", "a", "b", "c", "d", long, "f"] }),
    );
    expect(choices.slice(0, 4)).toEqual(["a", "b", "c", "d"]);
    expect(choices).toHaveLength(5);
    expect(choices[4]).toHaveLength(75);
  });
});

describe("formatScheduledReply", () => {
  test("short results and errors include the task title", () => {
    expect(formatScheduledReply("Daily CI", "CI is green.")).toEqual({
      root: "⏰ **Daily CI**\n\nCI is green.",
    });
  });

  test("many short lines are moved into the thread too", () => {
    const text = `Summary.\n\n${Array.from({ length: 12 }, () => "detail").join("\n")}`;
    expect(formatScheduledReply("Check", text)).toEqual({
      root: "⏰ **Check**\n\nSummary.\n\nDetails in thread.",
      details: text,
    });
  });

  test("bounds the summary when the model returns one long paragraph", () => {
    const text = "x".repeat(1500);
    const result = formatScheduledReply("Check", text);
    expect(result.details).toBe(text);
    expect(result.root).toBe(`⏰ **Check**\n\n${"x".repeat(399)}…\n\nDetails in thread.`);
  });

  test("cuts the summary at a word, never inside a character or a code block", () => {
    const words = `${"word ".repeat(100)}😀`;
    const { root } = formatScheduledReply("Check", `${words}\n\n${"more ".repeat(300)}`);
    const summary = root.split("\n\n")[1] ?? "";
    expect(summary.endsWith("word…")).toBe(true);
    expect(Array.from(summary).length).toBeLessThanOrEqual(400);

    const emoji = "😀".repeat(1500);
    const cut = formatScheduledReply("Check", emoji).root.split("\n\n")[1] ?? "";
    expect(cut).toBe(`${"😀".repeat(399)}…`);

    const code = `Two failures:\n\`\`\`\n${"log line\n".repeat(200)}\`\`\``;
    expect(formatScheduledReply("Check", code).root).toBe(
      "⏰ **Check**\n\nTwo failures:…\n\nDetails in thread.",
    );
  });

  test("the task name cannot break the heading or mention people", () => {
    expect(formatScheduledReply("<!channel> *x*\nreport", "ok").root).toBe(
      "⏰ **!channel x report**\n\nok",
    );
  });
});

test("isReplyJson tells the final response from what Codex says along the way", () => {
  expect(isReplyJson('{"reply":true,"message":"Done","choices":[],"files":[]}')).toBe(true);
  expect(isReplyJson('  {"message":""}')).toBe(true);
  for (const other of ["I'll look at it.", '{"note":"no message"}', "{broken", "[1]", "null", ""]) {
    expect(isReplyJson(other)).toBe(false);
  }
});
