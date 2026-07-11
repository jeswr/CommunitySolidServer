import { PassThrough, Readable } from 'node:stream';
import { Validator } from '../../http/auxiliary/Validator';
import type { ValidatorInput } from '../../http/auxiliary/Validator';
import type { Representation } from '../../http/representation/Representation';
import { PayloadHttpError } from '../../util/errors/PayloadHttpError';
import type { Guarded } from '../../util/GuardedStream';
import { guardStream } from '../../util/GuardedStream';
import { endOfStream, pipeSafely } from '../../util/StreamUtil';
import type { QuotaStrategy } from '../quota/QuotaStrategy';

/**
 * The QuotaValidator validates data streams by making sure they would not exceed the limits of a QuotaStrategy.
 *
 * When the size of a write is known up front, that amount of space is reserved until the write settles.
 * Reservations are keyed on the scope returned by {@link QuotaStrategy.getQuotaScope},
 * so concurrent writes in the same scope can not jointly exceed the available space.
 * Writes with an unknown size can not be reserved and are only checked while streaming.
 * Reservations are kept in memory and thus not shared between multiple server instances.
 */
export class QuotaValidator extends Validator {
  private readonly strategy: QuotaStrategy;
  private readonly reservations = new Map<string, number>();

  public constructor(strategy: QuotaStrategy) {
    super();
    this.strategy = strategy;
  }

  public async handle({ representation, identifier }: ValidatorInput): Promise<Representation> {
    const { data, metadata } = representation;

    // 1. Get the available size
    const availableSize = await this.strategy.getAvailableSpace(identifier);

    // 2. Get the estimated size of the resource that is being written
    const estimatedSize = await this.strategy.estimateSize(metadata);

    // 3. Check if the estimated size still fits next to the space reserved by in-flight writes, then reserve it
    let release: (() => void) | undefined;
    if (estimatedSize) {
      const scope = await this.strategy.getQuotaScope(identifier);
      const reserved = scope ? this.reservations.get(scope) ?? 0 : 0;

      if (availableSize.amount - reserved < estimatedSize.amount) {
        return {
          ...representation,
          data: guardStream(new Readable({
            read(this): void {
              this.destroy(new PayloadHttpError(
                `Quota exceeded: Advertised Content-Length is ${estimatedSize.amount} ${estimatedSize.unit} ` +
                `and only ${availableSize.amount - reserved} ${availableSize.unit} is available`,
              ));
            },
          })),
        };
      }

      if (scope) {
        release = this.reserve(scope, estimatedSize.amount);
      }
    }

    // 4. Track if quota is exceeded during writing
    const tracking: Guarded<PassThrough> = await this.strategy.createQuotaGuard(identifier);

    // 5. Double check quota is not exceeded after write (concurrent writing possible)
    const afterWrite = new PassThrough({
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      flush: async(done): Promise<void> => {
        const availableSpace = (await this.strategy.getAvailableSpace(identifier)).amount;
        done(availableSpace < 0 ? new PayloadHttpError('Quota exceeded after write completed') : undefined);
      },
    });

    const tracked = pipeSafely(pipeSafely(data, tracking), afterWrite);

    // 6. Release the reservation when the write settles; endOfStream fires exactly once on finish, error and abort
    if (release) {
      endOfStream(tracked).then(release, release);
    }

    return {
      ...representation,
      data: tracked,
    };
  }

  /**
   * Adds `amount` to the bytes reserved for the given scope.
   * The returned function releases the reservation again and is expected to be called exactly once.
   *
   * @param scope - the scope to reserve space in
   * @param amount - the number of bytes to reserve
   *
   * @returns a function that releases the reserved amount
   */
  private reserve(scope: string, amount: number): () => void {
    const { reservations } = this;
    reservations.set(scope, (reservations.get(scope) ?? 0) + amount);

    return (): void => {
      const remaining = reservations.get(scope)! - amount;
      if (remaining > 0) {
        reservations.set(scope, remaining);
      } else {
        reservations.delete(scope);
      }
    };
  }
}
