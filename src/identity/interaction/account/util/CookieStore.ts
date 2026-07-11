/**
 * Used to generate and store cookies.
 */
export interface CookieStore {
  /**
   * Generates and stores a new cookie for the given accountId.
   * This does not replace previously generated cookies.
   *
   * @param accountId - Account to create a cookie for.
   *
   * @returns The generated cookie.
   */
  generate: (accountId: string) => Promise<string>;

  /**
   * Return the accountID associated with the given cookie.
   *
   * @param cookie - Cookie to find the account for.
   */
  get: (cookie: string) => Promise<string | undefined>;

  /**
   * Refreshes the cookie expiration and returns when it will expire if the cookie exists.
   *
   * Implementations may skip re-persisting the expiration when it would only advance marginally;
   * the returned date always matches the expiration that is actually stored.
   *
   * @param cookie - Cookie to refresh.
   * @param accountId - The account ID already known to be associated with the cookie, if available.
   *                    When provided, the store may skip re-reading the cookie-to-account mapping
   *                    and refresh the expiration directly. When omitted, the mapping is looked up
   *                    and the expiration is only refreshed if the cookie still maps to an account.
   */
  refresh: (cookie: string, accountId?: string) => Promise<Date | undefined>;

  /**
   * Deletes the given cookie.
   *
   * @param cookie - Cookie to delete.
   */
  delete: (cookie: string) => Promise<boolean>;
}
