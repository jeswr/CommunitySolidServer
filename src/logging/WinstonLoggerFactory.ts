import type { Logform } from 'winston';
import { createLogger, format, transports } from 'winston';
import type * as Transport from 'winston-transport';
import type { Logger, LogMetadata } from './Logger';
import type { LoggerFactory } from './LoggerFactory';
import { WinstonLogger } from './WinstonLogger';

export const LOG_FORMATS = [ 'pretty', 'json' ] as const;

/**
 * Different formats in which log messages can be output.
 */
export type LogFormat = typeof LOG_FORMATS[number];

/**
 * Matches the characters that must be escaped before being written to the `pretty` log output:
 * every C0 control character except tab (`\t`), the DEL character, and the C1 control range.
 * These can otherwise be abused by attacker-influenced log fields (e.g. a WebID or request URL)
 * to forge additional log lines or emit terminal escape (ANSI) sequences.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000A-\u001F\u007F-\u009F]/gu;

/**
 * Uses the winston library to create loggers for the given logging level.
 * By default, it will print to the console with colorized logging levels.
 * The `json` format can be used instead to output every log entry
 * as a single line of JSON, which is easier to parse for log aggregators.
 *
 * This creates instances of {@link WinstonLogger}.
 */
export class WinstonLoggerFactory implements LoggerFactory {
  private readonly level: string;
  private readonly logFormat: LogFormat;
  private readonly colorize: boolean;

  /**
   * @param level - The most detailed level of log messages that should be output.
   * @param logFormat - The format used to output log messages:
   *                    `pretty` for human-readable colorized lines, or `json` for a line of JSON per message.
   * @param colorize - Whether the level in the `pretty` output is colorized with ANSI escape codes.
   *                   Has no effect on the `json` format.
   */
  public constructor(level: string, logFormat = 'pretty', colorize = true) {
    this.level = level;
    if (!(LOG_FORMATS as readonly string[]).includes(logFormat)) {
      throw new Error(`Unknown log format ${logFormat}, expected one of ${LOG_FORMATS.join('/')}`);
    }
    this.logFormat = logFormat as LogFormat;
    this.colorize = colorize;
  }

  private readonly clusterInfo = (meta: LogMetadata): string => {
    if (meta.isPrimary) {
      return 'Primary';
    }
    return `W-${meta.pid ?? '???'}`;
  };

  private readonly requestInfo = (meta: LogMetadata): string => {
    if (meta.requestId) {
      return ` [${meta.requestId}]`;
    }
    return '';
  };

  /**
   * Escapes control characters in an attacker-influenceable value so it cannot forge additional
   * lines or emit terminal escape sequences in the `pretty` log output.
   * Newlines and carriage returns become the literal two-character `\n`/`\r` sequences, tab is
   * kept as-is, and every other control character becomes its `\uXXXX` escape.
   * Legitimate printable Unicode (including backslashes) is left untouched.
   *
   * @param value - The value to escape.
   *
   * @returns The value with all dangerous control characters escaped.
   */
  private sanitize(value: string): string {
    return value.replaceAll(CONTROL_CHARACTERS, (char: string): string => {
      switch (char) {
        case '\n':
          return '\\n';
        case '\r':
          return '\\r';
        default:
          return `\\u${char.codePointAt(0)!.toString(16).padStart(4, '0')}`;
      }
    });
  }

  public createLogger(label: string): Logger {
    return new WinstonLogger(createLogger({
      level: this.level,
      format: this.createFormat(label),
      transports: this.createTransports(),
    }));
  }

  /**
   * Creates the winston format corresponding to the `logFormat` this factory was created with.
   */
  protected createFormat(label: string): Logform.Format {
    if (this.logFormat === 'json') {
      return format.combine(
        format.label({ label }),
        format.timestamp(),
        format.json(),
      );
    }
    const prettyFormats: Logform.Format[] = [ format.label({ label }) ];
    if (this.colorize) {
      prettyFormats.push(format.colorize());
    }
    prettyFormats.push(
      format.timestamp(),
      format.metadata({ fillExcept: [ 'level', 'timestamp', 'label', 'message' ]}),
      format.printf(
        ({ level: levelInner, message, label: labelInner, timestamp, metadata: meta }: Logform.TransformableInfo):
        string =>
          `${timestamp} [${this.sanitize(String(labelInner))}] {${this.clusterInfo(meta as LogMetadata)}}` +
          `${this.requestInfo(meta as LogMetadata)} ${levelInner}: ${this.sanitize(String(message))}`,
      ),
    );
    return format.combine(...prettyFormats);
  }

  protected createTransports(): Transport[] {
    return [ new transports.Console() ];
  }
}
