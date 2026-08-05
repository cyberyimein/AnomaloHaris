from typing import Literal

SearchMode = Literal["native", "subagent", "diy"]

SEARCH_MODE_NATIVE = "native"
SEARCH_MODE_SUBAGENT = "subagent"
SEARCH_MODE_DIY = "diy"
DEFAULT_SEARCH_MODE = SEARCH_MODE_DIY
DEFAULT_SUBAGENT_MODEL = "deepseek/deepseek-v4-flash-0731"
VALID_SEARCH_MODES = frozenset(
    {SEARCH_MODE_NATIVE, SEARCH_MODE_SUBAGENT, SEARCH_MODE_DIY}
)


def normalize_search_mode(value: str | None) -> SearchMode:
    normalized = str(value or DEFAULT_SEARCH_MODE).strip().lower()
    if normalized not in VALID_SEARCH_MODES:
        choices = ", ".join(sorted(VALID_SEARCH_MODES))
        raise ValueError(f"Unsupported search mode: {normalized!r}. Choose one of: {choices}.")
    return normalized  # type: ignore[return-value]


def search_mode_options(subagent_model: str) -> list[dict[str, str]]:
    return [
        {
            "id": SEARCH_MODE_NATIVE,
            "label": "Model-native search",
            "description": (
                "Uses the active model through the Responses API web_search_preview tool. "
                "If the model/provider rejects it, Anomalo reports the failure."
            ),
            "provider": "responses_api",
        },
        {
            "id": SEARCH_MODE_SUBAGENT,
            "label": "Web research subagent",
            "description": (
                f"Delegates web research to {subagent_model} through its own standard "
                "Responses API web_search_preview tool."
            ),
            "provider": "responses_api_subagent",
        },
        {
            "id": SEARCH_MODE_DIY,
            "label": "DIY web tools",
            "description": "Uses Anomalo's existing DuckDuckGo search and page-fetch tools.",
            "provider": "duckduckgo_html",
        },
    ]


def search_mode_instruction(
    mode: SearchMode,
    *,
    model: str,
    subagent_model: str,
) -> str:
    if mode == SEARCH_MODE_NATIVE:
        return (
            "Search mode is model-native. For current or externally verifiable information, "
            f"call web_search. Anomalo will invoke the Responses API standard web_search_preview "
            f"tool with the active model ({model}). If the tool reports that this model or "
            "provider does not support native search, tell the user clearly and suggest switching "
            "to Web research subagent or DIY web tools."
        )
    if mode == SEARCH_MODE_SUBAGENT:
        return (
            "Search mode is Web research subagent. For current or externally verifiable "
            f"information, call web_search and delegate the request to the dedicated retrieval "
            f"subagent ({subagent_model}). Treat its returned sources as research evidence and "
            "preserve useful URLs in the answer."
        )
    return (
        "Search mode is DIY web tools. For current or externally verifiable information, use "
        "web_search to discover sources and web_fetch to read promising pages. Treat search "
        "snippets as leads rather than complete evidence and preserve source URLs."
    )
