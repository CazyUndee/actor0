import type { ToolCall } from "@actor0/harness";
import { type CandidateId, type RawCandidate, toOpenAiTools, type OpenAiTool } from "./candidates.js";
import {
  OPERATION_FIELDS,
  OPERATION_REQUIRED,
  SUPPORTED_OPERATIONS,
  type OperationName,
  type Underlying,
} from "./underlying.js";

/**
 * The candidate dispatcher.
 *
 * Given a candidate and a tool call, it resolves the operation the call names,
 * validates it at the **schema level** (the operation's required fields are
 * present; for the strict candidates, no unknown fields), then executes it at
 * the **semantic level** against the shared underlying operations. The two
 * validities are recorded separately, and a missing required argument is a
 * schema failure that is *never* silently filled and counted as valid.
 *
 * Candidate C's schema is permissive (one shared field pool per group), so the
 * dispatcher — not the schema — enforces each operation's required fields.
 * Candidate D's `oneOf` is validated branch by branch: the `op` must name a
 * real branch, that branch's required fields must be present, and no field
 * outside the branch is allowed.
 */

export type CallRecord = {
  candidate: CandidateId;
  /** The tool name the model called. */
  tool: string;
  /** The resolved operation, or null if the call named none. */
  op: OperationName | null;
  schemaValid: boolean;
  semanticValid: boolean;
  /** The operation is real and well-formed but Actor0 cannot perform it (delete). */
  unsupported: boolean;
  error?: string;
};

export type Dispatcher = {
  candidate: RawCandidate;
  records: CallRecord[];
  definitions(): OpenAiTool[];
  execute(call: ToolCall, signal: AbortSignal): Promise<string>;
};

/** Candidate A: production tool name → operation. */
const A_OP: Record<string, OperationName> = {
  read: "read", write: "write", edit: "edit", rg: "grep", glob: "glob", shell: "shell", skill: "skill", task: "delegate",
};
/** Candidate C: the operation value inside each grouped tool → operation. */
const C_INSPECT: Record<string, OperationName> = { read: "read", grep: "grep", glob: "glob", tree: "tree", index: "index", skill: "skill" };
const C_MODIFY: Record<string, OperationName> = { write: "write", edit: "edit", delete: "delete" };
const C_WEB: Record<string, OperationName> = { search: "web_search", fetch: "fetch" };

type Resolution = { op: OperationName | null; required: string[]; strict: boolean; error?: string };

function parseArgs(call: ToolCall): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(call.function.arguments || "{}");
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const present = (args: Record<string, unknown>, field: string): boolean =>
  Object.prototype.hasOwnProperty.call(args, field) && args[field] !== undefined && args[field] !== null;

/** Resolve which operation a call names, and how strictly to validate it. */
function resolve(candidate: CandidateId, call: ToolCall): Resolution {
  const tool = call.function.name;
  const args = parseArgs(call);
  const opValue = typeof args.op === "string" ? args.op : "";

  if (candidate === "A") {
    const op = A_OP[tool];
    if (!op) return { op: null, required: [], strict: false, error: `unknown production tool "${tool}"` };
    return { op, required: OPERATION_REQUIRED[op], strict: false };
  }
  if (candidate === "B") {
    if (!(tool in OPERATION_REQUIRED)) return { op: null, required: [], strict: true, error: `unknown tool "${tool}"` };
    const op = tool as OperationName;
    return { op, required: OPERATION_REQUIRED[op], strict: true };
  }
  if (candidate === "C") {
    if (tool === "shell") return { op: "shell", required: OPERATION_REQUIRED.shell, strict: false };
    if (tool === "delegate") return { op: "delegate", required: OPERATION_REQUIRED.delegate, strict: false };
    if (tool === "inspect") {
      const op = C_INSPECT[opValue];
      if (!op) return { op: null, required: [], strict: false, error: `inspect needs op ∈ {${Object.keys(C_INSPECT).join(", ")}}` };
      return { op, required: OPERATION_REQUIRED[op], strict: false };
    }
    if (tool === "modify") {
      const op = C_MODIFY[opValue];
      if (!op) return { op: null, required: [], strict: false, error: `modify needs op ∈ {${Object.keys(C_MODIFY).join(", ")}}` };
      // modify's schema requires op + path; the dispatcher adds the op-specific fields.
      const extra = OPERATION_REQUIRED[op].filter((field) => field !== "path");
      return { op, required: ["op", "path", ...extra], strict: false };
    }
    if (tool === "web") {
      const op = C_WEB[opValue];
      if (!op) return { op: null, required: [], strict: false, error: "web needs op ∈ {search, fetch}" };
      return { op, required: OPERATION_REQUIRED[op], strict: false };
    }
    return { op: null, required: [], strict: false, error: `unknown tool "${tool}"` };
  }
  // Candidate D — one universal `act` tool with a oneOf union.
  if (tool !== "act") return { op: null, required: [], strict: true, error: `unknown tool "${tool}" (candidate D exposes only "act")` };
  if (!(opValue in OPERATION_REQUIRED)) return { op: null, required: [], strict: true, error: `act op "${opValue}" is not a known operation` };
  const op = opValue as OperationName;
  return { op, required: OPERATION_REQUIRED[op], strict: true };
}

export function createDispatcher(candidate: RawCandidate, underlying: Underlying): Dispatcher {
  const records: CallRecord[] = [];
  return {
    candidate,
    records,
    definitions: () => toOpenAiTools(candidate),
    async execute(call, signal): Promise<string> {
      const tool = call.function.name;
      const args = parseArgs(call);
      const res = resolve(candidate.id, call);

      // --- schema level ---
      let schemaError = res.error;
      if (!schemaError && res.op) {
        for (const field of res.required) {
          if (!present(args, field)) {
            schemaError = `missing required "${field}"`;
            break;
          }
        }
      }
      if (!schemaError && res.strict && res.op) {
        const allowed = new Set<string>(["op", ...OPERATION_FIELDS[res.op]]);
        for (const key of Object.keys(args)) {
          if (!allowed.has(key)) {
            schemaError = `unknown field "${key}" for ${res.op}`;
            break;
          }
        }
      }
      if (schemaError || !res.op) {
        records.push({ candidate: candidate.id, tool, op: res.op, schemaValid: false, semanticValid: false, unsupported: false, error: schemaError ?? "could not resolve the operation" });
        return `error: ${schemaError ?? "could not resolve the operation"}`;
      }

      const op = res.op;
      // --- unsupported capability (real + well-formed, but Actor0 cannot do it) ---
      if (!SUPPORTED_OPERATIONS.includes(op)) {
        records.push({ candidate: candidate.id, tool, op, schemaValid: true, semanticValid: false, unsupported: true, error: `${op} is not a supported capability` });
        return `error: "${op}" is not a capability Actor0 supports.`;
      }

      // --- semantic level ---
      try {
        const output = await underlying.run(op, args, signal);
        records.push({ candidate: candidate.id, tool, op, schemaValid: true, semanticValid: true, unsupported: false });
        return output;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        records.push({ candidate: candidate.id, tool, op, schemaValid: true, semanticValid: false, unsupported: false, error: message });
        return `error: ${message}`;
      }
    },
  };
}
