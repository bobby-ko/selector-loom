import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        coverage: {
            reporter: ["text", "html"]
        },
        testTimeout: -1,
        env: {
            "SELECTOR_LOOM_TMP": "./tmp",
            "SELECTOR_LOOM_MAX_WORDNET_LOOKUP_BUDGET_MS": "60000"
        }
    }
})