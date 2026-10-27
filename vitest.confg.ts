import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['test/**/*.{test,spec}.ts?(x)'],
        coverage: {
            include: ['src/**/*.ts?(x)'],
            exclude: ['**/*.d.ts'],
            reporter: ['text', 'json', 'html']
        },
    },
});
