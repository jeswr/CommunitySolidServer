import type { TemplateDelegate } from 'handlebars';
import { compile } from 'handlebars';
import { PromiseCache } from '../caching/PromiseCache';
import { ExtensionBasedTemplateEngine } from './ExtensionBasedTemplateEngine';
import type { Template, TemplateEngineInput } from './TemplateEngine';
import { getTemplateFilePath, readTemplate } from './TemplateUtil';
import Dict = NodeJS.Dict;

/**
 * Fills in Handlebars templates.
 */
export class HandlebarsTemplateEngine<T extends Dict<unknown> = Dict<unknown>> extends ExtensionBasedTemplateEngine<T> {
  private readonly baseUrl: string;

  /**
   * Compiled templates, keyed on their resolved file path, or on the template string for string templates.
   * The server configuration determines the set of templates, so the cache is bounded,
   * but editing a template file requires a server restart to take effect.
   */
  private readonly cache: PromiseCache<string, TemplateDelegate>;

  /**
   * @param baseUrl - Base URL of the server.
   * @param supportedExtensions - The extensions that are supported by this template engine (defaults to 'hbs').
   */
  public constructor(baseUrl: string, supportedExtensions = [ 'hbs' ]) {
    super(supportedExtensions);
    this.baseUrl = baseUrl;
    this.cache = new PromiseCache();
  }

  public async handle({ contents, template }: TemplateEngineInput<T>): Promise<string> {
    const applyTemplate = await this.getCompiledTemplate(template);
    return applyTemplate({ ...contents, baseUrl: this.baseUrl });
  }

  /**
   * Returns the compiled template, compiling and caching it first if necessary.
   *
   * @param template - Template to compile.
   */
  private async getCompiledTemplate(template?: Template): Promise<TemplateDelegate> {
    const filePath = getTemplateFilePath(template);
    const key = filePath ?? await readTemplate(template);
    return this.cache.getOrCreate(key, async(): Promise<TemplateDelegate> => {
      // For string-based templates the cache key already contains the template contents
      const contents = filePath ? await readTemplate(template) : key;
      return compile(contents);
    });
  }
}
