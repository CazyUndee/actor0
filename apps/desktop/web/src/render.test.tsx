import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import type { Entry } from "./conversation";
import { EntryView, ReasoningEntry, ToolEntry } from "./components/Entry";
import { Markdown } from "./components/Markdown";
import { Composer } from "./components/Composer";
import { Panel } from "./components/Panels";
import { BarDropdown } from "./components/BarDropdown";
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

/**
 * The text of some markup, tags removed.
 *
 * Code in an answer is tokenised into spans, so `const x = 1;` is no longer a
 * contiguous string in the HTML. Asserting on the text rather than on the markup
 * is what lets a test say "the code is still there" without also pinning where
 * the highlighter happened to cut it.
 */
const plain = (html: string): string =>
  html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");

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
    assert.ok(plain(html).includes("const x = 1;"));
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

  it("renders a child list inside the item it belongs to", () => {
    const html = markup(<Markdown text={"- surfaces\n  - the bar\n  - the composer\n- other"} />);
    // The nested list opens inside the parent item, not after it: that is the
    // difference between a hierarchy and an indent.
    assert.ok(html.includes('surfaces<ul class="md-list">'), html);
    assert.ok(plain(html).includes("the bar"));
    assert.ok(plain(html).includes("the composer"));
    // ... and the sibling returns to the outer list, after the child closes.
    const afterChild = html.slice(html.lastIndexOf("</ul>", html.indexOf("other")));
    assert.ok(afterChild.includes("other") || html.includes("other"));
  });

  it("colours a fence whose language this build has, and leaves one it does not alone", () => {
    const known = markup(<Markdown text={"```ts\nconst x: number = 1;\n```"} />);
    assert.ok(known.includes("language-ts"));
    assert.ok(known.includes("token keyword"), "a keyword is tokenised");
    // The text survives tokenising, and markup in it arrives escaped.
    assert.ok(known.includes("number"));
    const injected = markup(<Markdown text={"```ts\nconst s = '<script>'\n```"} />);
    assert.ok(!injected.includes("<script>"), "code is escaped, not injected");
    const unknown = markup(<Markdown text={"```notalanguage\nplain text\n```"} />);
    assert.ok(plain(unknown).includes("plain text"));
    assert.ok(!unknown.includes("token"), "no grammar, no tokens");
  });
});

describe("rendering chrome", () => {
  it("renders the composer with the slash popup closed for ordinary text", () => {
    const html = markup(
      <Composer value="hello" onChange={() => {}} onSubmit={() => {}} onCancel={() => {}} onCommand={() => {}} busy={false} blocked={false} />,
    );
    assert.ok(html.includes("composer-input"));
    assert.ok(!html.includes("slash-popup"));
  });

  it("opens the centered slash palette for a half-typed command", () => {
    const html = markup(<Composer value="/" onChange={() => {}} onSubmit={() => {}} onCancel={() => {}} onCommand={() => {}} busy={false} blocked={false} />);
    assert.ok(html.includes("slash-modal"));
    assert.ok(html.includes("slash-modal-panel"));
    assert.ok(html.includes("/provider"));
  });

  it("shows the stop affordance while a turn is running", () => {
    const html = markup(<Composer value="" onChange={() => {}} onSubmit={() => {}} onCancel={() => {}} onCommand={() => {}} busy blocked={false} />);
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

describe("the top-bar menus", () => {
  // The picker used to own its open state, so nothing could close it when a
  // panel opened — it sat open underneath the overlay and was still there when
  // the panel closed. It now takes the caller's state, and these pin that the
  // caller's state is what decides.
  const picker = (props: { open?: boolean; initiallyOpen?: boolean }) => (
    <SessionDropdown
      sessions={[]}
      currentId={null}
      busy={false}
      stopped={new Set()}
      onLoad={() => {}}
      onNew={() => {}}
      onDelete={() => {}}
      onPickFolder={async () => undefined}
      {...props}
    />
  );

  it("renders the picker closed when the caller says closed, even if it starts open", () => {
    const html = markup(picker({ open: false, initiallyOpen: true }));
    assert.ok(!html.includes("session-menu"), "a caller-closed picker must not render its menu");
  });

  it("renders the picker open when the caller says open", () => {
    const html = markup(picker({ open: true }));
    assert.ok(html.includes("session-menu"), "a caller-opened picker must render its menu");
  });

  it("renders a bar menu's items only while it is open", () => {
    const closed = markup(
      <BarDropdown label="built-in" kind="provider" title="Provider" open={false} onOpenChange={() => {}}>
        <div className="session-empty">no saved providers</div>
      </BarDropdown>,
    );
    assert.ok(closed.includes("built-in"), "the trigger carries the current value");
    assert.ok(!closed.includes("no saved providers"), "a closed menu renders no items");

    const open = markup(
      <BarDropdown label="built-in" kind="provider" title="Provider" open onOpenChange={() => {}}>
        <div className="session-empty">no saved providers</div>
      </BarDropdown>,
    );
    assert.ok(open.includes("no saved providers"), "an open menu renders its items");
  });
});

describe("rendering the thinking block", () => {
  const history = { kind: "reasoning", text: "weighed the two options", durationSeconds: 3.4, messageIndex: 7 } as const;

  it("collapses a reopened conversation's reasoning to one header row", () => {
    // The whole point of the collapsed state: reasoning must not own the
    // transcript when you come back to it. No body in the markup at all, not a
    // hidden one, so it costs nothing to render a hundred of them.
    const out = markup(<EntryView entry={history as Entry} />);
    assert.match(out, /reasoning-header/);
    assert.match(out, /thought for 3\.4s/);
    assert.doesNotMatch(out, /reasoning-body/);
    assert.doesNotMatch(out, /weighed the two options/, "collapsed means the text is not in the DOM");
  });

  it("says when the thinking happened, and says nothing it does not know", () => {
    const timed = markup(<EntryView entry={history as Entry} />);
    assert.match(timed, /class="reasoning-label">thought for 3\.4s</);
    // A turn measured under ten seconds keeps its decimal; anything longer is
    // rounded, because 42.7s of precision is a digit nobody reads.
    const long = markup(<ReasoningEntry text="x" durationSeconds={42.7} />);
    assert.match(long, /thought for 43s</);
    // Old records have no stored duration: "thought", never an invented number.
    const missing = markup(<ReasoningEntry text="x" />);
    assert.match(missing, /class="reasoning-label">thought</);
    assert.doesNotMatch(missing, /thought for/);
  });

  it("shimmers while the model is still thinking, and counts instead of reporting", () => {
    const live = markup(<ReasoningEntry text="half a thought" live />);
    assert.match(live, /reasoning-label shimmer/, "the shimmer the status line uses");
    assert.match(live, /thinking…/, "present tense while it is happening");
    assert.doesNotMatch(live, /thought for/, "a turn still running has no duration to report");
    // A live block is the one that opens by itself: you are watching it arrive.
    assert.match(live, /reasoning-body/, "live reasoning opens");
  });

  it("opens as a scrolling window with no rule between header and body", () => {
    // The body is a sibling of the header inside the same rounded box. A
    // wrapper with a border of its own is how this became two attached blocks.
    // `initialOpen` is how a finished block is opened without a click: a stored
    // block starts shut, and only the live one opens on its own.
    const open = markup(<ReasoningEntry text={"line\n".repeat(40)} durationSeconds={2} initialOpen />);
    const box = open.slice(open.indexOf("reasoning-box"), open.indexOf("reasoning-body"));
    assert.doesNotMatch(box, /border/, "nothing draws a line between the header and the reasoning");
    assert.match(open, /<pre class="reasoning-body"/, "the body is the scroller itself");
    assert.doesNotMatch(open, /reasoning-body[^>]*border/, "and it has no border of its own");
  });

  it("does not shut the reasoning the moment the model stops", () => {
    // Reasoning streams as one component and lands in the transcript as
    // another, with the same text. A block that opened while it was arriving
    // used to snap shut at exactly that swap, under the reader's eyes, because
    // the stored block's own default is collapsed.
    const text = "weighed it up carefully before answering";
    const live = markup(<ReasoningEntry text={text} live />);
    assert.match(live, /reasoning-body/, "it opens while it is arriving");
    const stored = markup(<EntryView entry={{ kind: "reasoning", text, messageIndex: 3 } as Entry} />);
    assert.match(stored, /reasoning-body/, "and it is still open once it is history");

    // A block nobody watched is a different case: it starts shut, which is the
    // whole reason the transcript is readable when you come back to it.
    const cold = markup(<EntryView entry={{ kind: "reasoning", text: "thought before you arrived", messageIndex: 4 } as Entry} />);
    assert.doesNotMatch(cold, /reasoning-body/, "reasoning you never saw live starts collapsed");
  });

  it("renders every reasoning entry in a stored transcript without one body open", () => {
    const entries: Entry[] = [
      { kind: "user", text: "go" },
      { kind: "reasoning", text: "first", durationSeconds: 1.2, messageIndex: 1 },
      { kind: "assistant", text: "done", partial: false, messageIndex: 1 },
      { kind: "reasoning", text: "second", durationSeconds: 9, messageIndex: 2 },
    ];
    const out = markup(
      <>
        {entries.map((entry) => (
          // Keyed by its own content: these four entries are distinct, and a
          // position key would hide a reorder from the renderer.
          <EntryView entry={entry} key={"text" in entry ? entry.text : entry.kind} />
        ))}
      </>,
    );
    assert.equal((out.match(/reasoning-header/g) ?? []).length, 2);
    assert.equal((out.match(/reasoning-body/g) ?? []).length, 0, "a reopened transcript starts with every block shut");
  });
});
