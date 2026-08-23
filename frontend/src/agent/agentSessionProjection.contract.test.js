import { describe, expect, it } from "vitest";

import sharedFixtures from "@anomalo/contracts/fixtures/agent-events.json";
import { createAgentSessionProjection } from "./agentSessionProjection";

describe("shared Node event fixture projection", () => {
  it("keeps the existing UI projection for schema-versioned events", () => {
    const projection = createAgentSessionProjection({
      renderMarkdown: (content) => `<p>${content}</p>`,
      onScroll: () => {},
      onRefresh: () => {},
    });

    projection.beginUserTurn("fixture request");
    sharedFixtures.normal_text.forEach((event) => projection.handle(event));

    expect(projection.state.runTitle.value).toBe("Complete");
    expect(projection.state.agentState.value).toBe("Done");
    expect(projection.state.conversationTurns.value.at(-1)).toMatchObject({
      role: "assistant",
      content: "Replay complete.",
    });
  });
});
