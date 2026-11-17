import type { ConfigField, ConfigValues } from "./contract.js";

export interface ConfigIssue { field: string; message: string }
export class ConfigError extends Error {
  constructor(readonly issues: ConfigIssue[]) { super(issues.map((issue) => `${issue.field}: ${issue.message}`).join("; ")); }
}

function coerce(field: ConfigField, value: unknown): unknown {
  switch (field.type) {
    case "boolean":
      if (typeof value === "boolean") return value;
      if (value === "true" || value === 1 || value === "1") return true;
      if (value === "false" || value === 0 || value === "0") return false;
      return undefined;
    case "number":
    case "integer": {
      const parsed = typeof value === "number" ? value : Number(String(value).trim());
      if (!Number.isFinite(parsed)) return undefined;
      if (field.type === "integer" && !Number.isInteger(parsed)) return undefined;
      return parsed;
    }
    default:
      return typeof value === "string" ? value : value === undefined || value === null ? undefined : String(value);
  }
}

/** Validate one field value; returns the normalised value or a message. */
function validateField(field: ConfigField, key: string, value: unknown): { value?: unknown; issue?: ConfigIssue } {
  if (value === undefined || value === null || value === "") {
    if ("default" in field && field.default !== undefined) return { value: field.default };
    return { value: undefined };
  }
  switch (field.type) {
    case "string": {
      const text = String(value);
      if (field.minLength !== undefined && text.length < field.minLength) return { issue: { field: key, message: `at least ${field.minLength} characters` } };
      if (field.maxLength !== undefined && text.length > field.maxLength) return { issue: { field: key, message: `at most ${field.maxLength} characters` } };
      if (field.pattern && !new RegExp(field.pattern).test(text)) return { issue: { field: key, message: `does not match ${field.pattern}` } };
      return { value: text };
    }
    case "number":
    case "integer": {
      const number = coerce(field, value);
      if (typeof number !== "number") return { issue: { field: key, message: field.type === "integer" ? "must be an integer" : "must be a number" } };
      if (field.minimum !== undefined && number < field.minimum) return { issue: { field: key, message: `must be at least ${field.minimum}` } };
      if (field.maximum !== undefined && number > field.maximum) return { issue: { field: key, message: `must be at most ${field.maximum}` } };
      return { value: number };
    }
    case "boolean": {
      const flag = coerce(field, value);
      return typeof flag === "boolean" ? { value: flag } : { issue: { field: key, message: "must be true or false" } };
    }
    case "enum": {
      const text = String(value);
      if (!field.values.some((choice) => choice.value === text)) return { issue: { field: key, message: "is not one of the allowed values" } };
      return { value: text };
    }
    case "array": {
      if (!Array.isArray(value)) return { issue: { field: key, message: "must be a list" } };
      if (field.minItems !== undefined && value.length < field.minItems) return { issue: { field: key, message: `at least ${field.minItems} entries` } };
      if (field.maxItems !== undefined && value.length > field.maxItems) return { issue: { field: key, message: `at most ${field.maxItems} entries` } };
      const items: unknown[] = [];
      for (const [index, entry] of value.entries()) {
        const result = validateField(field.items, `${key}[${index}]`, entry);
        if (result.issue) return result;
        items.push(result.value);
      }
      return { value: items };
    }
  }
}

/** Defaults declared by the schema; missing parts of a stored config fall back to these. */
/** Validate one value against a field definition; returns the stored value. */
export function normalize(field: ConfigField, key: string, value: unknown) {
  const result = validateField(field, key, value);
  return { value: result.value as string | number | boolean | undefined, issue: result.issue };
}

/** Merge buyer/administrator values over the field defaults, dropping invalid entries. */
export function resolveValues(fields: Record<string, ConfigField>, stored: ConfigValues | undefined): ConfigValues {
  const output: ConfigValues = {};
  for (const [key, field] of Object.entries(fields)) {
    if ("default" in field && field.default !== undefined) output[key] = field.default as string | number | boolean;
  }
  for (const [key, value] of Object.entries(stored ?? {})) {
    const field = fields[key];
    if (!field) continue;
    const result = validateField(field, key, value);
    if (!result.issue && result.value !== undefined) output[key] = result.value as string | number | boolean;
  }
  return output;
}
