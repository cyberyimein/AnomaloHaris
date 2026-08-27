export function buildSkillPayload(skillFiles, format) {
  if (!skillFiles.length) return {};
  if (format === "skills") {
    const invalid = skillFiles.find((file) => !frontmatterValue(file.content, "name") || !frontmatterValue(file.content, "description"));
    if (invalid) throw new Error(`${invalid.path}: Skill frontmatter must include name and description.`);
    return { skills: skillFiles.map((file) => ({ content: file.content })) };
  }
  if (format === "legacy_markdown" && skillFiles.length === 1) {
    return { skill_markdown: skillFiles[0].content };
  }
  return { skill_files: skillFiles };
}

function frontmatterValue(content, key) {
  const source = String(content || "");
  if (!source.trimStart().startsWith("---")) return "";
  const match = source.match(new RegExp(`^${key}\\s*:\\s*(.+)$`, "mi"));
  return match?.[1]?.trim().replace(/^(?:"([\\s\\S]*)"|'([\\s\\S]*)')$/, "$1$2") || "";
}
