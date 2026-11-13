/* eslint-disable react/no-array-index-key -- A parsed markdown document has no stable identity for its blocks or inline runs: they are produced fresh from the answer text on every render, and the list is append-only within a render, so the index is the identity. */
import { Fragment, type ReactNode } from "react";
import { parseInline, parseMarkdown, type Block, type Inline } from "../markdown";

/**
 * Markdown, rendered.
 *
 * The block structure comes from the pure parser, so what is on screen matches
 * what the tests pin: fences stay fenced (including a fence that is still
 * streaming and has no closing marker yet), tables stay tabular, and lists stay
 * lists. This file only maps blocks to elements — it decides nothing about
 * meaning, which is where the bugs live.
 */

function inline(runs: Inline[], keyPrefix: string): ReactNode[] {
  return runs.map((run, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (run.type) {
      case "code":
        return (
          <code className="md-code" key={key}>
            {run.text}
          </code>
        );
      case "strong":
        return <strong key={key}>{run.text}</strong>;
      case "em":
        return <em key={key}>{run.text}</em>;
      case "link":
        return (
          <span className="md-link" key={key} title={run.href}>
            {run.text}
          </span>
        );
      default:
        return <Fragment key={key}>{run.text}</Fragment>;
    }
  });
}

function prose(text: string, keyPrefix: string): ReactNode {
  // A hard single newline inside a paragraph is a soft wrap in markdown, but a
  // model writing a shell transcript means the lines as written; the parser
  // keeps them and this renders them as written.
  const lines = text.split("\n");
  return lines.map((line, index) => (
    <Fragment key={`${keyPrefix}-line-${index}`}>
      {index > 0 ? <br /> : null}
      {inline(parseInline(line), `${keyPrefix}-${index}`)}
    </Fragment>
  ));
}

function BlockView({ block, index }: { block: Block; index: number }): ReactNode {
  const key = `b${index}`;
  switch (block.type) {
    case "heading": {
      const Tag = (`h${Math.min(6, Math.max(1, block.level))}` as unknown) as "h3";
      return (
        <Tag className="md-heading" key={key}>
          {inline(parseInline(block.text), key)}
        </Tag>
      );
    }
    case "code":
      return (
        <div className={`md-fence ${block.closed ? "" : "streaming"}`} key={key}>
          {block.lang ? <div className="md-fence-lang">{block.lang}</div> : null}
          <pre className="md-fence-body">
            <code>{block.text}</code>
          </pre>
          {block.closed ? null : (
            // Saying so is the point: an unterminated fence is what most of a
            // streaming answer looks like, and a reader who sees this knows the
            // block is still arriving rather than malformed.
            <div className="md-fence-note">streaming…</div>
          )}
        </div>
      );
    case "list":
      return block.ordered ? (
        <ol className="md-list" key={key}>
          {block.items.map((item, itemIndex) => (
            <li key={`${key}-${itemIndex}`}>{inline(parseInline(item), `${key}-${itemIndex}`)}</li>
          ))}
        </ol>
      ) : (
        <ul className="md-list" key={key}>
          {block.items.map((item, itemIndex) => (
            <li key={`${key}-${itemIndex}`}>{inline(parseInline(item), `${key}-${itemIndex}`)}</li>
          ))}
        </ul>
      );
    case "quote":
      return (
        <blockquote className="md-quote" key={key}>
          {prose(block.text, key)}
        </blockquote>
      );
    case "table":
      return (
        <div className="md-table-wrap" key={key}>
          <table className="md-table">
            <thead>
              <tr>
                {block.header.map((cell, cellIndex) => (
                  <th key={`${key}-h-${cellIndex}`}>{inline(parseInline(cell), `${key}-h-${cellIndex}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={`${key}-r-${rowIndex}`}>
                  {row.map((cell, cellIndex) => (
                    <td key={`${key}-r-${rowIndex}-${cellIndex}`}>{inline(parseInline(cell), `${key}-r-${rowIndex}-${cellIndex}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "rule":
      return <hr className="md-rule" key={key} />;
    default:
      return (
        <p className="md-para" key={key}>
          {prose(block.text, key)}
        </p>
      );
  }
}

export function Markdown({ text }: { text: string }) {
  const blocks = parseMarkdown(text);
  return (
    <div className="md">
      {blocks.map((block, index) => (
        <BlockView block={block} index={index} key={index} />
      ))}
    </div>
  );
}
