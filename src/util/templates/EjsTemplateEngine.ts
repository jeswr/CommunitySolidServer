import type { TemplateFunction } from 'ejs';
import { compile } from 'ejs';
import { PromiseCache } from '../caching/PromiseCache';
import { ExtensionBasedTemplateEngine } from './ExtensionBasedTemplateEngine';
import type { Template, TemplateEngineInput } from './TemplateEngine';
import { getTemplateFilePath, readTemplate } from './TemplateUtil';
import Dict = NodeJS.Dict;

/**
 * Fills in EJS templates.
 */
export class EjsTemplateEngine<T extends Dict<unknown> = Dict<unknown>> extends ExtensionBasedTemplateEngine<T> {
  private readonly baseUrl: string;

  /**
   * Compiled templates, cached for the lifetime of this engine.
   *
   * A {@link Map} (rather than a {@link WeakMap}) is deliberate: templates are keyed on their resolved
   * file path, or on the template string for string-based templates, and both are primitives that a
   * {@link WeakMap} cannot hold. Since the set of templates is fixed by the server configuration, the
   * key space is bounded and caching for the process lifetime is safe. The trade-off is that editing a
   * template file requires a server restart.
   */
  private readonly cache: PromiseCache<string, TemplateFunction>;

  /**
   * @param baseUrl - Base URL of the server.
   * @param supportedExtensions - The extensions that are supported by this template engine (defaults to 'ejs').
   */
  public constructor(baseUrl: string, supportedExtensions = [ 'ejs' ]) {
    super(supportedExtensions);
    this.baseUrl = baseUrl;
    this.cache = new PromiseCache();
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
    return this.cache.getOrCreate(key, async(): Promise<TemplateFunction> => {
      // For string-based templates the cache key already contains the template contents
      const contents = filename ? await readTemplate(template) : key;
      return compile(contents, { filename });
    });
  }
}
