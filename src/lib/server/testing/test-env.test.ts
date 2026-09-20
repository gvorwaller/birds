import { describe, expect, it } from "vitest";
import { loadTestEnv, requireTestDb } from "./test-env";

describe("DB test environment helper", () => {
  it("loads .env.test and pins the dedicated birds_test cluster", () => {
    loadTestEnv();
    expect(process.env.PGHOST).toBe("127.0.0.1");
    expect(process.env.PGPORT).toBe("15436");
    expect(process.env.PGDATABASE).toBe("birds_test");
  });

  it("fails loudly, instead of skipping, when the test database is unreachable", async () => {
    await expect(requireTestDb(async () => Promise.reject(new Error("connect ECONNREFUSED")))).rejects.toThrow(
      /birds_test is unreachable \(connect ECONNREFUSED\); start it with npm run test:db:up\./,
    );
    await expect(requireTestDb(async () => undefined)).resolves.toBeUndefined();
  });
});
