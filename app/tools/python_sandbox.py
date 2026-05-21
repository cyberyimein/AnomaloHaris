import asyncio
from typing import Any

from app.config import Settings
from app.tools.base import ToolContext, ToolProvider, ToolResult, ToolSpec


class PythonSandboxProvider(ToolProvider):
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    async def list_tools(self, context: ToolContext | None = None) -> list[ToolSpec]:
        return [
            ToolSpec(
                name="sandbox_python_run",
                source="sandbox",
                description=(
                    "Run short Python code in a locked-down Docker container for math, "
                    "calculation, data checks, or plotting. The container has no network."
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "code": {
                            "type": "string",
                            "description": "Python code to execute. Print final answers to stdout.",
                        }
                    },
                    "required": ["code"],
                    "additionalProperties": False,
                },
            )
        ]

    async def call_tool(
        self,
        name: str,
        arguments: dict[str, Any],
        context: ToolContext | None = None,
    ) -> ToolResult:
        if name != "sandbox_python_run":
            return ToolResult(name=name, ok=False, content=f"Unknown sandbox tool: {name}")

        code = str(arguments.get("code", ""))
        if not code.strip():
            return ToolResult(name=name, ok=False, content="No Python code provided.")

        cmd = [
            "docker",
            "run",
            "--rm",
            "--network",
            "none",
            "--cpus",
            "1",
            "--memory",
            "256m",
            "--pids-limit",
            "64",
            "--read-only",
            "--tmpfs",
            "/tmp:rw,nosuid,nodev,size=64m",
            "-e",
            "PYTHONDONTWRITEBYTECODE=1",
            "-e",
            "MPLBACKEND=Agg",
            self.settings.python_sandbox_image,
            "python",
            "-c",
            code,
        ]

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(),
                timeout=self.settings.python_sandbox_timeout_seconds,
            )
        except TimeoutError:
            proc.kill()
            await proc.wait()
            return ToolResult(name=name, ok=False, content="Python sandbox timed out.")
        except FileNotFoundError:
            return ToolResult(name=name, ok=False, content="Docker executable was not found.")

        stdout_text = stdout.decode("utf-8", errors="replace")
        stderr_text = stderr.decode("utf-8", errors="replace")
        max_chars = self.settings.python_sandbox_max_output_chars
        combined = _limit_output(stdout_text, stderr_text, max_chars)
        ok = proc.returncode == 0
        return ToolResult(
            name=name,
            ok=ok,
            content=combined,
            data={
                "exit_code": proc.returncode,
                "stdout": stdout_text[:max_chars],
                "stderr": stderr_text[:max_chars],
                "image": self.settings.python_sandbox_image,
            },
        )


def _limit_output(stdout: str, stderr: str, max_chars: int) -> str:
    parts = []
    if stdout:
        parts.append(f"stdout:\n{stdout}")
    if stderr:
        parts.append(f"stderr:\n{stderr}")
    text = "\n\n".join(parts) or "No output."
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + "\n... output truncated ..."

