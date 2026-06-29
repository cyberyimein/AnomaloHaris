from typing import Any

from app.tools.base import ToolContext, ToolProvider, ToolResult, ToolSpec


class ToolRegistry:
    def __init__(self, providers: list[ToolProvider]) -> None:
        self.providers = providers

    async def list_tools(self, context: ToolContext | None = None) -> list[ToolSpec]:
        tools: list[ToolSpec] = []
        names: set[str] = set()
        for provider in self.providers:
            for tool in await provider.list_tools(context=context):
                if tool.name in names:
                    continue
                names.add(tool.name)
                tools.append(tool)
        return tools

    async def openai_tools(self, context: ToolContext | None = None) -> list[dict[str, Any]]:
        return [tool.as_openai_tool() for tool in await self.list_tools(context=context)]

    async def call_tool(
        self,
        name: str,
        arguments: dict[str, Any],
        context: ToolContext | None = None,
    ) -> ToolResult:
        for provider in self.providers:
            tools = await provider.list_tools(context=context)
            if any(tool.name == name for tool in tools):
                return await provider.call_tool(name, arguments, context=context)
        return ToolResult(name=name, ok=False, content=f"Tool not found: {name}")

    async def status(self, context: ToolContext | None = None) -> list[dict[str, Any]]:
        statuses: list[dict[str, Any]] = []
        for provider in self.providers:
            provider_status = await provider.status(context=context)
            provider_status["provider"] = provider.__class__.__name__
            statuses.append(provider_status)
        return statuses

