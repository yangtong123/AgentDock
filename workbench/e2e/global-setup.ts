import { startFixture, type E2EFixture } from "./fixture";

declare global {
  // eslint-disable-next-line no-var
  var __e2eFixture: E2EFixture | undefined;
}

export default async function globalSetup(): Promise<void> {
  const fixture = await startFixture();
  globalThis.__e2eFixture = fixture;
  process.env.E2E_URL = fixture.url;
  process.env.E2E_TOKEN = fixture.token;
}
