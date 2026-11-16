import type { InstanceConfigField, InstanceConfigSchema, InstanceConfigValues } from "./contract.js";

export interface ConfigIssue { field: string; message: string }
export class ConfigError extends Error {
  constructor(readonly issues: ConfigIssue[]) { super(issues.map((issue) => `${issue.field}: ${issue.message}`).join("; ")); }
}

function coerce(field: InstanceConfigField, value: unknown): unknown {
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
function validateField(field: InstanceConfigField, key: string, value: unknown): { value?: unknown; issue?: ConfigIssue } {
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
export function schemaDefaults(schema: InstanceConfigSchema): InstanceConfigValues {
  const values: InstanceConfigValues = {};
  for (const section of schema.sections) {
    for (const [key, field] of Object.entries(section.fields)) {
      if ("default" in field && field.default !== undefined) values[key] = field.default;
    }
  }
  return values;
}

/**
 * Merge a stored config over the schema defaults. Unknown keys are dropped and missing
 * ones filled, so a schema that gains fields keeps older instances working.
 */
export function mergeConfig(schema: InstanceConfigSchema, stored: InstanceConfigValues | undefined): InstanceConfigValues {
  const merged = schemaDefaults(schema);
  for (const [key, value] of Object.entries(stored ?? {})) {
    const field = fieldOf(schema, key);
    if (!field) continue;
    const result = validateField(field, key, value);
    if (!result.issue && result.value !== undefined) merged[key] = result.value as string | number | boolean;
  }
  return merged;
}

export function fieldOf(schema: InstanceConfigSchema, key: string): InstanceConfigField | undefined {
  for (const section of schema.sections) {
    if (section.fields[key]) return section.fields[key];
  }
  return undefined;
}

/** Validate a partial update and merge it over the current values. */
export function applyPatch(schema: InstanceConfigSchema, current: InstanceConfigValues, patch: InstanceConfigValues): InstanceConfigValues {
  const next = { ...current };
  const issues: ConfigIssue[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const field = fieldOf(schema, key);
    if (!field) continue;
    const result = validateField(field, key, value);
    if (result.issue) issues.push(result.issue);
    else if (result.value !== undefined) next[key] = result.value as string | number | boolean;
    else delete next[key];
  }
  if (issues.length) throw new ConfigError(issues);
  return next;
}

/** Values acceptable as an environment variable inside the generated start script. */
export function shellValue(value: string | number | boolean) {
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return value.replace(/[^\w.,:/@%+-]/g, "_").slice(0, 256);
}
