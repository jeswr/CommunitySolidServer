import type { TemplateFunction } from 'ejs';
import { compile } from 'ejs';
import { ExtensionBasedTemplateEngine } from './ExtensionBasedTemplateEngine';
import type { Template, TemplateEngineInput } from './TemplateEngine';
import { getTemplateFilePath, readTemplate } from './TemplateUtil';
import Dict = NodeJS.Dict;

/**
 * Fills in EJS templates.
 *
 * Compiled templates are cached forever,
 * keyed on the resolved template file path,
 * or on the template string itself for string-based templates.
 * Since the set of templates is fixed by the server configuration, the cache is bounded.
 * A deliberate trade-off is that editing a template file requires a server restart.
 */
export class EjsTemplateEngine<T extends Dict<unknown> = Dict<unknown>> extends ExtensionBasedTemplateEngine<T> {
  private readonly baseUrl: string;
  private readonly cache: Map<string, TemplateFunction>;

  /**
   * @param baseUrl - Base URL of the server.
   * @param supportedExtensions - The extensions that are supported by this template engine (defaults to 'ejs').
   */
  public constructor(baseUrl: string, supportedExtensions = [ 'ejs' ]) {
    super(supportedExtensions);
    this.baseUrl = baseUrl;
    this.cache = new Map();
  }

  public async handle({ contents, template }: TemplateEngineInput<T>): Promise<string> {
    const filename = getTemplateFilePath(template);
    const applyTemplate = await this.getCompiledTemplate(filename, template);
    return applyTemplate({ ...contents, filename, baseUrl: this.baseUrl });
  }

  /**
   * Returns the compiled template, compiling and caching it first if necessary.
   *
   * @param filename - Resolved path of the template file, if the template is file-based.
   * @param template - Template to compile.
   */
  private async getCompiledTemplate(filename?: string, template?: Template): Promise<TemplateFunction> {
    // File-based templates are cached on their resolved file path, string-based templates on their contents
    const key = filename ?? await readTemplate(template);
    let applyTemplate = this.cache.get(key);
    if (!applyTemplate) {
      // For string-based templates the cache key already contains the template contents
      applyTemplate = compile(filename ? await readTemplate(template) : key, { filename });
      this.cache.set(key, applyTemplate);
    }
    return applyTemplate;
  }
}
