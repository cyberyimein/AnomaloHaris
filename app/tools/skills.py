import importlib.util
import inspect
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any

import yaml
from pydantic import TypeAdapter

from app.tools.base import (
    ToolContext,
    ToolProvider,
    ToolResult,
    ToolSpec,
    call_maybe_async,
    ensure_tool_name,
)


ACTIVATE_TOOL_NAME = "skill_activate"
DEACTIVATE_TOOL_NAME = "skill_deactivate"
SKILL_ROUTER_SOURCE = "skill-router"
SKILL_FILENAME = "SKILL.md"
TOOLS_MODULE_NAME = "tools.py"


@dataclass(frozen=True)
class SkillDocument:
    raw_name: str
    description: str
    enabled: bool
    instructions: str


@dataclass(frozen=True)
class SkillToolDefinition:
    name: str
    public_name: str
    function_name: str
    description: str
    parameters: dict[str, Any]


@dataclass(frozen=True)
class SkillDefinition:
    name: str
    display_name: str
    description: str
    enabled: bool
    skill_dir: Path
    instructions: str
    tools: tuple[SkillToolDefinition, ...]

    @property
    def instructions_path(self) -> Path:
        return self.skill_dir / SKILL_FILENAME

    @property
    def tool_module_path(self) -> Path:
        return self.skill_dir / TOOLS_MODULE_NAME

    @property
    def when_to_use(self) -> str:
        return self.description

    def tool_names(self) -> list[str]:
        return [tool.public_name for tool in self.tools]


class SkillProvider(ToolProvider):
    def __init__(self, skills_dir: Path) -> None:
        self.skills_dir = skills_dir

    async def list_tools(self, context: ToolContext | None = None) -> list[ToolSpec]:
        definitions = [definition for definition in _load_skill_definitions(self.skills_dir) if definition.enabled]
        tools: list[ToolSpec] = []
        if definitions:
            tools.extend(_skill_control_tools(definitions))

        active_skill_names = (
            {definition.name for definition in definitions}
            if context is None
            else set(context.active_skills)
        )
        for definition in definitions:
            if definition.name not in active_skill_names:
                continue
            for tool in definition.tools:
                tools.append(
                    ToolSpec(
                        name=tool.public_name,
                        source=f"skill:{definition.name}",
                        description=tool.description or definition.description,
                        parameters=tool.parameters,
                    )
                )
        return tools

    async def call_tool(
        self,
        name: str,
        arguments: dict[str, Any],
        context: ToolContext | None = None,
    ) -> ToolResult:
        definitions = {
            definition.name: definition
            for definition in _load_skill_definitions(self.skills_dir)
            if definition.enabled
        }

        if name == ACTIVATE_TOOL_NAME:
            return _activate_skill(definitions, arguments, context)

        if name == DEACTIVATE_TOOL_NAME:
            return _deactivate_skill(definitions, arguments, context)

        active_skill_names = set(definitions) if context is None else set(context.active_skills)
        for definition in definitions.values():
            for tool in definition.tools:
                if tool.public_name != name:
                    continue
                if definition.name not in active_skill_names:
                    return ToolResult(
                        name=name,
                        ok=False,
                        content=(
                            f"Skill '{definition.display_name}' is not active. "
                            f"Call {ACTIVATE_TOOL_NAME} with skill_name='{definition.name}' first."
                        ),
                    )

                module = _load_module(definition.tool_module_path, f"anomalo_skill_{definition.name}")
                func = getattr(module, tool.function_name, None)
                if func is None:
                    return ToolResult(
                        name=name,
                        ok=False,
                        content=f"Skill function not found: {tool.function_name}",
                    )

                try:
                    value = await call_maybe_async(func, **arguments)
                except Exception as exc:  # noqa: BLE001
                    return ToolResult(name=name, ok=False, content=f"Skill error: {exc}")

                return ToolResult(
                    name=name,
                    content=str(value),
                    data={
                        "value": value,
                        "skill_name": definition.name,
                        "display_name": definition.display_name,
                    },
                )

        return ToolResult(name=name, ok=False, content=f"Skill tool not found: {name}")

    async def status(self, context: ToolContext | None = None) -> dict[str, Any]:
        definitions = _load_skill_definitions(self.skills_dir)
        return {
            "skills": [_definition_payload(definition, active=False) for definition in definitions],
            "tools": [tool.model_dump() for tool in await self.list_tools(context=context)],
        }


class SkillManager:
    def __init__(self, skills_dir: Path) -> None:
        self.skills_dir = skills_dir

    def list_skills(self, active_skill_names: set[str] | None = None) -> list[dict[str, Any]]:
        active = active_skill_names or set()
        return [
            _definition_payload(definition, active=definition.name in active)
            for definition in _load_skill_definitions(self.skills_dir)
        ]

    def skill_catalog_message(self) -> dict[str, str] | None:
        definitions = [definition for definition in _load_skill_definitions(self.skills_dir) if definition.enabled]
        if not definitions:
            return None

        entries = []
        for definition in definitions:
            tool_list = ", ".join(definition.tool_names()) or "context only"
            entries.append(
                "\n".join(
                    [
                        f"- {definition.display_name} ({definition.name})",
                        f"  Summary: {definition.description}",
                        f"  Activate when: {definition.when_to_use}",
                        f"  Tools after activation: {tool_list}",
                    ]
                )
            )

        return {
            "role": "system",
            "content": "\n".join(
                [
                    "Available agent skills follow the standard SKILL.md format with YAML frontmatter.",
                    f"If a request clearly matches one of them, call {ACTIVATE_TOOL_NAME} before using that skill's tools.",
                    "Manual session skill selection may already have activated some skills.",
                    "",
                    *entries,
                ]
            ),
        }

    def build_active_skill_messages(self, active_skill_names: set[str]) -> list[dict[str, str]]:
        definitions = {
            definition.name: definition
            for definition in _load_skill_definitions(self.skills_dir)
            if definition.enabled
        }
        messages: list[dict[str, str]] = []
        for skill_name in sorted(active_skill_names):
            definition = definitions.get(skill_name)
            if definition is None:
                continue
            tool_list = ", ".join(definition.tool_names()) or "No tools. This skill adds context only."
            content_parts = [
                f"Activated agent skill: {definition.display_name} ({definition.name})",
                f"Summary: {definition.description}",
                f"Use this skill when: {definition.when_to_use}",
                f"Available tools for this skill: {tool_list}",
            ]
            instructions = definition.instructions.strip()
            if instructions:
                content_parts.extend(["", "Skill instructions:", instructions])
            messages.append({"role": "system", "content": "\n".join(content_parts)})
        return messages

    def create_skill(self, name: str, description: str = "", enabled: bool = True) -> dict[str, Any]:
        skill_name = ensure_tool_name(name)
        skill_dir = self.skills_dir / skill_name
        skill_dir.mkdir(parents=True, exist_ok=True)

        skill_path = skill_dir / SKILL_FILENAME
        if skill_path.exists():
            msg = f"Skill already exists: {skill_name}"
            raise ValueError(msg)

        skill_path.write_text(
            _serialize_skill_document(
                name=skill_name,
                description=description or f"{skill_name} skill",
                instructions="\n".join(
                    [
                        f"# {skill_name}",
                        "",
                        description or "Describe what this skill handles and how it should behave once activated.",
                        "",
                        "Add concrete device constraints, safety rules, and output style here.",
                    ]
                ),
                enabled=enabled,
            ),
            encoding="utf-8",
        )
        (skill_dir / TOOLS_MODULE_NAME).write_text(
            "def ping(message: str = \"pong\") -> str:\n"
            "    \"\"\"Return a short response from this skill.\"\"\"\n"
            "    return message\n",
            encoding="utf-8",
        )
        return _definition_payload(_load_skill_definition(skill_dir), active=False)

    def set_enabled(self, name: str, enabled: bool) -> dict[str, Any]:
        skill_name = ensure_tool_name(name)
        skill_dir = self.skills_dir / skill_name
        skill_path = skill_dir / SKILL_FILENAME
        if not skill_path.exists():
            msg = f"Skill not found: {skill_name}"
            raise FileNotFoundError(msg)

        document = _load_skill_document(skill_path, default_name=skill_dir.name)
        skill_path.write_text(
            _serialize_skill_document(
                name=skill_name,
                description=document.description,
                instructions=document.instructions,
                enabled=enabled,
            ),
            encoding="utf-8",
        )
        return _definition_payload(_load_skill_definition(skill_dir), active=False)


def _load_skill_definitions(skills_dir: Path) -> list[SkillDefinition]:
    skills_dir.mkdir(parents=True, exist_ok=True)
    definitions: list[SkillDefinition] = []
    for skill_dir in sorted(path for path in skills_dir.iterdir() if path.is_dir()):
        skill_path = skill_dir / SKILL_FILENAME
        if not skill_path.exists():
            continue
        definitions.append(_load_skill_definition(skill_dir))
    return definitions


def _load_skill_definition(skill_dir: Path) -> SkillDefinition:
    document = _load_skill_document(skill_dir / SKILL_FILENAME, default_name=skill_dir.name)
    skill_name = ensure_tool_name(document.raw_name or skill_dir.name)
    tools = _discover_skill_tools(skill_dir, skill_name, document.raw_name or skill_name)
    return SkillDefinition(
        name=skill_name,
        display_name=document.raw_name or skill_name,
        description=document.description,
        enabled=document.enabled,
        skill_dir=skill_dir,
        instructions=document.instructions,
        tools=tuple(tools),
    )


def _definition_payload(definition: SkillDefinition, *, active: bool) -> dict[str, Any]:
    return {
        "name": definition.name,
        "display_name": definition.display_name,
        "description": definition.description,
        "when_to_use": definition.when_to_use,
        "enabled": definition.enabled,
        "active": active,
        "path": str(definition.skill_dir),
        "instructions_path": str(definition.instructions_path),
        "tool_names": definition.tool_names(),
        "tool_count": len(definition.tools),
    }


def _skill_control_tools(definitions: list[SkillDefinition]) -> list[ToolSpec]:
    enabled_names = [definition.name for definition in definitions]
    skill_choices = ", ".join(
        f"{definition.name}: {definition.description}" for definition in definitions
    )
    return [
        ToolSpec(
            name=ACTIVATE_TOOL_NAME,
            source=SKILL_ROUTER_SOURCE,
            description=(
                "Activate an agent skill so its detailed instructions and related tools are added "
                f"to the current session context. Available skills: {skill_choices}"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "skill_name": {
                        "type": "string",
                        "enum": enabled_names,
                        "description": "Machine name of the skill to activate.",
                    }
                },
                "required": ["skill_name"],
                "additionalProperties": False,
            },
        ),
        ToolSpec(
            name=DEACTIVATE_TOOL_NAME,
            source=SKILL_ROUTER_SOURCE,
            description="Deactivate an active skill and remove its tools from the session.",
            parameters={
                "type": "object",
                "properties": {
                    "skill_name": {
                        "type": "string",
                        "enum": enabled_names,
                        "description": "Machine name of the skill to deactivate.",
                    }
                },
                "required": ["skill_name"],
                "additionalProperties": False,
            },
        ),
    ]


def _activate_skill(
    definitions: dict[str, SkillDefinition],
    arguments: dict[str, Any],
    context: ToolContext | None,
) -> ToolResult:
    skill_name = ensure_tool_name(str(arguments.get("skill_name") or ""))
    definition = definitions.get(skill_name)
    if definition is None:
        return ToolResult(name=ACTIVATE_TOOL_NAME, ok=False, content=f"Unknown skill: {skill_name}")

    already_active = skill_name in (set(context.active_skills) if context else set())
    tool_list = ", ".join(definition.tool_names()) or "No tools. This skill only adds context."
    state_text = "already active" if already_active else "activated"
    return ToolResult(
        name=ACTIVATE_TOOL_NAME,
        content=(
            f"Skill '{definition.display_name}' ({definition.name}) {state_text}. "
            f"Its instructions are now part of the session context. Available tools: {tool_list}"
        ),
        data={
            "skill_action": "activate",
            "skill_name": definition.name,
            "display_name": definition.display_name,
            "already_active": already_active,
            "tool_names": definition.tool_names(),
        },
    )


def _deactivate_skill(
    definitions: dict[str, SkillDefinition],
    arguments: dict[str, Any],
    context: ToolContext | None,
) -> ToolResult:
    skill_name = ensure_tool_name(str(arguments.get("skill_name") or ""))
    definition = definitions.get(skill_name)
    if definition is None:
        return ToolResult(name=DEACTIVATE_TOOL_NAME, ok=False, content=f"Unknown skill: {skill_name}")

    was_active = skill_name in (set(context.active_skills) if context else set())
    return ToolResult(
        name=DEACTIVATE_TOOL_NAME,
        content=(
            f"Skill '{definition.display_name}' ({definition.name}) "
            f"{'deactivated' if was_active else 'was not active'}."
        ),
        data={
            "skill_action": "deactivate",
            "skill_name": definition.name,
            "display_name": definition.display_name,
            "was_active": was_active,
        },
    )


def _load_skill_document(path: Path, *, default_name: str) -> SkillDocument:
    if not path.exists():
        msg = f"Skill file not found: {path}"
        raise FileNotFoundError(msg)

    metadata, instructions = _split_frontmatter(path.read_text(encoding="utf-8"))
    raw_name = str(metadata.get("name") or default_name).strip() or default_name
    description = str(metadata.get("description") or _derive_description(instructions) or raw_name).strip()
    enabled = bool(metadata.get("enabled", True))
    return SkillDocument(
        raw_name=raw_name,
        description=description,
        enabled=enabled,
        instructions=instructions.strip(),
    )


def _split_frontmatter(content: str) -> tuple[dict[str, Any], str]:
    lines = content.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, content.strip()

    for index in range(1, len(lines)):
        if lines[index].strip() != "---":
            continue
        metadata_text = "\n".join(lines[1:index]).strip()
        metadata = yaml.safe_load(metadata_text) if metadata_text else {}
        if metadata is None:
            metadata = {}
        if not isinstance(metadata, dict):
            msg = "Skill frontmatter must be a YAML mapping."
            raise ValueError(msg)
        body = "\n".join(lines[index + 1 :]).strip()
        return metadata, body

    return {}, content.strip()


def _serialize_skill_document(
    *,
    name: str,
    description: str,
    instructions: str,
    enabled: bool,
) -> str:
    metadata: dict[str, Any] = {"name": name, "description": description}
    if not enabled:
        metadata["enabled"] = False
    metadata_text = yaml.safe_dump(metadata, sort_keys=False, allow_unicode=True).strip()
    body = instructions.strip()
    if body:
        return f"---\n{metadata_text}\n---\n\n{body}\n"
    return f"---\n{metadata_text}\n---\n"


def _derive_description(instructions: str) -> str:
    for line in instructions.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        return stripped
    return ""


def _discover_skill_tools(
    skill_dir: Path,
    skill_name: str,
    display_name: str,
) -> list[SkillToolDefinition]:
    module_path = skill_dir / TOOLS_MODULE_NAME
    if not module_path.exists():
        return []

    module = _load_module(module_path, f"anomalo_skill_{skill_name}")
    tools: list[SkillToolDefinition] = []
    for function_name, func in sorted(inspect.getmembers(module, inspect.isfunction)):
        if function_name.startswith("_") or func.__module__ != module.__name__:
            continue
        try:
            parameters = _function_parameters_schema(func)
        except ValueError:
            continue
        tools.append(
            SkillToolDefinition(
                name=function_name,
                public_name=ensure_tool_name(f"skill_{skill_name}_{function_name}"),
                function_name=function_name,
                description=_function_description(func, display_name),
                parameters=parameters,
            )
        )
    return tools


def _function_description(func: Any, display_name: str) -> str:
    docstring = inspect.getdoc(func) or ""
    for line in docstring.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped
    return f"{func.__name__.replace('_', ' ')} tool for the {display_name} skill."


def _function_parameters_schema(func: Any) -> dict[str, Any]:
    signature = inspect.signature(func)
    properties: dict[str, Any] = {}
    required: list[str] = []
    additional_properties = False

    for parameter in signature.parameters.values():
        if parameter.kind in {inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.VAR_POSITIONAL}:
            msg = f"Unsupported tool parameter style in {func.__name__}: {parameter.name}"
            raise ValueError(msg)
        if parameter.kind == inspect.Parameter.VAR_KEYWORD:
            additional_properties = True
            continue

        annotation = parameter.annotation if parameter.annotation is not inspect.Signature.empty else Any
        schema = _annotation_schema(annotation)
        schema.pop("title", None)
        if parameter.default is not inspect.Signature.empty:
            schema.setdefault("default", parameter.default)
        else:
            required.append(parameter.name)
        properties[parameter.name] = schema

    return {
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": additional_properties,
    }


def _annotation_schema(annotation: Any) -> dict[str, Any]:
    if annotation is Any:
        return {}
    try:
        schema = TypeAdapter(annotation).json_schema()
    except Exception:  # noqa: BLE001
        return {}
    if not isinstance(schema, dict):
        return {}
    return schema


def _load_module(path: Path, module_name: str) -> ModuleType:
    if not path.exists():
        msg = f"Module file not found: {path}"
        raise FileNotFoundError(msg)
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        msg = f"Could not load module from {path}"
        raise ImportError(msg)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

