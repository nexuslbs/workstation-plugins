/**
 * Tools capability - SERVICE DEFINITION in the DSH shape.
 *
 * This is the `tools@1` contract of the workstation plugins repository, written
 * against the deepseek-harness tool API (the harness `ToolRuntime`):
 *
 *   ctx.tools.register(defineTool({ name, description, parameters, execute, output }))
 *
 * The author form of `parameters` is the same per-property parameter map DSH
 * uses (`ParameterSchemaSpec`): it COMPILES to plain JSON Schema
 * (`parameterSchemaSpecToJsonSchema`, DSH `packages/core/tools/src/schema.ts`),
 * `validateArgs(spec, args)` returns path-qualified violations BEFORE the
 * handler runs (DSH `schema.ts:478`), and registration is fail-closed on a
 * duplicate name exactly like the DSH `ToolRuntime` registry
 * (`packages/core/tools/src/index.ts`).
 *
 * The consumer slice a plugin calls is `ctx.tools.register(def)` returning the
 * disposer that unregisters the tool. `output` is REQUIRED by the harness
 * (`output.schema` + `output.render`): `renderValue` is the generic renderer
 * every consumer of this repository uses (any canonical value -> one text
 * content block), mirroring what the workbench compat adapter supplied.
 *
 * This module is CORDIS-FREE and imports nothing: the contract is STRUCTURAL,
 * so the file compiles and runs inside any host that exposes a `tools` service
 * with the published shape.
 */

/** Name of the cordis service (`ctx.tools`). */
export const TOOLS = 'tools'

/** Contract version this definition speaks. A provider must implement it. */
export const TOOLS_VERSION = 1

/** Contract id including the version, e.g. `tools@1`. */
export const TOOLS_CONTRACT = `${TOOLS}@${TOOLS_VERSION}`

/**
 * Scalar/structural kinds a parameter may declare. They map 1:1 to the JSON
 * Schema `type` keyword, plus `integer` and the escape hatch `json` (any JSON
 * value, DSH's `json` author node).
 */
export type ParameterType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'json'

/**
 * One declared parameter (DSH `ParameterSchemaSpec` node). `required: true`
 * marks the property required IN ITS PARENT; the compiler folds those flags into
 * the parent's JSON Schema `required` array.
 */
export interface ParameterSpec {
  type: ParameterType
  /** Human readable purpose, shown in `GET /api/tools` and `workbench tools`. */
  description?: string
  /** True when the caller MUST pass this parameter. */
  required?: boolean
  /** Allowed scalar values (closed set). */
  enum?: readonly (string | number | boolean)[]
  /** `array` only: the schema of one element. */
  items?: ParameterSpec
  /** `object` only: the property map of the nested object. */
  properties?: ParameterSchemaSpec
}

/**
 * The parameter map a tool registers: one entry per parameter, DSH's author
 * form. An omitted/empty map means the tool takes no parameters (and any
 * parameter in the body is then an "unknown parameter" violation).
 */
export type ParameterSchemaSpec = Record<string, ParameterSpec>

/** One property of the compiled JSON Schema. */
export interface ParameterJsonSchemaProperty {
  type: ParameterType
  description?: string
  enum?: readonly (string | number | boolean)[]
  items?: ParameterJsonSchemaProperty
  /** `object` only: the nested property map (same shape as the root schema). */
  properties?: ParameterJsonSchema
  required?: string[]
}

/** The compiled JSON Schema of a tool's parameters (what `GET /api/tools` shows). */
export interface ParameterJsonSchema {
  type: 'object'
  properties: Record<string, ParameterJsonSchemaProperty>
  required?: string[]
}

/** The body/param value did not satisfy the registered parameter schema. */
export class ToolArgsError extends Error {
  readonly tool: string
  /** Human readable, path-qualified violations; empty means valid. */
  readonly violations: string[]

  constructor(tool: string, violations: string[]) {
    super(`invalid params for tool '${tool}': ${violations.join('; ')}`)
    this.name = 'ToolArgsError'
    this.tool = tool
    this.violations = violations
  }
}

/** The tool named by the caller is not registered (or was disposed). */
export class ToolUnknownError extends Error {
  readonly tool: string

  constructor(tool: string) {
    super(`unknown tool '${tool}'`)
    this.name = 'ToolUnknownError'
    this.tool = tool
  }
}

function authorError(message: string): never {
  throw new Error(`tools: ${message}`)
}

/** Plain object check (no arrays, no null, no class instances). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The JSON kind of a candidate value, for readable violations. */
function kindOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** Compiles ONE declared parameter, validating the declaration itself. */
function compileProperty(spec: ParameterSpec, where: string): ParameterJsonSchemaProperty {
  if (!isPlainObject(spec)) authorError(`${where} must be an object with a 'type' (got ${kindOf(spec)})`)
  const { type, description, required, enum: values, items, properties } = spec
  const allowed: ParameterType[] = ['string', 'number', 'integer', 'boolean', 'array', 'object', 'json']
  if (typeof type !== 'string' || !allowed.includes(type as ParameterType)) {
    authorError(`${where}.type must be one of ${allowed.join('/')} (got ${JSON.stringify(type)})`)
  }
  if (description !== undefined && typeof description !== 'string') authorError(`${where}.description must be a string`)
  if (required !== undefined && typeof required !== 'boolean') authorError(`${where}.required must be a boolean`)
  const compiled: ParameterJsonSchemaProperty = {
    type: type as ParameterType,
    ...(description === undefined ? {} : { description }),
  }
  if (values !== undefined) {
    if (!Array.isArray(values) || values.length === 0) authorError(`${where}.enum must be a non-empty array`)
    for (const value of values) {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        authorError(`${where}.enum entries must be scalars (string/number/boolean)`)
      }
    }
    compiled.enum = values
  }
  if (items !== undefined) {
    if (type !== 'array') authorError(`${where}.items is only valid for type 'array'`)
    compiled.items = compileProperty(items, `${where}.items`)
  }
  if (properties !== undefined) {
    if (type !== 'object') authorError(`${where}.properties is only valid for type 'object'`)
    compiled.properties = compileParameterMap(properties, `${where}.properties`)
  }
  return compiled
}

/** Compiles a parameter map into a JSON Schema object root (required folded in). */
export function parameterSchemaSpecToJsonSchema(spec: ParameterSchemaSpec): ParameterJsonSchema {
  return compileParameterMap(spec, 'parameters')
}

function compileParameterMap(spec: ParameterSchemaSpec, where: string): ParameterJsonSchema {
  if (!isPlainObject(spec)) authorError(`${where} must be a property map (got ${kindOf(spec)})`)
  const properties: Record<string, ParameterJsonSchemaProperty> = {}
  const required: string[] = []
  for (const [name, property] of Object.entries(spec)) {
    if (name.length === 0) authorError(`${where} has an empty parameter name`)
    properties[name] = compileProperty(property, `${where}.${name}`)
    if (property.required === true) required.push(name)
  }
  return { type: 'object', properties, ...(required.length === 0 ? {} : { required }) }
}

/** `parent.child` (or `child` at the root) - the path form of a violation. */
function joinPath(parent: string, name: string): string {
  return parent.length === 0 ? name : `${parent}.${name}`
}

function validateProperties(
  schema: ParameterJsonSchema,
  args: Record<string, unknown>,
  path: string,
  violations: string[],
): void {
  for (const name of schema.required ?? []) {
    if (!Object.hasOwn(args, name) || args[name] === undefined) {
      violations.push(`${joinPath(path, name)}: missing required parameter`)
    }
  }
  const accepted = Object.keys(schema.properties)
  for (const [name, value] of Object.entries(args)) {
    const where = joinPath(path, name)
    const property = schema.properties[name]
    if (property === undefined) {
      violations.push(`${where}: unknown parameter (accepted here: ${accepted.join(', ')})`)
      continue
    }
    validateValue(property, value, where, violations)
  }
}

function validateValue(
  property: ParameterJsonSchemaProperty,
  value: unknown,
  where: string,
  violations: string[],
): void {
  switch (property.type) {
    case 'string':
      if (typeof value !== 'string') violations.push(`${where}: expected a string, got ${kindOf(value)}`)
      break
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) violations.push(`${where}: expected a number, got ${kindOf(value)}`)
      break
    case 'integer':
      if (!Number.isInteger(value)) violations.push(`${where}: expected an integer, got ${kindOf(value)}`)
      break
    case 'boolean':
      if (typeof value !== 'boolean') violations.push(`${where}: expected a boolean, got ${kindOf(value)}`)
      break
    case 'array': {
      if (!Array.isArray(value)) {
        violations.push(`${where}: expected an array, got ${kindOf(value)}`)
        break
      }
      const items = property.items
      if (items) value.forEach((entry, index) => validateValue(items, entry, `${where}[${index}]`, violations))
      break
    }
    case 'object': {
      if (!isPlainObject(value)) {
        violations.push(`${where}: expected an object, got ${kindOf(value)}`)
        break
      }
      validateProperties(property.properties ?? { type: 'object', properties: {} }, value, where, violations)
      break
    }
    case 'json':
      break
  }
  if (property.enum !== undefined && !property.enum.some((allowed) => allowed === value)) {
    violations.push(`${where}: expected one of ${property.enum.map((allowed) => JSON.stringify(allowed)).join(', ')}, got ${JSON.stringify(value)}`)
  }
}

/**
 * Validates candidate parameters against a declared parameter map, DSH
 * `validateArgs` style: structural only (required, types, unknown keys, enum),
 * path-qualified and human readable; an empty array means the args are valid.
 * The harness calls this BEFORE `execute`, so a handler only ever sees a body
 * that satisfies its declared schema.
 */
export function validateArgs(spec: ParameterSchemaSpec, args: unknown): string[] {
  const schema = parameterSchemaSpecToJsonSchema(spec)
  if (!isPlainObject(args)) return [`params: expected an object, got ${kindOf(args)}`]
  const violations: string[] = []
  validateProperties(schema, args, '', violations)
  return violations
}

// ---------------------------------------------------------------------------
// The DSH output contract: every registered tool declares `output.schema`
// (enforced against every successful value) plus a PURE `render` projection
// (validated args + canonical value -> model/UI content blocks).
// ---------------------------------------------------------------------------

/**
 * The canonical output schema of a tool (a structural subset of the DSH
 * `ValueSchemaSpec`). `{}` accepts any JSON value - the generic choice of the
 * consumer plugins of this repository.
 */
export type ValueSchemaSpec = Record<string, unknown>

/** One content block of a rendered tool result (structural DSH `ContentBlock`). */
export interface ContentBlock {
  type: string
  text?: string
  [key: string]: unknown
}

/**
 * The registered tool definition in the DSH shape: what `ctx.tools.register`
 * accepts and what the harness executes.
 */
export interface ToolDefinition {
  /** Unique tool name, e.g. `hello greet`. */
  name: string
  /** Human readable purpose (sent to the model). */
  description: string
  /** The compiled parameter JSON Schema (snapshotted at registration). */
  parameters: ParameterJsonSchema
  /** Canonical output schema plus the pure render projection (REQUIRED). */
  output: {
    /** Schema enforced against every successful value. */
    schema: ValueSchemaSpec
    /** Pure projection from validated args + value to content blocks. */
    render(args: unknown, value: unknown): ContentBlock[]
  }
  /** Runs the tool with validated parameters and returns its canonical value. */
  execute(args: Record<string, unknown>, exec?: unknown): unknown | Promise<unknown>
}

/**
 * The DSH author form: `defineTool({ name, description, parameters, output,
 * execute })` compiles the parameter map to JSON Schema and returns a
 * registry-ready {@link ToolDefinition}. Structural and cordis-free: it does
 * not import the harness package, it just builds the exact object the harness
 * `ctx.tools.register` accepts.
 */
export function defineTool(options: {
  name: string
  description: string
  parameters: ParameterSchemaSpec
  output: { schema: ValueSchemaSpec; render(args: unknown, value: unknown): ContentBlock[] }
  execute(args: Record<string, unknown>, exec?: unknown): unknown | Promise<unknown>
}): ToolDefinition {
  const name = typeof options.name === 'string' ? options.name.trim() : ''
  if (name.length === 0) throw new Error('defineTool: a tool name is required')
  if (options.name !== name) throw new Error(`defineTool('${options.name}'): a tool name must not start or end with whitespace`)
  if (typeof options.execute !== 'function') throw new Error(`defineTool('${name}'): 'execute' must be a function`)
  if (options.output === null || typeof options.output !== 'object' || typeof options.output.render !== 'function') {
    throw new Error(`defineTool('${name}'): 'output' must declare { schema, render }`)
  }
  return {
    name,
    description: options.description,
    parameters: parameterSchemaSpecToJsonSchema(options.parameters),
    output: {
      schema: options.output.schema,
      render: (args: unknown, value: unknown): ContentBlock[] => options.output.render(args, value),
    },
    execute: async (args: Record<string, unknown>, exec?: unknown): Promise<unknown> => {
      const violations = validateArgs(options.parameters, args)
      if (violations.length > 0) throw new ToolArgsError(name, violations)
      return await options.execute(args ?? {}, exec)
    },
  }
}

/**
 * The generic renderer of this repository: any canonical value becomes ONE
 * text content block (a string stays verbatim; anything else is pretty-printed
 * JSON). This is the `output.render` every consumer plugin supplies, mirroring
 * what the workbench compat adapter used.
 */
export function renderValue(_args: unknown, value: unknown): ContentBlock[] {
  let text: string
  if (typeof value === 'string') text = value
  else if (value === undefined || value === null) text = ''
  else {
    try {
      text = JSON.stringify(value, null, 2)
    } catch {
      text = String(value)
    }
  }
  return [{ type: 'text', text }]
}

/**
 * The CONSUMER slice of the capability: what a consumer plugin calls
 * (`ctx.tools`). It registers a named tool and can read the registry; it never
 * runs a tool (that is the caller/provider surface).
 */
export interface ToolConsumer {
  /** Registers a tool (name + parameter schema + execute + output); returns the disposer. */
  register(def: ToolDefinition): () => void
}