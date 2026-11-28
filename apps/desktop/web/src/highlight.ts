/**
 * Syntax highlighting for fenced code, with Prism.
 *
 * Two constraints shaped this:
 *
 *  - **The code is usually half-written.** For most of a streaming answer the
 *    fence has not closed yet, so highlighting runs on an unterminated snippet
 *    on every frame. Prism is a synchronous string→string pass over the
 *    grammar, which is cheap enough to redo per frame; Shiki's WASM grammars
 *    are not, and a highlighter that lags turns reading the answer into a
 *    slideshow.
 *  - **The themes are a handful of tokens, not a theme package.** Prism emits
 *    `token keyword` and friends, so `styles.css` colours them with the same
 *    semantic variables as the rest of the app. No second palette to keep in
 *    sync with `--surface`.
 *
 * A language with no grammar here is not an error: the block renders as plain
 * code, which is exactly what it looked like before. The tag is still shown, so
 * a reader can see what the model claimed.
 */
import Prism from "prismjs";

// The grammars this app can colour. Every one is a small file; the list is
// deliberately short because each import is bundle weight paid on every boot,
// and a coding agent's fences are overwhelmingly these. Adding one is a line.
import "prismjs/components/prism-markup";
import "prismjs/components/prism-css";
import "prismjs/components/prism-clike";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-json";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-python";
import "prismjs/components/prism-go";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-diff";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-powershell";

/**
 * The tag a model writes, to the grammar that colours it.
 *
 * A model writes `sh`, `yml`, `ps1` and `html` as often as `bash`, `yaml`,
 * `powershell` and `markup`; Prism registers only some of each pair, so the
 * aliases it does register are mapped here rather than by importing the same
 * grammar twice.
 */
const ALIASES: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  node: "javascript",
  ts: "typescript",
  py: "python",
  python3: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  shellscript: "bash",
  yml: "yaml",
  html: "markup",
  xml: "markup",
  svg: "markup",
  rs: "rust",
  golang: "go",
  ps1: "powershell",
  pwsh: "powershell",
  md: "markdown",
  postgres: "sql",
  postgresql: "sql",
};

/** The grammar for a fence's language tag, if this build has one. */
export function grammarFor(lang?: string): { id: string; grammar: Prism.Grammar } | undefined {
  if (!lang) return undefined;
  const id = ALIASES[lang.toLowerCase()] ?? lang.toLowerCase();
  const grammar = Prism.languages[id];
  return grammar ? { id, grammar } : undefined;
}

/**
 * The highlighted markup for a fence, or undefined when it cannot be coloured.
 *
 * Prism escapes the code as it tokenises it, so the returned string is safe to
 * put in the DOM — a snippet containing `<script>` arrives as text.
 */
export function highlight(code: string, lang?: string): string | undefined {
  const found = grammarFor(lang);
  if (!found) return undefined;
  try {
    return Prism.highlight(code, found.grammar, found.id);
  } catch {
    // A grammar that throws on half-written input must cost nothing more than
    // losing the colour; the code itself is the answer.
    return undefined;
  }
}
