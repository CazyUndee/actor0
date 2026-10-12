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
];
