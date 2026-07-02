import type { TemplateDelegate } from 'handlebars';
import { compile } from 'handlebars';
import { ExtensionBasedTemplateEngine } from './ExtensionBasedTemplateEngine';
import type { Template, TemplateEngineInput } from './TemplateEngine';
import { getTemplateFilePath, readTemplate } from './TemplateUtil';
import Dict = NodeJS.Dict;

/**
 * Fills in Handlebars templates.
 *
 * Compiled templates are cached forever,
 * keyed on the resolved template file path,
 * or on the template string itself for string-based templates.
 * Since the set of templates is fixed by the server configuration, the cache is bounded.
 * A deliberate trade-off is that editing a template file requires a server restart.
 */
export class HandlebarsTemplateEngine<T extends Dict<unknown> = Dict<unknown>> extends ExtensionBasedTemplateEngine<T> {
  private readonly baseUrl: string;
  private readonly cache: Map<string, TemplateDelegate>;

  /**
   * @param baseUrl - Base URL of the server.
   * @param supportedExtensions - The extensions that are supported by this template engine (defaults to 'hbs').
   */
  public constructor(baseUrl: string, supportedExtensions = [ 'hbs' ]) {
    super(supportedExtensions);
    this.baseUrl = baseUrl;
    this.cache = new Map();
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
    // File-based templates are cached on their resolved file path, string-based templates on their contents
    const key = filePath ?? await readTemplate(template);
    let applyTemplate = this.cache.get(key);
    if (!applyTemplate) {
      // For string-based templates the cache key already contains the template contents
      applyTemplate = compile(filePath ? await readTemplate(template) : key);
      this.cache.set(key, applyTemplate);
    }
    return applyTemplate;
  }
}
