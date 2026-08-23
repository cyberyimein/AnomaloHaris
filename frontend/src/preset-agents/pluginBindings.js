export function pluginBindingsForTools(toolNames, tools) {
  const fixed = new Set(["host-core"]);
  for (const toolName of toolNames) {
    const source = tools.find((tool) => tool.name === toolName)?.source;
    if (source === "web" || toolName === "web_search" || toolName === "web_fetch") {
      fixed.add("web");
    } else if (source === "browser-bridge" || toolName.startsWith("browser.")) {
      fixed.add("browser-bridge");
    } else if (source && source !== "host-core") {
      fixed.add("pi-plugin-host");
      fixed.add(source);
    }
  }
  return [...fixed];
}
