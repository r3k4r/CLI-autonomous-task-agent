import type { LineStyle, Task, TaskStatus } from './types.js';

/**
 * The forgiving note parser. Line-based on purpose — no markdown AST library.
 *
 * The whole point of this project is that you open a text file and write what
 * you want done. A file of plain sentences with no markers and no tags must
 * work perfectly; tags are a power feature, never a requirement.
 */

const DEFAULT_MAX_ATTEMPTS = 2;

/** Lines shorter than this after marker stripping are noise, not tasks. */
const MIN_TITLE_LENGTH = 3;

const CHECKBOX_RE = /^[-*+]\s+\[([ xX])\]\s*(.*)$/;
const BULLET_RE = /^[-*+]\s+(.*)$/;
const NUMBERED_RE = /^\d+[.)]\s+(.*)$/;
const TODO_RE = /^TODO:\s*(.*)$/i;
const FENCE_RE = /^\s*(```|~~~)/;
const INDENTED_RE = /^(?:\s{2,}|\t)/;

/** A tag is `#word` or `#word:value`; the value may contain commas and dots. */
const TAG_RE = /#([a-z]+)(?::([^\s#]+))?/gi;

interface ParsedTags {
  id?: string;
  needs: string[];
  model?: string;
  skip: boolean;
  done: boolean;
}

/**
 * Detect how a task line is written, so completion can be written back in the
 * file's own style. Anything unrecognised is 'plain'.
 */
export function detectStyle(line: string): LineStyle {
  const body = line.trimStart();
  if (CHECKBOX_RE.test(body)) return 'checkbox';
  if (TODO_RE.test(body)) return 'todo';
  if (BULLET_RE.test(body)) return 'bullet';
  if (NUMBERED_RE.test(body)) return 'numbered';
  return 'plain';
}

/**
 * Strip the list marker from a line, returning the bare text and, for
 * checkboxes, whether it was already ticked.
 */
function stripMarker(body: string): { text: string; checked: boolean } {
  const checkbox = CHECKBOX_RE.exec(body);
  if (checkbox) {
    const mark = checkbox[1] ?? ' ';
    return { text: checkbox[2] ?? '', checked: mark.toLowerCase() === 'x' };
  }
  const todo = TODO_RE.exec(body);
  if (todo) return { text: todo[1] ?? '', checked: false };

  const bullet = BULLET_RE.exec(body);
  if (bullet) return { text: bullet[1] ?? '', checked: false };

  const numbered = NUMBERED_RE.exec(body);
  if (numbered) return { text: numbered[1] ?? '', checked: false };

  return { text: body, checked: false };
}

/**
 * Pull tags out of a task line. Tags may appear anywhere, including mid
 * sentence, and are removed from the title.
 */
function extractTags(text: string): { title: string; tags: ParsedTags } {
  const tags: ParsedTags = { needs: [], skip: false, done: false };

  const title = text
    .replace(TAG_RE, (match, rawName: string, rawValue: string | undefined) => {
      const name = rawName.toLowerCase();
      switch (name) {
        case 'id':
          if (rawValue) tags.id = rawValue;
          return '';
        case 'needs':
          if (rawValue) {
            // `#needs:a,b` and two separate `#needs:` tags both accumulate.
            for (const dep of rawValue.split(',')) {
              const trimmed = dep.trim();
              if (trimmed && !tags.needs.includes(trimmed)) tags.needs.push(trimmed);
            }
          }
          return '';
        case 'model':
          if (rawValue) tags.model = rawValue;
          return '';
        case 'skip':
          tags.skip = true;
          return '';
        case 'done':
          tags.done = true;
          return '';
        default:
          // NOTE: unknown `#word` is ordinary prose (a C# reference, a colour
          // like #fff). Leave it in the title untouched.
          return match;
      }
    })
    // Collapse the whitespace a removed tag leaves behind, without touching
    // the words themselves.
    .replace(/\s{2,}/g, ' ')
    .trim();

  return { title, tags };
}

/** Turn a title into a url-ish id. */
function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'task';
}

/**
 * Split content into lines while remembering nothing about line endings — the
 * caller reassembles from the original string, so write-back stays byte exact.
 */
function splitLines(content: string): string[] {
  return content.split('\n');
}

/**
 * Parse a free-form note file into tasks.
 *
 * Ignored: blank lines, `#` headings, `//` comments, fenced code blocks, and
 * anything under three characters once markers are stripped.
 */
export function parseNotes(content: string): Task[] {
  const lines = splitLines(content);
  const tasks: Task[] = [];
  const usedIds = new Set<string>();

  let inFence = false;

  for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
    const raw = (lines[lineNumber] ?? '').replace(/\r$/, '');

    if (FENCE_RE.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (raw.trim() === '') continue;

    // An indented line belongs to the task above it as context. With no task
    // above it there is nothing to attach to, so fall through and let it be
    // parsed as a task in its own right — a whole file written at an indent
    // must still work.
    if (INDENTED_RE.test(raw) && tasks.length > 0) {
      tasks[tasks.length - 1]!.details.push(raw.trim());
      continue;
    }

    const body = raw.trim();

    // `#` is a heading and `//` is a comment. A task line never starts with
    // either — a leading `#tag` would be a tag with no title anyway.
    if (body.startsWith('#') || body.startsWith('//')) continue;

    const { text, checked } = stripMarker(body);
    const { title, tags } = extractTags(text);

    if (title.length < MIN_TITLE_LENGTH) continue;

    let id = tags.id ?? slugify(title);
    if (usedIds.has(id)) {
      // Duplicate slugs get numeric suffixes so ids stay unique and stable.
      let suffix = 2;
      while (usedIds.has(`${id}-${suffix}`)) suffix++;
      id = `${id}-${suffix}`;
    }
    usedIds.add(id);

    const status: TaskStatus = tags.skip ? 'skipped' : checked || tags.done ? 'done' : 'pending';

    const task: Task = {
      id,
      title,
      details: [],
      status,
      dependsOn: tags.needs,
      attempts: 0,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      lineNumber,
      lineStyle: detectStyle(body),
    };
    if (tags.model !== undefined) task.model = tags.model;

    tasks.push(task);
  }

  return tasks;
}

/**
 * Mark one line complete, in the file's own style.
 *
 * `- [ ] Foo` becomes `- [x] Foo`; every other style gets ` #done` appended.
 * Only the single named line may change — every other byte of the file,
 * including blank lines, indentation, comments and line endings, is preserved.
 */
export function markComplete(content: string, lineNumber: number, style: LineStyle): string {
  const lines = splitLines(content);
  const original = lines[lineNumber];
  if (original === undefined) return content;

  // Preserve a CRLF ending on this line by operating only on the content part.
  const hasCr = original.endsWith('\r');
  const line = hasCr ? original.slice(0, -1) : original;

  let updated: string;
  if (style === 'checkbox') {
    updated = line.replace(/\[[ xX]\]/, '[x]');
  } else if (/(^|\s)#done(\s|$)/.test(line)) {
    // Already marked; leave it exactly as it is.
    updated = line;
  } else {
    // Append after the text but before any trailing whitespace, so a file that
    // uses trailing spaces keeps them.
    const trailing = /\s*$/.exec(line)?.[0] ?? '';
    const withoutTrailing = trailing ? line.slice(0, -trailing.length) : line;
    updated = `${withoutTrailing} #done${trailing}`;
  }

  lines[lineNumber] = hasCr ? `${updated}\r` : updated;
  return lines.join('\n');
}

/**
 * Work out the dominant style of a file so appended tasks look like the ones
 * already there.
 */
function dominantStyle(content: string): LineStyle {
  const counts = new Map<LineStyle, number>();
  let inFence = false;

  for (const rawLine of splitLines(content)) {
    const raw = rawLine.replace(/\r$/, '');
    if (FENCE_RE.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const body = raw.trim();
    if (body === '' || body.startsWith('#') || body.startsWith('//')) continue;
    if (INDENTED_RE.test(raw)) continue;

    const style = detectStyle(body);
    counts.set(style, (counts.get(style) ?? 0) + 1);
  }

  let best: LineStyle = 'plain';
  let bestCount = 0;
  for (const [style, count] of counts) {
    if (count > bestCount) {
      best = style;
      bestCount = count;
    }
  }
  return best;
}

/** Render a title in a given style, ready to append. */
function renderTask(title: string, style: LineStyle, nextNumber: number): string {
  switch (style) {
    case 'checkbox':
      return `- [ ] ${title}`;
    case 'bullet':
      return `- ${title}`;
    case 'numbered':
      return `${nextNumber}. ${title}`;
    case 'todo':
      return `TODO: ${title}`;
    case 'plain':
      return title;
  }
}

/**
 * Append a task in the file's dominant style, preserving the file's existing
 * line ending convention and its lack of a trailing newline.
 */
export function addTask(content: string, title: string): string {
  const style = dominantStyle(content);

  // Match the file's dominant line ending rather than imposing one.
  const crlfCount = (content.match(/\r\n/g) ?? []).length;
  const lfCount = (content.match(/\n/g) ?? []).length;
  const eol = crlfCount > 0 && crlfCount >= lfCount - crlfCount ? '\r\n' : '\n';

  const nextNumber =
    style === 'numbered'
      ? parseNotes(content).filter((t) => t.lineStyle === 'numbered').length + 1
      : 1;
  const rendered = renderTask(title, style, nextNumber);

  if (content === '') return `${rendered}${eol}`;

  const endsWithNewline = content.endsWith('\n');
  if (endsWithNewline) return `${content}${rendered}${eol}`;

  // No trailing newline: add one to separate, but don't gain a trailing one.
  return `${content}${eol}${rendered}`;
}
