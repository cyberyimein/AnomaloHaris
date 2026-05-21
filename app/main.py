from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from app.api import audio, chat, manage, mcp_sessions, memory, prompts, skills, tools, websocket
from app.config import get_settings


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title=settings.app_title)

    settings.static_dir.mkdir(parents=True, exist_ok=True)
    settings.frontend_dir.mkdir(parents=True, exist_ok=True)
    settings.skills_dir.mkdir(parents=True, exist_ok=True)
    settings.config_dir.mkdir(parents=True, exist_ok=True)
    settings.artifacts_dir.mkdir(parents=True, exist_ok=True)

    app.mount("/static", StaticFiles(directory=settings.static_dir), name="static")

    app.include_router(chat.router)
    app.include_router(websocket.router)
    app.include_router(skills.router)
    app.include_router(mcp_sessions.router)
    app.include_router(memory.router)
    app.include_router(prompts.router)
    app.include_router(tools.router)
    app.include_router(manage.router)
    app.include_router(audio.router)

    @app.get("/", response_class=HTMLResponse)
    async def index() -> str:
        index_path = settings.frontend_dir / "index.html"
        return index_path.read_text(encoding="utf-8")

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
