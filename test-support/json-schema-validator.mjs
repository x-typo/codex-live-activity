import { isDeepStrictEqual } from "node:util";

const SUPPORTED_KEYWORDS = new Set([
  "$defs",
  "$id",
  "$ref",
  "$schema",
  "additionalProperties",
  "const",
  "enum",
  "format",
  "maxLength",
  "minLength",
  "minimum",
  "oneOf",
  "properties",
  "required",
  "title",
  "type",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function assertSupportedNode(schema, path) {
  if (!isObject(schema)) {
    throw new TypeError(`${path} must be a schema object`);
  }

  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      throw new TypeError(`${path} uses unsupported schema keyword ${keyword}`);
    }
  }

  for (const [name, propertySchema] of Object.entries(schema.properties ?? {})) {
    assertSupportedNode(propertySchema, `${path}.properties.${name}`);
  }
  for (const [name, definition] of Object.entries(schema.$defs ?? {})) {
    assertSupportedNode(definition, `${path}.$defs.${name}`);
  }
  for (const [index, branch] of (schema.oneOf ?? []).entries()) {
    assertSupportedNode(branch, `${path}.oneOf[${index}]`);
  }
}

function resolveReference(rootSchema, reference) {
  if (typeof reference !== "string" || !reference.startsWith("#/")) {
    throw new TypeError(`Only local JSON Pointer references are supported: ${reference}`);
  }

  let current = rootSchema;
  for (const encodedPart of reference.slice(2).split("/")) {
    const part = encodedPart.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isObject(current) || !own(current, part)) {
      throw new TypeError(`Unresolved schema reference: ${reference}`);
    }
    current = current[part];
  }
  return current;
}

function matchesType(value, type) {
  switch (type) {
    case "null":
      return value === null;
    case "object":
      return isObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    default:
      throw new TypeError(`Unsupported JSON Schema type: ${type}`);
  }
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isRfc3339DateTime(value) {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/,
  );
  if (!match) return false;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const daysInMonth = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];

  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth[month - 1] &&
    Number(hourText) <= 23 &&
    Number(minuteText) <= 59 &&
    Number(secondText) <= 59 &&
    (match[7] === undefined || Number(match[7]) <= 23) &&
    (match[8] === undefined || Number(match[8]) <= 59) &&
    Number.isFinite(Date.parse(value))
  );
}

function validateNode(value, schema, rootSchema, path) {
  const errors = [];

  if (schema.$ref !== undefined) {
    errors.push(
      ...validateNode(
        value,
        resolveReference(rootSchema, schema.$ref),
        rootSchema,
        path,
      ),
    );
  }

  if (schema.const !== undefined && !isDeepStrictEqual(value, schema.const)) {
    errors.push(`${path} does not equal the required constant`);
  }
  if (
    schema.enum !== undefined &&
    !schema.enum.some((candidate) => isDeepStrictEqual(value, candidate))
  ) {
    errors.push(`${path} is not in the allowed enum`);
  }

  if (schema.oneOf !== undefined) {
    const matchingBranches = schema.oneOf.filter(
      (branch) => validateNode(value, branch, rootSchema, path).length === 0,
    ).length;
    if (matchingBranches !== 1) {
      errors.push(`${path} must match exactly one oneOf branch`);
    }
  }

  if (schema.type !== undefined) {
    const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowedTypes.some((type) => matchesType(value, type))) {
      errors.push(`${path} does not match type ${allowedTypes.join("|")}`);
      return errors;
    }
  }

  if (typeof value === "string") {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) {
      errors.push(`${path} is shorter than minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && length > schema.maxLength) {
      errors.push(`${path} is longer than maxLength ${schema.maxLength}`);
    }
    if (schema.format === "date-time") {
      if (!isRfc3339DateTime(value)) {
        errors.push(`${path} is not an RFC 3339 date-time`);
      }
    } else if (schema.format !== undefined) {
      throw new TypeError(`Unsupported JSON Schema format: ${schema.format}`);
    }
  }

  if (
    typeof value === "number" &&
    schema.minimum !== undefined &&
    value < schema.minimum
  ) {
    errors.push(`${path} is less than minimum ${schema.minimum}`);
  }

  if (isObject(value)) {
    for (const requiredName of schema.required ?? []) {
      if (!own(value, requiredName)) {
        errors.push(`${path} is missing required property ${requiredName}`);
      }
    }

    const properties = schema.properties ?? {};
    for (const [name, propertySchema] of Object.entries(properties)) {
      if (own(value, name)) {
        errors.push(
          ...validateNode(value[name], propertySchema, rootSchema, `${path}.${name}`),
        );
      }
    }

    if (schema.additionalProperties === false) {
      for (const name of Object.keys(value)) {
        if (!own(properties, name)) {
          errors.push(`${path} contains additional property ${name}`);
        }
      }
    }
  }

  return errors;
}

export function validateJsonSchema(value, schema) {
  assertSupportedNode(schema, "$schema");
  return validateNode(value, schema, schema, "$value");
}
