import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The benchmark tasks. Every candidate runs the same set, in the same starting
 * workspace, against the same model and limits — only the tool interface
 * differs. Each task has a prompt, a workspace setup, and a success predicate
 * over the final workspace (and, where useful, the answer text), so completion
 * is measured the same way for every candidate.
 */

export type Task = {
  id: string;
  /** What the user asks. */
  prompt: string;
  /** Capabilities this task exercises, for per-capability reporting. */
  capabilities: string[];
  /** Files to create in the fresh workspace before the turn. */
  setup: (dir: string) => void;
  /** Did the candidate complete the task? */
  success: (dir: string, answer: string) => boolean;
};

const write = (dir: string, rel: string, content: string): void => {
  const path = join(dir, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
};

/** A small multi-file project the harder tasks operate on. */
const miniProject = (dir: string): void => {
  write(dir, "src/index.ts", "import { computeTotal } from './math';\n\nconsole.log(computeTotal([1, 2, 3]));\n");
  write(dir, "src/math.ts", "export function computeTotal(nums: number[]): number {\n  let sum = 0;\n  for (const n of nums) sum += n;\n  return sum + 1;\n}\n");
  write(dir, "src/notes.md", "# Notes\n\nTODO: add more functions\n\nSome prose here.\n\nTODO: write tests\n");
};

export const TASKS: Task[] = [
  {
    id: "read-and-report",
    prompt: "What number is on the line labelled ANSWER in note.txt? Reply with just the number.",
    capabilities: ["read"],
    setup: (dir) => write(dir, "note.txt", "filler\nfiller\nANSWER 4242\nfiller\n"),
    success: (_dir, answer) => /\b4242\b/.test(answer),
  },
  {
    id: "create-file",
    prompt: "Create a file called hello.txt whose entire contents are the single line: hi there.",
    capabilities: ["write"],
    setup: () => {},
    success: (dir) => existsSync(join(dir, "hello.txt")) && readFileSync(join(dir, "hello.txt"), "utf8").trim() === "hi there",
  },
  {
    id: "edit-file",
    prompt: "In config.txt, change the word DRAFT to FINAL. Nothing else.",
    capabilities: ["edit"],
    setup: (dir) => write(dir, "config.txt", "status: DRAFT\nowner: team\n"),
    success: (dir) => existsSync(join(dir, "config.txt")) && /status: FINAL/.test(readFileSync(join(dir, "config.txt"), "utf8")) && !/DRAFT/.test(readFileSync(join(dir, "config.txt"), "utf8")),
  },
  {
    id: "search-and-report",
    prompt: "Which file contains the token FIXME? Reply with just the file path.",
    capabilities: ["grep"],
    setup: (dir) => {
      write(dir, "a.txt", "nothing here\n");
      write(dir, "src/b.txt", "// FIXME later\ncode\n");
    },
    success: (_dir, answer) => /b\.txt/.test(answer),
  },
  {
    id: "list-and-report",
    prompt: "Does a file named target.log exist anywhere? Reply yes or no.",
    capabilities: ["glob"],
    setup: (dir) => write(dir, "logs/target.log", "entry\n"),
    success: (_dir, answer) => /\byes\b/i.test(answer),
  },
  // --- harder, multi-step tasks that stress the search→edit→shell flow ---
  {
    id: "rename-symbol",
    prompt: "Rename the function computeTotal to calculateTotal everywhere under src/ — both its definition and its call site. Keep everything else the same.",
    capabilities: ["glob", "grep", "edit"],
    setup: miniProject,
    success: (dir) => {
      const texts = ["src/index.ts", "src/math.ts"].map((f) =>
        existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "",
      );
      return texts.every((t) => !t.includes("computeTotal")) && texts.every((t) => t.includes("calculateTotal"));
    },
  },
  {
    id: "fix-off-by-one",
    prompt: "In src/math.ts, computeTotal adds 1 to the sum before returning. It should return the plain sum of the numbers. Fix it.",
    capabilities: ["read", "edit"],
    setup: miniProject,
    success: (dir) => {
      const path = join(dir, "src/math.ts");
      if (!existsSync(path)) return false;
      const text = readFileSync(path, "utf8");
      return /return sum;/.test(text) && !/sum \+ 1/.test(text);
    },
  },
  {
    id: "count-todos",
    prompt: "How many lines under src/ contain the word TODO? Reply with just the number.",
    capabilities: ["grep"],
    setup: miniProject,
    success: (_dir, answer) => /\b2\b/.test(answer),
  },
  {
    id: "create-and-wire",
    prompt: "Create src/greet.ts that exports a function greet(name) returning the string 'Hi ' followed by the name. Then edit src/index.ts to import greet from './greet' and log greet('world').",
    capabilities: ["write", "edit"],
    setup: miniProject,
    success: (dir) => {
      const greet = join(dir, "src/greet.ts");
      const index = join(dir, "src/index.ts");
      if (!existsSync(greet) || !existsSync(index)) return false;
      const g = readFileSync(greet, "utf8");
      const i = readFileSync(index, "utf8");
      return /export function greet/.test(g) && /import .*greet.*from ['"]\.\/greet['"]/.test(i) && /greet\(['"]world['"]\)/.test(i);
    },
  },
];
