import assert from "node:assert/strict";
import { test } from "node:test";
import { Writable } from "node:stream";
import { render } from "ink";
import { ProviderMenu } from "./ProviderMenu.js";
import { AddProvider } from "./AddProvider.js";
import { SlashPopup } from "./SlashPopup.js";
import type { NamedProvider } from "../config.js";

/**
 * A one-frame render of the provider UI, to a captured stream rather than the
 * terminal.
 *
 * The navigation is tested purely in `ProviderMenu.test.ts`; what this pins is
 * the weaker but load-bearing claim that the components *mount and draw* — that
 * the props App passes produce a frame with the rows and the hint, and that
 * nothing in the render throws. Ink's `debug` mode writes a single static frame,
 * so there is no incremental repaint to wait on and no stdin to fake.
 *
 * The stream is a local object, never `process.stdout`: patching the runner's
 * own stdout turns the whole test file into megabytes of mojibake.
 *
 * Known noise, verified and left alone: React's *development* reconciler prints
 * a "two children with the same key" warning during the passive-effect mount of
 * these frames under `node:test`. It has no component stack, it does not appear
 * when the same components are rendered directly (`node --import tsx`) or in the
 * running app, it does not appear for a trivial Ink tree under `node:test`, and
 * it is absent from the production reconciler. It is a harness artifact, not a
 * defect here — recorded so the next person does not spend an afternoon on it.
 */

function captureFrame(ui: React.ReactElement): string {
  let out = "";
  // A real Writable so Ink's `stdout.on(...)` resize hookup works; its `write`
  // captures the frame instead of sending it anywhere. `columns`/`rows` are set
  // because Ink reads them off the stream to lay the frame out.
  const sink = new Writable({
    write(chunk, _enc, cb) {
      out += chunk.toString();
      cb();
    },
  });
  Object.assign(sink, { columns: 80, rows: 24 });
  const instance = render(ui, { stdout: sink as unknown as NodeJS.WriteStream, debug: true });
  instance.unmount();
  // Strip ANSI so the assertions are about content, not colour codes.
  // eslint-disable-next-line no-control-regex -- ESC (\u001b) is the point of the pattern.
  return out.replace(/\u001b\[[0-9;]*m/g, "");
}

const providers: NamedProvider[] = [
  { name: "a.example.com", baseUrl: "https://a.example.com/v1", model: "m-a" },
  { name: "b.example.com", baseUrl: "https://b.example.com/v1" },
];

test("the provider menu draws its rows, the active marker and the hint", () => {
  const frame = captureFrame(
    <ProviderMenu
      providers={providers}
      activeName="a.example.com"
      onActivate={() => {}}
      onAdd={() => {}}
      onRemove={() => {}}
      onCancel={() => {}}
    />,
  );
  assert.match(frame, /providers/, "the heading");
  assert.match(frame, /a\.example\.com/, "a registered provider");
  assert.match(frame, /b\.example\.com/, "and the other one");
  assert.match(frame, /add new provider/, "the add action");
  assert.match(frame, /enter select/, "the key hint");
  assert.doesNotMatch(frame, /built-in endpoint/, "BYOK: no built-in row");
});

test("an empty provider menu says there is nothing yet, and how to fix it", () => {
  const frame = captureFrame(
    <ProviderMenu providers={[]} activeName={undefined} onActivate={() => {}} onAdd={() => {}} onRemove={() => {}} onCancel={() => {}} />,
  );
  assert.match(frame, /none yet/, "first run says there is no provider");
  assert.match(frame, /add one to start/, "and points at the one action that fixes it");
  assert.match(frame, /add new provider/, "the add row is still there");
});

test("first-run onboarding frames the kind picker as a welcome", () => {
  const welcome = captureFrame(<AddProvider onboarding onDone={() => {}} onCancel={() => {}} />);
  assert.match(welcome, /welcome to actor0/, "a welcome, not a bare menu");
  assert.match(welcome, /bring your own provider/, "and what to do");
  assert.doesNotMatch(welcome, /add a provider/, "the management framing is not shown on first run");

  const manage = captureFrame(<AddProvider onDone={() => {}} onCancel={() => {}} />);
  assert.match(manage, /add a provider/, "/provider → add keeps the management framing");
});

test("the slash popup lists commands with descriptions and a highlight", () => {
  const commands = [
    { name: "provider", aliases: ["p"], description: "manage providers" },
    { name: "setup", aliases: ["s"], description: "re-run the setup wizard" },
  ];
  const frame = captureFrame(<SlashPopup commands={commands} selected={1} />);
  assert.match(frame, /\/provider/, "the command");
  assert.match(frame, /manage providers/, "its description");
  assert.match(frame, /\/p\b/, "the alias, so it is learned");
  assert.match(frame, /\/setup/, "and the next");
  // The highlight marker sits on the selected row.
  const setupLine = frame.split("\n").find((line) => line.includes("/setup"))!;
  assert.match(setupLine, /❯/, "the selected row carries the cursor");
});

test("an empty slash popup renders nothing", () => {
  assert.equal(captureFrame(<SlashPopup commands={[]} selected={0} />), "");
});

test("the add-provider flow opens on the kind picker", () => {
  const frame = captureFrame(<AddProvider onDone={() => {}} onCancel={() => {}} />);
  assert.match(frame, /add a provider/, "the heading");
  assert.match(frame, /Claude \(Anthropic\)/, "Claude is offered");
  assert.match(frame, /oauth or api-key/, "its auth options");
  assert.match(frame, /ChatGPT \(OpenAI\)/, "ChatGPT is offered now that its transport ships");
});
