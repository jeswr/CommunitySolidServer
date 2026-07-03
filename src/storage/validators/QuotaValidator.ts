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
 * When the size of a write is known up front (advertised `Content-Length`), the validator reserves that
 * amount of space for the duration of the write. Reservations are keyed on the scope returned by
 * {@link QuotaStrategy.getQuotaScope}, so two concurrent writes measured against the same available-space
 * snapshot can no longer both pass and jointly exceed the quota. The reservation is released again exactly
 * once when the write stream settles (finish, error or abort).
 *
 * The reservation map is kept per-instance. Since the `QuotaValidator` is instantiated as a single
 * component this is effectively per-process, which is sufficient for a single server instance.
 * A multi-instance/multi-process deployment sharing one backend would need shared reservation state;
 * this is a documented follow-up. Writes with an unknown size (chunked, no `Content-Length`) cannot be
 * reserved and fall back to the streaming guard alone, so they retain the original overshoot window.
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

    // 3. When the size is known up front, account for space already reserved by other in-flight
    //    writes in the same scope, reject if it no longer fits, and otherwise reserve it ourselves.
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

      // An empty scope means quota does not apply to this identifier, so nothing is reserved.
      if (scope) {
        release = this.reserve(scope, estimatedSize.amount);
      }
    }

    // 4. Track if quota is exceeded during writing (also the only guard for unknown-size writes)
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

    // 6. Release the reservation exactly once when the write settles.
    //    `endOfStream` invokes its callback a single time on finish, error and close (abort) alike,
    //    so the reserved space is always returned and never released twice.
    if (release) {
      endOfStream(tracked).then(release, release);
    }

    return {
      ...representation,
      data: tracked,
    };
  }

  /**
   * Adds `amount` to the bytes reserved for the given scope and returns a function that releases
   * exactly that amount again. The release function is meant to be called a single time when the
   * write settles; it removes the scope from the map once no reservations remain.
   *
   * @param scope - the shared-quota scope to reserve space in
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
