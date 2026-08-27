import { describe, expect, it } from "vitest";

import { pluginBindingsForTools } from "./pluginBindings.js";

describe("pluginBindingsForTools", () => {
  it("binds both the Pi adapter and the owning custom plugin", () => {
    expect(pluginBindingsForTools(
      ["time_now", "web_search", "buddy.status"],
      [
        { name: "time_now", source: "host-core" },
        { name: "web_search", source: "web" },
        { name: "buddy.status", source: "buddy-plugin" },
      ],
    )).toEqual(["host-core", "web", "pi-plugin-host", "buddy-plugin"]);
  });

  it("does not turn the intrinsic Skill adapter into a plugin binding", () => {
    expect(pluginBindingsForTools(
      ["skill_activate"],
      [{ name: "skill_activate", source: "agent-skill" }],
    )).toEqual(["host-core"]);
  });
});
