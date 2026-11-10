import { compile } from 'ejs';
import { NotImplementedHttpError } from '../../../../src/util/errors/NotImplementedHttpError';
import { EjsTemplateEngine } from '../../../../src/util/templates/EjsTemplateEngine';
import { readTemplate } from '../../../../src/util/templates/TemplateUtil';

jest.mock('ejs', (): any => ({
  ...jest.requireActual('ejs'),
  compile: jest.fn((template: string, opts?: unknown): unknown => jest.requireActual('ejs').compile(template, opts)),
}));

jest.mock('../../../../src/util/templates/TemplateUtil', (): any => ({
  getTemplateFilePath: jest.fn((template): string | undefined =>
    typeof template === 'string' ? template : undefined),
  readTemplate: jest.fn(async(template): Promise<string> =>
    typeof template === 'object' ? template.templateString : `<%= detail %>`),
}));

describe('A EjsTemplateEngine', (): void => {
  const contents = { detail: 'a&b' };
  let templateEngine: EjsTemplateEngine;

  beforeEach((): void => {
    jest.clearAllMocks();
    templateEngine = new EjsTemplateEngine('http://localhost:3000');
  });

  it('uses the passed template.', async(): Promise<void> => {
    await expect(templateEngine.handleSafe({ contents, template: 'someTemplate.ejs' }))
      .resolves.toBe('a&amp;b');
  });

  it('throws an exception for unsupported template files.', async(): Promise<void> => {
    await expect(templateEngine.handleSafe({ contents, template: 'someTemplate.txt' }))
      .rejects.toThrow(NotImplementedHttpError);
  });

  it('throws an exception if no template was passed.', async(): Promise<void> => {
    await expect(templateEngine.handleSafe({ contents }))
      .rejects.toThrow(NotImplementedHttpError);
  });

  it('only reads and compiles a template once when rendering it multiple times.', async(): Promise<void> => {
    await expect(templateEngine.handleSafe({ contents, template: 'someTemplate.ejs' }))
      .resolves.toBe('a&amp;b');
    await expect(templateEngine.handleSafe({ contents, template: 'someTemplate.ejs' }))
      .resolves.toBe('a&amp;b');
    expect(readTemplate).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenLastCalledWith('<%= detail %>', { filename: 'someTemplate.ejs' });
  });

  it('caches compiled templates separately per template.', async(): Promise<void> => {
    await expect(templateEngine.handleSafe({ contents, template: 'someTemplate.ejs' }))
      .resolves.toBe('a&amp;b');
    await expect(templateEngine.handleSafe({ contents, template: 'otherTemplate.ejs' }))
      .resolves.toBe('a&amp;b');
    expect(readTemplate).toHaveBeenCalledTimes(2);
    expect(compile).toHaveBeenCalledTimes(2);
  });

  it('only compiles a string template once when rendering it multiple times.', async(): Promise<void> => {
    const template = { templateString: '<%= detail %>' };
    await expect(templateEngine.handle({ contents, template })).resolves.toBe('a&amp;b');
    await expect(templateEngine.handle({ contents, template })).resolves.toBe('a&amp;b');
    expect(compile).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenLastCalledWith('<%= detail %>', { filename: undefined });
  });
});
