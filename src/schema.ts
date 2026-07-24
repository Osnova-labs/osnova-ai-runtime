export interface SchemaValidationResult {
  valid: boolean;
  issues: string[];
}

export function validateJsonSchema(schema: Record<string, unknown>, value: unknown): SchemaValidationResult {
  const issues: string[] = [];
  validateNode(schema, value, "$", issues, schema, 0);
  return { valid: issues.length === 0, issues };
}

function validateNode(schema: Record<string, unknown>, value: unknown, pointer: string, issues: string[], root: Record<string, unknown>, depth: number): void {
  if (depth > 100) { issues.push(`${pointer} exceeds maximum schema depth.`); return; }
  if (typeof schema.$ref === "string") {
    const resolved = resolveLocalRef(root, schema.$ref);
    if (!resolved) issues.push(`${pointer} uses an unsupported or missing $ref: ${schema.$ref}.`);
    else validateNode(resolved, value, pointer, issues, root, depth + 1);
  }
  if (schema.const !== undefined && !deepEqual(schema.const, value)) issues.push(`${pointer} must equal the declared constant.`);
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => deepEqual(candidate, value))) {
    issues.push(`${pointer} is not one of the allowed values.`);
  }

  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const variants = schema[keyword];
    if (!Array.isArray(variants)) continue;
    const matches = variants.filter((candidate) => {
      if (!isRecord(candidate)) return false;
      const nested: string[] = [];
      validateNode(candidate, value, pointer, nested, root, depth + 1);
      return nested.length === 0;
    }).length;
    if ((keyword === "allOf" && matches !== variants.length) || (keyword === "anyOf" && matches === 0) || (keyword === "oneOf" && matches !== 1)) {
      issues.push(`${pointer} does not satisfy ${keyword}.`);
    }
  }

  if (isRecord(schema.not)) {
    const nested: string[] = [];
    validateNode(schema.not, value, pointer, nested, root, depth + 1);
    if (!nested.length) issues.push(`${pointer} satisfies a forbidden schema.`);
  }
  if (isRecord(schema.if)) {
    const condition: string[] = [];
    validateNode(schema.if, value, pointer, condition, root, depth + 1);
    const branch = condition.length ? schema.else : schema.then;
    if (isRecord(branch)) validateNode(branch, value, pointer, issues, root, depth + 1);
  }

  const expected = schema.type;
  const expectedTypes = typeof expected === "string" ? [expected] : Array.isArray(expected) ? expected.filter((item): item is string => typeof item === "string") : [];
  if (expectedTypes.length && !expectedTypes.some((type) => matchesType(type, value))) {
    issues.push(`${pointer} must be ${expectedTypes.join(" or ")}.`);
    return;
  }

  if (isRecord(value)) validateObject(schema, value, pointer, issues, root, depth);
  if (Array.isArray(value)) validateArray(schema, value, pointer, issues, root, depth);
  if (typeof value === "string") validateString(schema, value, pointer, issues);
  if (typeof value === "number") validateNumber(schema, value, pointer, issues);
}

function validateObject(schema: Record<string, unknown>, value: Record<string, unknown>, pointer: string, issues: string[], root: Record<string, unknown>, depth: number): void {
  if (typeof schema.minProperties === "number" && Object.keys(value).length < schema.minProperties) issues.push(`${pointer} has too few properties.`);
  if (typeof schema.maxProperties === "number" && Object.keys(value).length > schema.maxProperties) issues.push(`${pointer} has too many properties.`);
  const required = Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === "string") : [];
  for (const key of required) if (!(key in value)) issues.push(`${pointer}.${key} is required.`);
  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const [key, child] of Object.entries(properties)) {
    if (key in value && isRecord(child)) validateNode(child, value[key], `${pointer}.${key}`, issues, root, depth + 1);
  }
  const patterns = isRecord(schema.patternProperties) ? Object.entries(schema.patternProperties).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1])) : [];
  const unmatched: string[] = [];
  for (const key of Object.keys(value)) {
    if (key in properties) continue;
    const matching = patterns.filter(([pattern]) => safeRegex(pattern)?.test(key));
    for (const [, child] of matching) validateNode(child, value[key], `${pointer}.${key}`, issues, root, depth + 1);
    if (!matching.length) unmatched.push(key);
  }
  if (schema.additionalProperties === false) {
    for (const key of unmatched) issues.push(`${pointer}.${key} is not allowed.`);
  } else if (isRecord(schema.additionalProperties)) {
    for (const key of unmatched) validateNode(schema.additionalProperties, value[key], `${pointer}.${key}`, issues, root, depth + 1);
  }
  if (isRecord(schema.dependentRequired)) {
    for (const [key, dependencies] of Object.entries(schema.dependentRequired)) {
      if (!(key in value) || !Array.isArray(dependencies)) continue;
      for (const dependency of dependencies) if (typeof dependency === "string" && !(dependency in value)) issues.push(`${pointer}.${dependency} is required when ${key} is present.`);
    }
  }
}

function validateArray(schema: Record<string, unknown>, value: unknown[], pointer: string, issues: string[], root: Record<string, unknown>, depth: number): void {
  if (typeof schema.minItems === "number" && value.length < schema.minItems) issues.push(`${pointer} has too few items.`);
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) issues.push(`${pointer} has too many items.`);
  if (schema.uniqueItems === true && new Set(value.map((entry) => JSON.stringify(entry))).size !== value.length) {
    issues.push(`${pointer} must contain unique items.`);
  }
  const prefixItems = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
  prefixItems.forEach((item, index) => { if (index < value.length && isRecord(item)) validateNode(item, value[index], `${pointer}[${index}]`, issues, root, depth + 1); });
  if (isRecord(schema.items)) value.slice(prefixItems.length).forEach((entry, offset) => validateNode(schema.items as Record<string, unknown>, entry, `${pointer}[${offset + prefixItems.length}]`, issues, root, depth + 1));
  if (isRecord(schema.contains)) {
    const matches = value.filter((entry, index) => {
      const nested: string[] = [];
      validateNode(schema.contains as Record<string, unknown>, entry, `${pointer}[${index}]`, nested, root, depth + 1);
      return nested.length === 0;
    }).length;
    const minimum = typeof schema.minContains === "number" ? schema.minContains : 1;
    const maximum = typeof schema.maxContains === "number" ? schema.maxContains : Number.POSITIVE_INFINITY;
    if (matches < minimum || matches > maximum) issues.push(`${pointer} does not satisfy contains constraints.`);
  }
}

function validateString(schema: Record<string, unknown>, value: string, pointer: string, issues: string[]): void {
  if (typeof schema.minLength === "number" && value.length < schema.minLength) issues.push(`${pointer} is too short.`);
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) issues.push(`${pointer} is too long.`);
  if (typeof schema.pattern === "string") {
    const pattern = safeRegex(schema.pattern);
    if (!pattern) issues.push(`${pointer} uses an unsafe or invalid pattern.`);
    else if (!pattern.test(value)) issues.push(`${pointer} does not match pattern.`);
  }
  if (typeof schema.format === "string" && !matchesFormat(schema.format, value)) issues.push(`${pointer} does not match format ${schema.format}.`);
}

function validateNumber(schema: Record<string, unknown>, value: number, pointer: string, issues: string[]): void {
  if (!Number.isFinite(value)) { issues.push(`${pointer} must be finite.`); return; }
  if (typeof schema.minimum === "number" && value < schema.minimum) issues.push(`${pointer} is below minimum.`);
  if (typeof schema.maximum === "number" && value > schema.maximum) issues.push(`${pointer} is above maximum.`);
  if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) issues.push(`${pointer} is not above exclusive minimum.`);
  if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) issues.push(`${pointer} is not below exclusive maximum.`);
  if (typeof schema.multipleOf === "number" && schema.multipleOf > 0 && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > Number.EPSILON * 10) issues.push(`${pointer} is not a multiple of ${schema.multipleOf}.`);
}

function matchesType(type: string, value: unknown): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return typeof value === type;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function resolveLocalRef(root: Record<string, unknown>, reference: string): Record<string, unknown> | undefined {
  if (reference === "#") return root;
  if (!reference.startsWith("#/")) return undefined;
  let cursor: unknown = root;
  for (const raw of reference.slice(2).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isRecord(cursor) || !(key in cursor)) return undefined;
    cursor = cursor[key];
  }
  return isRecord(cursor) ? cursor : undefined;
}

function safeRegex(pattern: string): RegExp | undefined {
  if (pattern.length > 512 || /\\[1-9]|\(\?[=!<]/.test(pattern) || /\([^)]*[+*][^)]*\)[+*{]/.test(pattern)) return undefined;
  try { return new RegExp(pattern, "u"); } catch { return undefined; }
}

function matchesFormat(format: string, value: string): boolean {
  if (format === "date-time") return !Number.isNaN(Date.parse(value)) && /T/.test(value);
  if (format === "date") return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
  if (format === "time") return /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-][0-2]\d:[0-5]\d)$/.test(value);
  if (format === "uuid") return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  if (format === "uri" || format === "uri-reference") { try { new URL(value, format === "uri-reference" ? "https://reference.invalid" : undefined); return true; } catch { return false; } }
  if (format === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  return true;
}
