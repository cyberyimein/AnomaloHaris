"""Small explicit JSON-schema subset for device capabilities, without mutation."""

MAX_SCHEMA_DEPTH = 12
SUPPORTED_KEYS = (
    "type", "properties", "required", "additionalProperties", "anyOf", "enum",
    "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems",
    "items", "default", "description", "title", "format",
)
SUPPORTED_TYPES = ("object", "array", "string", "integer", "number", "boolean", "null")


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _finite(value):
    return not isinstance(value, float) or -float("inf") < value < float("inf")


def _json_value(value, depth=0):
    if depth > MAX_SCHEMA_DEPTH:
        raise ValueError("JSON nesting exceeds the supported depth")
    if value is None or isinstance(value, (str, bool)):
        return
    if _number(value):
        if not _finite(value):
            raise ValueError("Numbers must be finite")
        return
    if isinstance(value, list):
        for item in value:
            _json_value(item, depth + 1)
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValueError("Object keys must be strings")
            _json_value(item, depth + 1)
        return
    raise ValueError("Value is not JSON-compatible")


def validate_schema(schema, _depth=0):
    if _depth > MAX_SCHEMA_DEPTH or not isinstance(schema, dict):
        raise ValueError("Capability schema must be a bounded schema object")
    for key in schema:
        if key not in SUPPORTED_KEYS:
            raise ValueError("unsupported schema keyword: " + str(key))
    if "type" in schema and schema["type"] not in SUPPORTED_TYPES:
        raise ValueError("Unsupported schema type")
    for annotation in ("description", "title", "format"):
        if annotation in schema and not isinstance(schema[annotation], str):
            raise ValueError(annotation + " must be a string")
    properties = schema.get("properties", {})
    if not isinstance(properties, dict):
        raise ValueError("properties must be an object")
    for name, child in properties.items():
        if not isinstance(name, str):
            raise ValueError("property names must be strings")
        validate_schema(child, _depth + 1)
    required = schema.get("required", [])
    if not isinstance(required, list) or any(not isinstance(key, str) for key in required):
        raise ValueError("required must be an array of property names")
    if "additionalProperties" in schema and not isinstance(schema["additionalProperties"], bool):
        raise ValueError("additionalProperties supports only true or false")
    for lower, upper in (("minimum", "maximum"), ("minLength", "maxLength"), ("minItems", "maxItems")):
        for key in (lower, upper):
            if key not in schema:
                continue
            bound = schema[key]
            if not _number(bound) or not _finite(bound):
                raise ValueError(key + " must be finite")
            if key not in ("minimum", "maximum"):
                if not isinstance(bound, int) or bound < 0:
                    raise ValueError(key + " must be a non-negative integer")
        if lower in schema and upper in schema and schema[lower] > schema[upper]:
            raise ValueError(lower + " cannot exceed " + upper)
    if "enum" in schema:
        choices = schema["enum"]
        if not isinstance(choices, list) or not choices:
            raise ValueError("enum must be a non-empty array")
        _json_value(choices)
    if "items" in schema:
        validate_schema(schema["items"], _depth + 1)
    if "anyOf" in schema:
        alternatives = schema["anyOf"]
        if not isinstance(alternatives, list) or not alternatives:
            raise ValueError("anyOf must be a non-empty array")
        for child in alternatives:
            validate_schema(child, _depth + 1)
    if "default" in schema:
        _json_value(schema["default"])
        _validate(schema["default"], schema, "default")


def _equal(left, right):
    if isinstance(left, bool) or isinstance(right, bool):
        return isinstance(left, bool) and isinstance(right, bool) and left == right
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(_equal(a, b) for a, b in zip(left, right))
    if isinstance(left, dict) and isinstance(right, dict):
        return set(left) == set(right) and all(_equal(left[key], right[key]) for key in left)
    if type(left) is not type(right) and not (_number(left) and _number(right)):
        return False
    return left == right


def _validate(value, schema, path):
    kind = schema.get("type")
    matches = {
        "object": isinstance(value, dict),
        "array": isinstance(value, list),
        "string": isinstance(value, str),
        "integer": isinstance(value, int) and not isinstance(value, bool),
        "number": _number(value) and _finite(value),
        "boolean": isinstance(value, bool),
        "null": value is None,
    }
    if kind is not None and not matches[kind]:
        raise ValueError(path + " must be " + kind)
    if "enum" in schema and not any(_equal(value, item) for item in schema["enum"]):
        raise ValueError(path + " must match an enum value")
    if _number(value):
        if "minimum" in schema and value < schema["minimum"]:
            raise ValueError(path + " is below minimum")
        if "maximum" in schema and value > schema["maximum"]:
            raise ValueError(path + " exceeds maximum")
    if isinstance(value, str):
        if len(value) < schema.get("minLength", 0):
            raise ValueError(path + " is below minLength")
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            raise ValueError(path + " exceeds maxLength")
    if isinstance(value, dict):
        properties = schema.get("properties", {})
        for name in schema.get("required", []):
            if name not in value:
                raise ValueError(path + " missing required property " + name)
        for name, item in value.items():
            if name in properties:
                _validate(item, properties[name], path + "." + name)
            elif schema.get("additionalProperties", True) is False:
                raise ValueError(path + " has additional property " + name)
    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0):
            raise ValueError(path + " is below minItems")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            raise ValueError(path + " exceeds maxItems")
        if "items" in schema:
            for index, item in enumerate(value):
                _validate(item, schema["items"], path + "[{}]".format(index))
    if "anyOf" in schema:
        for child in schema["anyOf"]:
            try:
                _validate(value, child, path)
                break
            except ValueError:
                pass
        else:
            raise ValueError(path + " must match at least one anyOf alternative")


def validate_arguments(schema, value):
    """Validate a value against an already registered, checked schema."""
    _json_value(value)
    _validate(value, schema, "args")


def validate(value, schema):
    """Validate a standalone schema and value, useful for module authors."""
    validate_schema(schema)
    validate_arguments(schema, value)
