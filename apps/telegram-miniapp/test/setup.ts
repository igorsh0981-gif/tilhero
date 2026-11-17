import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { rateLimits } from "../src/api/rateLimit";

afterEach(() => {
  cleanup();
  // a 429 wait is app-wide state — one test's limit must not hold the next test's buttons
  rateLimits.reset();
});
