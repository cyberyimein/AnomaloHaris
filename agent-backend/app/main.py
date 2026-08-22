import logging
from contextlib import asynccontextmanager

from buddy_backend import BuddyConfigurationError, BuddyConnectionError, copilot_api
from buddy_backend import api as buddy_api
from buddy_backend import vision_api as buddy_vision_api
from buddy_backend.bridge import configure_buddy_runtime
from fastapi import FastAPI, Response
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from app.api import (
    artifacts,
    audio,
    chat,
    manage,
    mcp_sessions,
    memory,
    openrouter,
    preset_agents,
    prompts,
    sessions,
    skills,
    tools,
    websocket,
)
from app.api.security import require_management_access
from app.config import get_settings
from app.container import (
    get_buddy_audio_bridge,
    get_buddy_gateway,
    get_buddy_vision_service,
    get_codex_buddy_projection,
    get_preset_agent_store,
)

logger = logging.getLogger(__name__)


def _configure_logging() -> None:
    root_logger = logging.getLogger()
    if not root_logger.handlers:
        logging.basicConfig(level=logging.INFO)
    logging.getLogger("app").setLevel(logging.INFO)


@asynccontextmanager
async def _lifespan(app: FastAPI):  # type: ignore[no-untyped-def]
    del app
    settings = get_settings()
    get_preset_agent_store()
    gateway = get_buddy_gateway()
    audio_bridge = None
    if settings.buddy_transport.strip().lower() == "tcp":
        gateway.connect()
    if settings.buddy_audio_ai_enabled:
        audio_bridge = get_buddy_audio_bridge()
        audio_bridge.start()
    else:
        logger.info("Buddy audio AI bridge disabled; skipping STT/LLM/TTS startup.")
    try:
        yield
    finally:
        if audio_bridge is not None:
            audio_bridge.stop()
        try:
            gateway.disconnect()
        except (BuddyConfigurationError, BuddyConnectionError):
            pass


def _local_fonts_css(settings) -> str:  # type: ignore[no-untyped-def]
    if settings.local_font_dir is None:
        return ""

    local_font_dir = settings.local_font_dir.expanduser()
    if not local_font_dir.exists():
        return ""

    faces = [
        ("Bradford LL", "BradfordLLWeb-Regular.woff2", 450, "normal"),
        ("Bradford LL", "BradfordLLWeb-Italic.woff2", 450, "italic"),
        ("Bradford LL", "BradfordLLWeb-Bold.woff2", 600, "normal"),
        ("Bradford LL", "BradfordLLWeb-BoldItalic.woff2", 600, "italic"),
        ("Red Hat Mono", "RedHatMono-Regular.woff2", 400, "normal"),
        ("Red Hat Mono", "RedHatMono-Medium.woff2", 500, "normal"),
    ]
    declarations = []
    for family, filename, weight, style in faces:
        if not (local_font_dir / filename).exists():
            continue
        declarations.append(
            "\n".join(
                [
                    "@font-face {",
                    f'  font-family: "{family}";',
                    f'  src: url("/fonts/local/{filename}") format("woff2");',
                    "  font-display: swap;",
                    f"  font-style: {style};",
                    f"  font-weight: {weight};",
                    "}",
                ]
            )
        )
    return "\n\n".join(declarations)


def create_app() -> FastAPI:
    _configure_logging()
    settings = get_settings()
    app = FastAPI(title=settings.app_title, lifespan=_lifespan)
    configure_buddy_runtime(
        gateway=get_buddy_gateway,
        settings=get_settings,
        vision=get_buddy_vision_service,
        projection=get_codex_buddy_projection,
        access_checker=require_management_access,
    )

    settings.static_dir.mkdir(parents=True, exist_ok=True)
    settings.frontend_dir.mkdir(parents=True, exist_ok=True)
    settings.frontend_assets_dir.mkdir(parents=True, exist_ok=True)
    for skills_dir in settings.skill_dirs:
        skills_dir.mkdir(parents=True, exist_ok=True)
    settings.config_dir.mkdir(parents=True, exist_ok=True)
    settings.artifacts_dir.mkdir(parents=True, exist_ok=True)

    app.mount("/static", StaticFiles(directory=settings.static_dir), name="static")
    app.mount(
        "/assets",
        StaticFiles(directory=settings.frontend_assets_dir),
        name="frontend-assets",
    )
    if settings.local_font_dir is not None:
        local_font_dir = settings.local_font_dir.expanduser()
        if local_font_dir.exists():
            app.mount("/fonts/local", StaticFiles(directory=local_font_dir), name="local-fonts")

    app.include_router(chat.router)
    app.include_router(artifacts.router)
    app.include_router(websocket.router)
    app.include_router(sessions.router)
    app.include_router(skills.router)
    app.include_router(mcp_sessions.router)
    app.include_router(memory.router)
    app.include_router(openrouter.router)
    app.include_router(preset_agents.management_router)
    app.include_router(preset_agents.invocation_router)
    app.include_router(prompts.router)
    app.include_router(tools.router)
    app.include_router(manage.router)
    app.include_router(audio.router)
    app.include_router(buddy_api.router)
    app.include_router(buddy_vision_api.router)
    app.include_router(copilot_api.router)

    @app.get("/", response_class=HTMLResponse)
    async def index() -> str:
        index_path = settings.frontend_dir / "index.html"
        return index_path.read_text(encoding="utf-8")

    @app.get("/fonts/local.css")
    async def local_fonts_css() -> Response:
        return Response(content=_local_fonts_css(settings), media_type="text/css")

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
