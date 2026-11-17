import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { rateLimits } from "../src/api/rateLimit";

// sprint 9: a 429 wait is app-wide state — one test's limit must not hold the next test's buttons
afterEach(() => rateLimits.reset());
