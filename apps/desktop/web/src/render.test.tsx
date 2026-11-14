import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import type { Entry } from "./conversation";
import { EntryView, ToolEntry } from "./components/Entry";
import { Markdown } from "./components/Markdown";
import { Composer } from "./components/Composer";
import { Panel } from "./components/Panels";
import { SessionDropdown } from "./components/SessionDropdown";

/**
 * Does it actually render?
 *
 * The reducer and the parser are unit-tested as logic, but a component that
 * throws on a real entry — an undefined field read, a hook in a branch — is
 * invisible to those tests and to a typecheck. Rendering each surface to static
 * markup is the cheapest thing that catches it, and it runs in Node with no
 * browser and no DOM.
 */

const markup = (node: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(node);

describe("rendering an entry", () => {
  const cases: { name: string; entry: Entry; expect: string }[] = [
    { name: "user", entry: { kind: "user", text: "what is in the readme?" }, expect: "what is in the readme?" },
    {
      name: "assistant with markdown",
      entry: { kind: "assistant", text: "Use `npm test`:\n\n```bash\nnpm test\n```", partial: false },
      expect: "<pre",
    },
    { name: "partial assistant", entry: { kind: "assistant", text: "half an answer", partial: true }, expect: "incomplete" },
    { name: "reasoning", entry: { kind: "reasoning", text: "I should read the file", durationSeconds: 2.5 }, expect: "thought" },
    { name: "plan", entry: { kind: "plan", title: "Plan", plan: "1. read\n2. write" }, expect: "Plan" },
    { name: "help", entry: { kind: "help" }, expect: "Enter sends" },
    {
      name: "tool",
      entry: {
        kind: "tool",
        name: "read",
        target: "src/index.ts",
        status: "ok",
        output: { data: "contents", text: "contents" },
      },
      expect: "src/index.ts",
    },
  ];

  for (const testCase of cases) {
    it(`renders a ${testCase.name} entry`, () => {
      const html = markup(<EntryView entry={testCase.entry} />);
      assert.ok(html.includes(testCase.expect), `expected ${testCase.expect} in ${html.slice(0, 200)}`);
    });
  }

  it("renders a failed tool with its error glyph", () => {
    const html = markup(<ToolEntry entry={{ kind: "tool", name: "shell", target: "false", status: "error", output: { data: "boom", text: "boom" } }} />);
    assert.ok(html.includes("err"));
    assert.ok(html.includes("shell"));
  });

  it("uses SVG chevron carets, not triangle glyphs, for expand/collapse", () => {
    // The expand/collapse affordance is a vector chevron (caret-svg class): a
    // text glyph rides the font's baseline and never centres optically. Pin
    // both the class and the absence of the triangle glyphs. (The tool entry
    // toggles with +/−, which is a different affordance, so only the reasoning
    // entry is asserted here.)
    const html = markup(<EntryView entry={{ kind: "reasoning", text: "a thought" }} />);
    assert.ok(html.includes("caret-svg"), `vector caret missing: ${html.slice(0, 200)}`);
    assert.ok(!html.includes("▾") && !html.includes("▸"), `triangle caret leaked: ${html.slice(0, 200)}`);
  });
});

describe("rendering markdown", () => {
  it("renders a fenced block with its language and body", () => {
    const html = markup(<Markdown text={"```ts\nconst x = 1;\n```"} />);
    assert.ok(html.includes("md-fence"));
    assert.ok(html.includes("ts"));
    assert.ok(html.includes("const x = 1;"));
  });

  it("marks a still-streaming fence rather than pretending it is prose", () => {
    const html = markup(<Markdown text={"```bash\nnpm run build"} />);
    assert.ok(html.includes("streaming"));
  });

  it("renders a table as a table", () => {
    const html = markup(<Markdown text={"| a | b |\n| - | - |\n| 1 | 2 |"} />);
    assert.ok(html.includes("<table"));
    assert.ok(html.includes("<th"));
    assert.ok(html.includes("<td"));
  });

  it("renders headings, lists, quotes and inline code", () => {
    const html = markup(<Markdown text={"## Title\n\n- one\n- two\n\n> quoted\n\nwith `code`"} />);
    for (const fragment of ["<h2", "<ul", "<li", "<blockquote", "md-code"]) {
      assert.ok(html.includes(fragment), `expected ${fragment}`);
    }
  });
});

describe("rendering chrome", () => {
  it("renders the composer with the slash popup closed for ordinary text", () => {
    const html = markup(
      <Composer value="hello" onChange={() => {}} onSubmit={() => {}} onCancel={() => {}} busy={false} blocked={false} />,
    );
    assert.ok(html.includes("composer-input"));
    assert.ok(!html.includes("slash-popup"));
  });

  it("opens the centered slash palette for a half-typed command", () => {
    const html = markup(<Composer value="/" onChange={() => {}} onSubmit={() => {}} onCancel={() => {}} busy={false} blocked={false} />);
    assert.ok(html.includes("slash-modal"));
    assert.ok(html.includes("slash-modal-panel"));
    assert.ok(html.includes("/provider"));
  });

  it("shows the stop affordance while a turn is running", () => {
    const html = markup(<Composer value="" onChange={() => {}} onSubmit={() => {}} onCancel={() => {}} busy blocked={false} />);
    assert.ok(html.includes("Stop"));
  });

  it("renders a panel with its title and footer", () => {
    const html = markup(
      <Panel title="sessions" onClose={() => {}} footer="Esc to close">
        <div>row</div>
      </Panel>,
    );
    assert.ok(html.includes("sessions"));
    assert.ok(html.includes("Esc to close"));
    assert.ok(html.includes("row"));
  });
});

describe("rendering the M2 interaction surfaces", () => {
  it("renders the copy affordance on an assistant entry", () => {
    const html = markup(<EntryView entry={{ kind: "assistant", text: "an answer", partial: false }} />);
    assert.ok(html.includes("copy-button"), "the copy control is there");
    assert.ok(html.includes("Copy the answer"));
  });

  it("renders a copy control on a plan entry", () => {
    const html = markup(<EntryView entry={{ kind: "plan", title: "The plan", plan: "1. read" }} />);
    assert.ok(html.includes("Copy the plan"));
  });

  it("renders the help entry as the command list, with aliases and descriptions", () => {
    const html = markup(<EntryView entry={{ kind: "help" }} />);
    // The `/name  /alias` column is what teaches the aliases.
    assert.ok(html.includes("/provider"), "the provider command is listed");
    assert.ok(html.includes("/p"), "its alias is listed beside it");
    assert.ok(html.includes("switch, sign in, add or remove"));
    assert.ok(html.includes("commands"), "the listing has a title");
  });

  it("does not render a copy control on tool rows — the target is one click away", () => {
    const html = markup(
      <ToolEntry
        entry={{ kind: "tool", name: "read", target: "a.ts", status: "ok", output: { data: "x", text: "x" } }}
      />,
    );
    assert.ok(!html.includes("entry-copy"));
  });
});

describe("rendering the conversation picker", () => {
  const sessions = [
    { id: "a", updatedAt: "2026-11-14T10:00:00Z", model: "gpt", messageCount: 2, cwd: "d:/projects/actor0", title: "fix the window" },
    { id: "b", updatedAt: "2026-11-14T09:00:00Z", model: "gpt", messageCount: 4, cwd: "d:/projects/actor0" },
    { id: "c", updatedAt: "2026-11-13T09:00:00Z", model: "gpt", messageCount: 1, cwd: "d:/projects/other" },
  ];

  it("groups sessions by the last path segment and names them", () => {
    const html = markup(
      <SessionDropdown
        sessions={sessions}
        currentId="a"
        busy={false}
        stopped={new Set()}
        onLoad={() => {}}
        onNew={() => {}}
        onDelete={() => {}}
        onPickFolder={async () => undefined}
        initiallyOpen
      />,
    );
    // The group header is the last path segment, not the full path.
    assert.ok(html.includes(">actor0<"), "expected the actor0 group name");
    assert.ok(html.includes(">other<"), "expected the other group name");
    assert.ok(!html.includes("d:/projects"), "the full path must not be the group name");
  });

  it("marks the current conversation, the streaming one, and stopped ones", () => {
    const html = markup(
      <SessionDropdown
        sessions={sessions}
        currentId="a"
        busy
        stopped={new Set(["b"])}
        onLoad={() => {}}
        onNew={() => {}}
        onDelete={() => {}}
        onPickFolder={async () => undefined}
        initiallyOpen
      />,
    );
    assert.ok(html.includes("✓"), "the current conversation carries a tick");
    assert.ok(html.includes("active-turn"), "the streaming conversation shimmers");
    assert.ok(html.includes("stopped-dot"), "a stopped conversation carries a dot");
    // A titled session shows the model's title, not its id.
    assert.ok(html.includes("fix the window"));
  });

  it("renders the new-conversation and delete affordances", () => {
    const html = markup(
      <SessionDropdown
        sessions={sessions}
        currentId={null}
        busy={false}
        stopped={new Set()}
        onLoad={() => {}}
        onNew={() => {}}
        onDelete={() => {}}
        onPickFolder={async () => undefined}
        initiallyOpen
      />,
    );
    assert.ok(html.includes("new conversation"));
    assert.ok(html.includes("delete conversations"));
  });
});
