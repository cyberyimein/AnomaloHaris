import unittest

from schema_validator import validate, validate_schema


class SchemaValidatorTests(unittest.TestCase):
    def test_validates_required_any_of_and_additional_properties(self):
        schema = {
            "type": "object",
            "properties": {
                "pan": {"type": "number", "minimum": -90, "maximum": 90},
                "tilt": {"type": "number", "minimum": 5, "maximum": 85},
            },
            "additionalProperties": False,
            "anyOf": [{"required": ["pan"]}, {"required": ["tilt"]}],
        }

        validate({"pan": 12.5}, schema)
        validate({"tilt": 45}, schema)
        with self.assertRaisesRegex(ValueError, "at least one"):
            validate({}, schema)
        with self.assertRaisesRegex(ValueError, "additional property"):
            validate({"pan": 0, "unexpected": True}, schema)
        with self.assertRaisesRegex(ValueError, "maximum"):
            validate({"pan": 91}, schema)

    def test_validates_enums_strings_arrays_and_finite_numbers(self):
        schema = {
            "type": "object",
            "properties": {
                "color": {"type": "string", "enum": ["gold", "teal"], "maxLength": 8},
                "levels": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 3,
                    "items": {"type": "integer", "minimum": 0, "maximum": 5},
                },
                "intensity": {"type": "number", "minimum": 0, "maximum": 1},
            },
            "required": ["color", "levels", "intensity"],
            "additionalProperties": False,
        }

        validate({"color": "gold", "levels": [0, 5], "intensity": 0.5}, schema)
        for value in (
            {"color": "blue", "levels": [0], "intensity": 0.5},
            {"color": "tealtoolong", "levels": [0], "intensity": 0.5},
            {"color": "teal", "levels": [0, 6], "intensity": 0.5},
            {"color": "teal", "levels": [], "intensity": 0.5},
            {"color": "teal", "levels": [0], "intensity": float("nan")},
            {"color": "teal", "levels": [0], "intensity": True},
        ):
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate(value, schema)

    def test_explicitly_rejects_schema_keywords_outside_supported_subset(self):
        with self.assertRaisesRegex(ValueError, "unsupported.*pattern"):
            validate_schema({"type": "string", "pattern": "^safe$"})
        with self.assertRaisesRegex(ValueError, "unsupported.*oneOf"):
            validate_schema({"oneOf": [{"type": "string"}]})

    def test_rejects_malformed_schema_definitions(self):
        for schema in (
            {"type": "unsupported"},
            {"type": "object", "required": "pan"},
            {"type": "object", "additionalProperties": {"type": "string"}},
            {"type": "number", "minimum": float("nan")},
        ):
            with self.subTest(schema=schema), self.assertRaises(ValueError):
                validate_schema(schema)


if __name__ == "__main__":
    unittest.main()
