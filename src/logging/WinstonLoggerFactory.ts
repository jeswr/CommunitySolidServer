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

  /**
   * @param level - The most detailed level of log messages that should be output.
   * @param logFormat - The format used to output log messages:
   *                    `pretty` for human-readable colorized lines, or `json` for a line of JSON per message.
   */
  public constructor(level: string, logFormat = 'pretty') {
    this.level = level;
    if (!(LOG_FORMATS as readonly string[]).includes(logFormat)) {
      throw new Error(`Unknown log format ${logFormat}, expected one of ${LOG_FORMATS.join('/')}`);
    }
    this.logFormat = logFormat as LogFormat;
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
    return format.combine(
      format.label({ label }),
      format.colorize(),
      format.timestamp(),
      format.metadata({ fillExcept: [ 'level', 'timestamp', 'label', 'message' ]}),
      format.printf(
        ({ level: levelInner, message, label: labelInner, timestamp, metadata: meta }: Logform.TransformableInfo):
        string =>
          `${timestamp} [${labelInner}] {${this.clusterInfo(meta as LogMetadata)}}` +
          `${this.requestInfo(meta as LogMetadata)} ${levelInner}: ${message}`,
      ),
    );
  }

  protected createTransports(): Transport[] {
    return [ new transports.Console() ];
  }
}
