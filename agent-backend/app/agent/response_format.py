import json
from typing import Any, Literal

from jsonschema import Draft202012Validator, SchemaError
from pydantic import BaseModel, ConfigDict, Field, model_validator


class JsonSchemaDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    name: str = Field(
        min_length=1,
        max_length=64,
        pattern=r"^[A-Za-z0-9_-]+$",
    )
    description: str | None = Field(default=None, max_length=2000)
    schema_: dict[str, Any] = Field(alias="schema")
    strict: bool = True

    @model_validator(mode="after")
    def validate_schema(self) -> "JsonSchemaDefinition":
        try:
            _reject_remote_references(self.schema_)
            Draft202012Validator.check_schema(self.schema_)
        except SchemaError as exc:
            raise ValueError(f"Invalid JSON Schema: {exc.message}") from exc
        return self


class ResponseFormat(BaseModel):
    """The output contract requested by an API caller."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["text", "json_object", "json_schema"] = "text"
    json_schema: JsonSchemaDefinition | None = None

    @model_validator(mode="after")
    def validate_definition(self) -> "ResponseFormat":
        if self.type == "json_schema" and self.json_schema is None:
            raise ValueError("json_schema is required when response_format.type is json_schema")
        if self.type != "json_schema" and self.json_schema is not None:
            raise ValueError("json_schema is only valid when response_format.type is json_schema")
        return self


ResponseFormatInput = ResponseFormat | dict[str, Any] | None


class StructuredOutputValidationError(ValueError):
    """Raised when a finalizer response does not satisfy the requested contract."""


def _reject_remote_references(value: Any, *, path: str = "$") -> None:
    if isinstance(value, dict):
        for keyword in ("$ref", "$dynamicRef", "$recursiveRef"):
            reference = value.get(keyword)
            if reference is not None and (
                not isinstance(reference, str) or not reference.startswith("#")
            ):
                raise ValueError(
                    f"Only local JSON Schema references are allowed at {path}.{keyword}"
                )
        for key, child in value.items():
            _reject_remote_references(child, path=f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _reject_remote_references(child, path=f"{path}[{index}]")


def normalize_response_format(value: ResponseFormatInput) -> dict[str, Any] | None:
    if value is None:
        return None
    if isinstance(value, ResponseFormat):
        parsed = value
    else:
        parsed = ResponseFormat.model_validate(value)
    return parsed.model_dump(mode="json", by_alias=True, exclude_none=True)


def response_format_type(value: dict[str, Any] | None) -> str:
    return str((value or {}).get("type") or "text")


def validate_final_output(content: str, response_format: dict[str, Any]) -> Any:
    """Parse and validate a finalizer response against the API contract."""
    output_type = response_format_type(response_format)
    if output_type == "text":
        return content

    try:
        parsed = json.loads(content)
    except json.JSONDecodeError as exc:
        raise StructuredOutputValidationError(
            f"Finalizer returned invalid JSON: {exc.msg}"
        ) from exc

    if output_type == "json_object":
        if not isinstance(parsed, dict):
            raise StructuredOutputValidationError("Finalizer JSON output must be an object")
        return parsed

    if output_type != "json_schema":
        raise StructuredOutputValidationError(f"Unsupported response format type: {output_type}")

    definition = response_format.get("json_schema") or {}
    schema = definition.get("schema")
    if not isinstance(schema, dict):
        raise StructuredOutputValidationError(
            "response_format.json_schema.schema must be an object"
        )

    try:
        _reject_remote_references(schema)
    except ValueError as exc:
        raise StructuredOutputValidationError(str(exc)) from exc
    validator = Draft202012Validator(schema)
    errors = sorted(validator.iter_errors(parsed), key=lambda error: list(error.absolute_path))
    if errors:
        details = "; ".join(error.message for error in errors[:3])
        if len(errors) > 3:
            details += f"; and {len(errors) - 3} more error(s)"
        raise StructuredOutputValidationError(
            f"Finalizer output does not match JSON Schema: {details}"
        )
    return parsed


def finalizer_instruction(
    response_format: dict[str, Any],
    validation_error: str | None = None,
) -> str:
    output_type = response_format_type(response_format)
    if output_type == "json_schema":
        instruction = (
            "The tool-calling phase is complete. Produce the final answer now. "
            "Use the supplied research draft as the source of truth; do not redo the research "
            "or invent facts that are absent from the draft. "
            "Return only one JSON value that conforms to the requested JSON Schema. "
            "Do not use Markdown fences and do not add explanatory text."
        )
    else:
        instruction = (
            "The tool-calling phase is complete. Produce the final answer now as one valid JSON "
            "object. Use the supplied research draft as the source of truth; do not redo the "
            "research or invent facts that are absent from the draft. Do not use Markdown fences "
            "and do not add explanatory text."
        )

    if validation_error:
        return (
            f"{instruction} Your previous output failed Anomalo validation: "
            f"{validation_error[:1000]} Generate a corrected output."
        )
    return instruction
