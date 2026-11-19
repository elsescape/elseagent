import { truncate } from "../../util/text.ts";

/**
 * Telegram counts at most 4,096 characters per message after formatting; split the Markdown
 * well below that, since list bullets and links change the length a little.
 */
export const TELEGRAM_MARKDOWN_LIMIT = 3_500;

const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const escapeAttr = (text: string) => escapeHtml(text).replaceAll('"', "&quot;");
const stripTags = (html: string) => html.replace(/<[^>]+>/g, "");

/** Telegram user IDs to display names, for `<@123>` mentions. */
export type NameLookup = (userId: string) => string | undefined;

/**
 * Convert Markdown (as Codex writes it) to the HTML subset Telegram accepts: bold, italic,
 * strikethrough, code, pre, links and blockquotes. Headings become bold lines, lists get
 * bullets, tables become preformatted text. `<@123>` mentions become links to the user.
 */
export function toTelegramHtml(markdown: string, nameOf: NameLookup = () => undefined): string {
  const block = (html: string) => `${html.trim()}\n\n`;
  const html = Bun.markdown.render(markdown, {
    text: (text) =>
      escapeHtml(text).replace(
        /&lt;@(\d+)&gt;/g,
        (_, id: string) => `<a href="tg://user?id=${id}">${escapeHtml(nameOf(id) ?? id)}</a>`,
      ),
    heading: (children) => block(`<b>${children}</b>`),
    paragraph: block,
    blockquote: (children) => block(`<blockquote>${children.trim()}</blockquote>`),
    code: (children, meta) =>
      block(
        meta?.language
          ? `<pre><code class="language-${escapeAttr(meta.language)}">${children.replace(/\n$/, "")}</code></pre>`
          : `<pre>${children.replace(/\n$/, "")}</pre>`,
      ),
    list: (children, { depth }) => (depth === 0 ? block(children) : `\n${children.trimEnd()}`),
    listItem: (children, { index, depth, ordered, start, checked }) => {
      const bullet = ordered ? `${(start ?? 1) + index}.` : "•";
      const box = checked === undefined ? "" : checked ? "☑ " : "☐ ";
      const content = children.trim().replace(/\n{2,}/g, "\n");
      return `${"   ".repeat(depth)}${bullet} ${box}${content}\n`;
    },
    hr: () => "———\n\n",
    // Telegram has no tables: show them as aligned-ish plain text.
    table: (children) => block(`<pre>${stripTags(children).trimEnd()}</pre>`),
    tr: (children) => `${children.replace(/ \| $/, "")}\n`,
    th: (children) => `${children} | `,
    td: (children) => `${children} | `,
    strong: (children) => `<b>${children}</b>`,
    emphasis: (children) => `<i>${children}</i>`,
    strikethrough: (children) => `<s>${children}</s>`,
    codespan: (children) => `<code>${stripTags(children)}</code>`,
    link: (children, { href }) => `<a href="${escapeAttr(href)}">${children}</a>`,
    image: (children, { src }) => `<a href="${escapeAttr(src)}">${children || "image"}</a>`,
    html: (children) => children,
  });
  return html.replace(/\n{3,}/g, "\n\n").trim();
}

/** Plain text for a short label (a topic name): Markdown markup removed, one line. */
export function plainLine(markdown: string, max: number): string {
  const text = stripTags(toTelegramHtml(markdown.split("\n").find((l) => l.trim()) ?? ""))
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ")
    .trim();
  return truncate(text, max);
}
