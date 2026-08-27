import { describe, expect, it } from "vitest";

import { buildSkillPayload } from "./skillPayload.js";

describe("buildSkillPayload", () => {
  it("rejects a malformed progressive Skill instead of downgrading it", () => {
    expect(() => buildSkillPayload([
      { path: "review.md", content: "# Review\nUse the review rules." },
    ], "skills")).toThrow("review.md: Skill frontmatter must include name and description.");
  });

  it("uses the progressive payload for valid Skills", () => {
    expect(buildSkillPayload([
      { path: "review.md", content: "---\nname: review\ndescription: Review documents.\n---\n\nReview rules." },
    ], "skills")).toEqual({
      skills: [{ content: "---\nname: review\ndescription: Review documents.\n---\n\nReview rules." }],
    });
  });

  it("preserves explicitly selected legacy payloads", () => {
    const file = { path: "legacy.md", content: "# Legacy instructions" };
    expect(buildSkillPayload([file], "legacy_markdown")).toEqual({ skill_markdown: file.content });
    expect(buildSkillPayload([file], "legacy_files")).toEqual({ skill_files: [file] });
  });
});
