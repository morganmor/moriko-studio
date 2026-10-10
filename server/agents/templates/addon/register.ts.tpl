export function register(on: { (event: string, matcher: unknown, handler: unknown): void }, $: Record<string, unknown>): void {
  on(
    'turn.start',
    { },
    async (_$: unknown, e: unknown, next: () => unknown) => {
      void $; void e;
      return next();
    },
  );
}
