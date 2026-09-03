import { describe, expect, it } from 'vitest';
import { addTask, detectStyle, markComplete, parseNotes } from '../../src/core/parser.js';

describe('parseNotes — line styles', () => {
  it('parses each of the seven styles to one task with a clean title', () => {
    const cases: Array<[string, string]> = [
      ['Create a login page', 'plain'],
      ['- Create a login page', 'bullet'],
      ['* Create a login page', 'bullet'],
      ['+ Create a login page', 'bullet'],
      ['1. Create a login page', 'numbered'],
      ['- [ ] Create a login page', 'checkbox'],
      ['TODO: Create a login page', 'todo'],
    ];

    for (const [line, style] of cases) {
      const tasks = parseNotes(line);
      expect(tasks, line).toHaveLength(1);
      expect(tasks[0]?.title, line).toBe('Create a login page');
      expect(tasks[0]?.lineStyle, line).toBe(style);
    }
  });

  it('parses a file of nothing but plain sentences', () => {
    const content = ['Create a login page', 'Fix the auth bug', 'Add a settings screen'].join('\n');
    const tasks = parseNotes(content);
    expect(tasks.map((t) => t.title)).toEqual([
      'Create a login page',
      'Fix the auth bug',
      'Add a settings screen',
    ]);
    expect(tasks.every((t) => t.status === 'pending')).toBe(true);
    expect(tasks.every((t) => t.dependsOn.length === 0)).toBe(true);
  });

  it('trims leading and trailing whitespace from titles', () => {
    expect(parseNotes('   Create a login page   ')[0]?.title).toBe('Create a login page');
  });

  it('records the 0-indexed line number of each task', () => {
    const tasks = parseNotes('# Heading\n\nFirst task\n\nSecond task');
    expect(tasks.map((t) => t.lineNumber)).toEqual([2, 4]);
  });
});

describe('parseNotes — details', () => {
  it('attaches indented lines to the task above as details', () => {
    const content = [
      'Create a login page',
      '  use the existing Button component from src/ui',
      '  redirect to /dashboard on success',
      '',
      'Fix the auth bug',
      '\tthe session token is not refreshing',
    ].join('\n');

    const tasks = parseNotes(content);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.details).toEqual([
      'use the existing Button component from src/ui',
      'redirect to /dashboard on success',
    ]);
    expect(tasks[1]?.details).toEqual(['the session token is not refreshing']);
  });

  it('never turns an indented line into a task', () => {
    const tasks = parseNotes('Create a login page\n  - this looks like a bullet but is a detail');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.details).toEqual(['- this looks like a bullet but is a detail']);
  });

  it('does not crash on an indented line with no task above it', () => {
    // There is no task to attach it to, so it stands on its own rather than
    // being silently dropped — a whole file written at an indent still works.
    expect(() => parseNotes('  orphaned detail line\nA real task')).not.toThrow();
    const tasks = parseNotes('  orphaned detail line\nA real task');
    expect(tasks.map((t) => t.title)).toEqual(['orphaned detail line', 'A real task']);
  });

  it('attaches details to the task above even when the file starts indented', () => {
    const tasks = parseNotes('  first task at an indent\n  its own detail\nSecond task');
    expect(tasks.map((t) => t.title)).toEqual(['first task at an indent', 'Second task']);
    expect(tasks[0]?.details).toEqual(['its own detail']);
  });
});

describe('parseNotes — ignored lines', () => {
  it('ignores headings, comments and blank lines', () => {
    const content = [
      '# Sprint plan',
      '## Later',
      '',
      '// this is a comment',
      'Create a login page',
      '',
    ].join('\n');
    const tasks = parseNotes(content);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe('Create a login page');
  });

  it('does not parse task-looking lines inside a fenced code block', () => {
    const content = [
      'Real task one',
      '',
      '```bash',
      '- not a task',
      'TODO: also not a task',
      '```',
      '',
      'Real task two',
    ].join('\n');
    const tasks = parseNotes(content);
    expect(tasks.map((t) => t.title)).toEqual(['Real task one', 'Real task two']);
  });

  it('handles tilde fences too', () => {
    const tasks = parseNotes('Real task\n~~~\n- not a task\n~~~');
    expect(tasks.map((t) => t.title)).toEqual(['Real task']);
  });

  it('ignores lines under three characters after stripping markers', () => {
    const tasks = parseNotes('- ok\n- A real task here');
    expect(tasks.map((t) => t.title)).toEqual(['A real task here']);
  });
});

describe('parseNotes — tags', () => {
  it('extracts an explicit id and strips it from the title', () => {
    const task = parseNotes('Create a login page #id:login')[0];
    expect(task?.id).toBe('login');
    expect(task?.title).toBe('Create a login page');
  });

  it('slugifies the title when no id is given', () => {
    expect(parseNotes('Create a Login Page!')[0]?.id).toBe('create-a-login-page');
  });

  it('handles a tag in the middle of a sentence', () => {
    const task = parseNotes('Create a #model:opus login page for the app')[0];
    expect(task?.model).toBe('opus');
    expect(task?.title).toBe('Create a login page for the app');
  });

  it('parses #needs:a,b as two dependencies', () => {
    expect(parseNotes('Deploy the app #needs:build,test')[0]?.dependsOn).toEqual(['build', 'test']);
  });

  it('parses two separate #needs tags as two dependencies', () => {
    expect(parseNotes('Deploy the app #needs:build #needs:test')[0]?.dependsOn).toEqual([
      'build',
      'test',
    ]);
  });

  it('treats #skip as skipped and #done as done', () => {
    expect(parseNotes('Create a login page #skip')[0]?.status).toBe('skipped');
    expect(parseNotes('Create a login page #done')[0]?.status).toBe('done');
  });

  it('treats a ticked checkbox as done', () => {
    expect(parseNotes('- [x] Create a login page')[0]?.status).toBe('done');
    expect(parseNotes('- [X] Create a login page')[0]?.status).toBe('done');
    expect(parseNotes('- [ ] Create a login page')[0]?.status).toBe('pending');
  });

  it('leaves unknown # words in the title', () => {
    const task = parseNotes('Fix the #fff colour token in the theme')[0];
    expect(task?.title).toBe('Fix the #fff colour token in the theme');
  });

  it('gives duplicate slugified ids unique numeric suffixes', () => {
    const tasks = parseNotes(
      ['Create a login page', 'Create a login page', 'Create a login page'].join('\n'),
    );
    expect(tasks.map((t) => t.id)).toEqual([
      'create-a-login-page',
      'create-a-login-page-2',
      'create-a-login-page-3',
    ]);
  });
});

describe('detectStyle', () => {
  it('identifies each style', () => {
    expect(detectStyle('- [ ] Foo')).toBe('checkbox');
    expect(detectStyle('- [x] Foo')).toBe('checkbox');
    expect(detectStyle('- Foo')).toBe('bullet');
    expect(detectStyle('* Foo')).toBe('bullet');
    expect(detectStyle('+ Foo')).toBe('bullet');
    expect(detectStyle('1. Foo')).toBe('numbered');
    expect(detectStyle('TODO: Foo')).toBe('todo');
    expect(detectStyle('Foo')).toBe('plain');
  });
});

describe('markComplete — byte preservation', () => {
  it('turns - [ ] into - [x] and leaves every other line byte-identical', () => {
    const content = [
      '# Heading',
      '',
      '- [ ] First task',
      '- [ ] Second task',
      '    indented detail',
      '',
      '// a comment',
    ].join('\n');

    const updated = markComplete(content, 2, 'checkbox');
    const before = content.split('\n');
    const after = updated.split('\n');

    expect(after[2]).toBe('- [x] First task');
    for (const i of [0, 1, 3, 4, 5, 6]) {
      expect(after[i], `line ${i}`).toBe(before[i]);
    }
  });

  it('appends #done to a plain line and leaves every other line byte-identical', () => {
    const content = ['Create a login page', 'Fix the auth bug'].join('\n');
    const updated = markComplete(content, 0, 'plain');
    expect(updated.split('\n')).toEqual(['Create a login page #done', 'Fix the auth bug']);
  });

  it('appends #done for bullet, numbered and todo styles', () => {
    expect(markComplete('- Foo bar', 0, 'bullet')).toBe('- Foo bar #done');
    expect(markComplete('1. Foo bar', 0, 'numbered')).toBe('1. Foo bar #done');
    expect(markComplete('TODO: Foo bar', 0, 'todo')).toBe('TODO: Foo bar #done');
  });

  it('keeps CRLF files CRLF', () => {
    const content = '- [ ] First task\r\n- [ ] Second task\r\n';
    const updated = markComplete(content, 0, 'checkbox');
    expect(updated).toBe('- [x] First task\r\n- [ ] Second task\r\n');
    expect(updated.split('\r\n')).toHaveLength(3);
  });

  it('appends #done on a CRLF line without eating the carriage return', () => {
    const content = 'Create a login page\r\nFix the auth bug\r\n';
    expect(markComplete(content, 0, 'plain')).toBe(
      'Create a login page #done\r\nFix the auth bug\r\n',
    );
  });

  it('does not add a trailing newline to a file that lacks one', () => {
    const content = 'Create a login page';
    expect(markComplete(content, 0, 'plain')).toBe('Create a login page #done');
    expect(markComplete(content, 0, 'plain').endsWith('\n')).toBe(false);
  });

  it('preserves a trailing newline when the file has one', () => {
    expect(markComplete('Create a login page\n', 0, 'plain')).toBe('Create a login page #done\n');
  });

  it('is idempotent — marking twice does not duplicate the tag', () => {
    const once = markComplete('Create a login page', 0, 'plain');
    expect(markComplete(once, 0, 'plain')).toBe(once);

    const boxOnce = markComplete('- [ ] Foo bar', 0, 'checkbox');
    expect(markComplete(boxOnce, 0, 'checkbox')).toBe(boxOnce);
  });

  it('returns the content unchanged for an out-of-range line', () => {
    const content = 'Create a login page\n';
    expect(markComplete(content, 99, 'plain')).toBe(content);
  });

  it('preserves the exact byte length of unrelated content', () => {
    const content = '# Notes\n\n\n- [ ] Task one\n\n\n  detail with trailing spaces   \n\n';
    const updated = markComplete(content, 3, 'checkbox');
    expect(updated.length).toBe(content.length);
    expect(updated.replace('[x]', '[ ]')).toBe(content);
  });
});

describe('markComplete — round trip', () => {
  it('parse -> markComplete -> parse yields done for a checkbox', () => {
    const content = '- [ ] Create a login page\n- [ ] Fix the auth bug\n';
    const first = parseNotes(content)[0];
    expect(first?.status).toBe('pending');

    const updated = markComplete(content, first!.lineNumber, first!.lineStyle);
    const reparsed = parseNotes(updated);
    expect(reparsed[0]?.status).toBe('done');
    expect(reparsed[1]?.status).toBe('pending');
    expect(reparsed[0]?.title).toBe('Create a login page');
  });

  it('parse -> markComplete -> parse yields done for a plain line', () => {
    const content = 'Create a login page\nFix the auth bug\n';
    const first = parseNotes(content)[0];

    const updated = markComplete(content, first!.lineNumber, first!.lineStyle);
    const reparsed = parseNotes(updated);
    expect(reparsed[0]?.status).toBe('done');
    // The #done tag must not leak into the title.
    expect(reparsed[0]?.title).toBe('Create a login page');
    expect(reparsed[0]?.id).toBe('create-a-login-page');
  });

  it('keeps ids stable across a completion round trip', () => {
    const content = 'Create a login page\nDeploy it #needs:create-a-login-page\n';
    const before = parseNotes(content);
    const updated = markComplete(content, 0, 'plain');
    const after = parseNotes(updated);

    expect(after.map((t) => t.id)).toEqual(before.map((t) => t.id));
    expect(after[1]?.dependsOn).toEqual(['create-a-login-page']);
  });
});

describe('addTask', () => {
  it('appends to an empty file', () => {
    expect(addTask('', 'Create a login page')).toBe('Create a login page\n');
  });

  it('appends in bullet style when the file is bullets', () => {
    const content = '- First task\n- Second task\n';
    expect(addTask(content, 'Third task')).toBe('- First task\n- Second task\n- Third task\n');
  });

  it('appends in checkbox style when the file is checkboxes', () => {
    const content = '- [ ] First task\n- [x] Second task\n';
    expect(addTask(content, 'Third task')).toBe(
      '- [ ] First task\n- [x] Second task\n- [ ] Third task\n',
    );
  });

  it('appends in plain style when the file is plain text', () => {
    const content = 'First task\nSecond task\n';
    expect(addTask(content, 'Third task')).toBe('First task\nSecond task\nThird task\n');
  });

  it('continues the numbering in a numbered file', () => {
    const content = '1. First task\n2. Second task\n';
    expect(addTask(content, 'Third task')).toBe('1. First task\n2. Second task\n3. Third task\n');
  });

  it('appends in todo style when the file is TODO lines', () => {
    expect(addTask('TODO: First task\n', 'Second task')).toBe(
      'TODO: First task\nTODO: Second task\n',
    );
  });

  it('does not give a file without a trailing newline one', () => {
    const result = addTask('- First task', 'Second task');
    expect(result).toBe('- First task\n- Second task');
    expect(result.endsWith('\n')).toBe(false);
  });

  it('keeps CRLF files CRLF', () => {
    expect(addTask('- First task\r\n', 'Second task')).toBe('- First task\r\n- Second task\r\n');
  });

  it('ignores fenced code blocks when detecting the dominant style', () => {
    const content = ['First task', '', '```', '- not a task', '- also not', '```', ''].join('\n');
    // The only real task is plain, so the fence's bullets must not win.
    expect(addTask(content, 'Second task')).toBe(`${content}Second task\n`);
  });

  it('produces a file whose new task parses back out', () => {
    const content = '- [ ] First task\n';
    const updated = addTask(content, 'Second task');
    const tasks = parseNotes(updated);
    expect(tasks.map((t) => t.title)).toEqual(['First task', 'Second task']);
    expect(tasks[1]?.status).toBe('pending');
  });
});
