import { promises as fsPromises } from 'node:fs';
import * as mime from 'mime-types';
import type { ResourceIdentifier } from '../../http/representation/ResourceIdentifier';
import { DEFAULT_CUSTOM_TYPES } from '../../util/ContentTypes';
import { NotImplementedHttpError } from '../../util/errors/NotImplementedHttpError';
import { getExtension, joinFilePath } from '../../util/PathUtil';
import { BaseFileIdentifierMapper } from './BaseFileIdentifierMapper';
import type { FileIdentifierMapperFactory, ResourceLink } from './FileIdentifierMapper';

type DirectoryProfile =
  { type: 'small'; files: readonly string[] } |
  { type: 'large'; extensions: readonly string[] };

interface DirectoryProfileLookup {
  profile?: DirectoryProfile;
  sampled: boolean;
}

/**
 * Supports the behaviour described in https://www.w3.org/DesignIssues/HTTPFilenameMapping.html
 * Determines content-type based on the file extension.
 * In case an identifier does not end on an extension matching its content-type,
 * the corresponding file will be appended with the correct extension, preceded by $.
 */
export class ExtensionBasedMapper extends BaseFileIdentifierMapper {
  private static readonly smallDirectorySize = 64;
  private static readonly directorySampleSize = 128;
  private static readonly maximumProfileExtensions = 24;
  private static readonly maximumCachedProfiles = 1_024;

  private readonly customTypes: Record<string, string>;
  private readonly customExtensions: Record<string, string>;
  private readonly directoryProfiles = new Map<string, DirectoryProfile>();
  private readonly profileRequests = new Map<string, Promise<DirectoryProfile | undefined>>();
  private readonly directoryRefreshes = new Map<string, Promise<readonly string[] | undefined>>();

  public constructor(
    base: string,
    rootFilepath: string,
    customTypes?: Record<string, string>,
  ) {
    super(base, rootFilepath);

    // Workaround for https://github.com/LinkedSoftwareDependencies/Components.js/issues/20
    if (!customTypes || Object.keys(customTypes).length === 0) {
      this.customTypes = DEFAULT_CUSTOM_TYPES;
    } else {
      this.customTypes = customTypes;
    }

    this.customExtensions = {};
    for (const [ extension, contentType ] of Object.entries(this.customTypes)) {
      this.customExtensions[contentType] = extension;
    }
  }

  protected async mapUrlToDocumentPath(identifier: ResourceIdentifier, filePath: string, contentType?: string):
  Promise<ResourceLink> {
    // Would conflict with how new extensions are stored
    if (/\$\.\w+$/u.test(filePath)) {
      this.logger.warn(`Identifier ${identifier.path} contains a dollar sign before its extension`);
      throw new NotImplementedHttpError('Identifiers cannot contain a dollar sign before their extension');
    }

    // Existing file
    if (!contentType) {
      // Find a matching file
      const [ , folder, documentName ] = /^(.*\/)([^/]*)$/u.exec(filePath)!;
      const fileName = await this.findFile(folder, documentName);
      if (fileName) {
        filePath = joinFilePath(folder, fileName);
      }
      contentType = await this.getContentTypeFromPath(filePath);
    // If the extension of the identifier matches a different content-type than the one that is given,
    // we need to add a new extension to match the correct type.
    } else if (contentType !== await this.getContentTypeFromPath(filePath)) {
      let extension: string = mime.extension(contentType) || this.customExtensions[contentType];
      if (!extension) {
        // When no extension is found for the provided content-type, use a fallback extension.
        extension = this.unknownMediaTypeExtension;
        // Signal the fallback by setting the content-type to undefined in the output link.
        contentType = undefined;
      }
      filePath += `$.${extension}`;
    }
    return super.mapUrlToDocumentPath(identifier, filePath, contentType);
  }

  private async findFile(folder: string, documentName: string): Promise<string | undefined> {
    // An empty document name would cause stat to match the folder itself.
    if (documentName && await this.exists(joinFilePath(folder, documentName))) {
      return documentName;
    }

    const { profile, sampled } = await this.getDirectoryProfile(folder);
    if (profile?.type === 'small') {
      const candidate = this.findMatchingFile(profile.files, documentName);
      if (candidate && await this.exists(joinFilePath(folder, candidate))) {
        return candidate;
      }
      if (!candidate && sampled) {
        return undefined;
      }
    } else if (profile) {
      for (const extension of profile.extensions) {
        const candidate = `${documentName}$.${extension}`;
        if (await this.exists(joinFilePath(folder, candidate))) {
          return candidate;
        }
      }
    }

    const files = await this.refreshDirectory(folder);
    return files && this.findMatchingFile(files, documentName);
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await fsPromises.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  private findMatchingFile(files: readonly string[], documentName: string): string | undefined {
    return files.find((file): boolean =>
      file.startsWith(documentName) && /^(?:\$\..+)?$/u.test(file.slice(documentName.length)));
  }

  private async getDirectoryProfile(folder: string): Promise<DirectoryProfileLookup> {
    const cached = this.directoryProfiles.get(folder);
    if (cached) {
      this.directoryProfiles.delete(folder);
      this.directoryProfiles.set(folder, cached);
      return { profile: cached, sampled: false };
    }

    let request = this.profileRequests.get(folder);
    if (!request) {
      request = this.sampleDirectory(folder).then((profile): DirectoryProfile | undefined => {
        if (profile) {
          this.setDirectoryProfile(folder, profile);
        }
        return profile;
      }).finally((): void => {
        this.profileRequests.delete(folder);
      });
      this.profileRequests.set(folder, request);
    }
    return { profile: await request, sampled: true };
  }

  private async sampleDirectory(folder: string): Promise<DirectoryProfile | undefined> {
    try {
      const directory = await fsPromises.opendir(folder, { bufferSize: ExtensionBasedMapper.directorySampleSize });
      const files: string[] = [];
      for await (const entry of directory) {
        files.push(entry.name);
        if (files.length === ExtensionBasedMapper.directorySampleSize) {
          break;
        }
      }
      return this.createDirectoryProfile(files);
    } catch {
      // Parent folder does not exist (or is not a folder)
    }
  }

  private async refreshDirectory(folder: string): Promise<readonly string[] | undefined> {
    let request = this.directoryRefreshes.get(folder);
    if (!request) {
      request = this.readDirectory(folder).finally((): void => {
        this.directoryRefreshes.delete(folder);
      });
      this.directoryRefreshes.set(folder, request);
    }
    return request;
  }

  private async readDirectory(folder: string): Promise<readonly string[] | undefined> {
    try {
      const files = await fsPromises.readdir(folder);
      this.setDirectoryProfile(folder, this.createDirectoryProfile(files));
      return files;
    } catch {
      // Parent folder does not exist (or is not a folder)
    }
  }

  private createDirectoryProfile(files: readonly string[]): DirectoryProfile {
    if (files.length <= ExtensionBasedMapper.smallDirectorySize) {
      return { type: 'small', files };
    }

    const occurrences = new Map<string, { count: number; order: number }>();
    for (const file of files) {
      const marker = file.lastIndexOf('$.');
      if (marker >= 0 && marker + 2 < file.length) {
        const extension = file.slice(marker + 2);
        const occurrence = occurrences.get(extension);
        if (occurrence) {
          occurrence.count += 1;
        } else {
          occurrences.set(extension, { count: 1, order: occurrences.size });
        }
      }
    }

    const extensions = [ ...occurrences.entries() ]
      .sort(([ , left ], [ , right ]): number => right.count - left.count || left.order - right.order)
      .slice(0, ExtensionBasedMapper.maximumProfileExtensions)
      .map(([ extension ]): string => extension);
    return { type: 'large', extensions };
  }

  private setDirectoryProfile(folder: string, profile: DirectoryProfile): void {
    this.directoryProfiles.delete(folder);
    this.directoryProfiles.set(folder, profile);
    if (this.directoryProfiles.size > ExtensionBasedMapper.maximumCachedProfiles) {
      const oldest = this.directoryProfiles.keys().next() as IteratorYieldResult<string>;
      this.directoryProfiles.delete(oldest.value);
    }
  }

  protected async getDocumentUrl(relative: string): Promise<string> {
    return super.getDocumentUrl(this.stripExtension(relative));
  }

  protected async getContentTypeFromPath(filePath: string): Promise<string> {
    const extension = getExtension(filePath).toLowerCase();
    return mime.lookup(extension) ||
      this.customTypes[extension] ||
      await super.getContentTypeFromPath(filePath);
  }

  /**
   * Helper function that removes the internal extension, one starting with $., from the given path.
   * Nothing happens if no such extension is present.
   */
  protected stripExtension(path: string): string {
    const extension = getExtension(path);
    if (extension && path.endsWith(`$.${extension}`)) {
      path = path.slice(0, -(extension.length + 2));
    }
    return path;
  }
}

export class ExtensionBasedMapperFactory implements FileIdentifierMapperFactory<ExtensionBasedMapper> {
  public async create(base: string, rootFilePath: string): Promise<ExtensionBasedMapper> {
    return new ExtensionBasedMapper(base, rootFilePath);
  }
}
