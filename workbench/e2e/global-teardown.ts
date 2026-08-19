export default async function globalTeardown(): Promise<void> {
  await globalThis.__e2eFixture?.stop();
}
