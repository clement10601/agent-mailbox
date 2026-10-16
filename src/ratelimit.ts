export interface RateLimiter {
  /** Returns true if the call is allowed, false if `key` is over its limit. */
  limit(key: string): Promise<boolean>;
}

export function fromBinding(b: RateLimit): RateLimiter {
  return {
    async limit(key: string): Promise<boolean> {
      const { success } = await b.limit({ key });
      return success;
    },
  };
}
