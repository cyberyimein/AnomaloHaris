import { describe, expect, it } from "vitest";

import { DsmlProtocolError, DsmlToolCallParser, parseDsmlContent } from "./dsml.js";

describe("DSML tool-call parser", () => {
  it("parses multiple invokes across arbitrary chunk boundaries", () => {
    const source = "先查资料。<｜DSML｜tool_calls><｜DSML｜invoke name=\"web_search\"><｜DSML｜parameter name=\"query\" string=\"true\">2026 FIFA &amp; World Cup</｜DSML｜parameter></｜DSML｜invoke><｜DSML｜invoke name=\"web_fetch\"><｜DSML｜parameter name=\"url\" string=\"true\">https://example.com/a?x=1&amp;y=2</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>结论。";
    const parser = new DsmlToolCallParser();
    const pieces = [source.slice(0, 7), source.slice(7, 19), source.slice(19, 43), source.slice(43, 88), source.slice(88)];
    const results = pieces.map((piece) => parser.feed(piece));
    const final = parser.finish();
    const text = results.map((result) => result.text).join("") + final.text;
    const calls = results.flatMap((result) => result.calls).concat(final.calls);

    expect(text).toBe("先查资料。结论。");
    expect(calls).toEqual([
      { id: "dsml_call_1", name: "web_search", arguments: { query: "2026 FIFA & World Cup" } },
      { id: "dsml_call_2", name: "web_fetch", arguments: { url: "https://example.com/a?x=1&y=2" } },
    ]);
  });

  it("supports the ASCII pipe spelling used by some gateways", () => {
    const result = parseDsmlContent('<|DSML|tool_calls><|DSML|invoke name="time_now"></|DSML|invoke></|DSML|tool_calls>');
    expect(result).toEqual({
      text: "",
      calls: [{ id: "dsml_call_1", name: "time_now", arguments: {} }],
    });
  });

  it("does not silently accept malformed markup", () => {
    const parser = new DsmlToolCallParser();
    parser.feed("answer<｜DSML｜tool_calls><｜DSML｜invoke name=\"web_search\">");
    expect(() => parser.finish()).toThrow(DsmlProtocolError);
  });
});
