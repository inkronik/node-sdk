import { defineConfig } from 'tsup'

export default defineConfig({
    clean: true,
    dts: true,
    entry: {
        auto: 'src/auto.ts',
        'express/index': 'src/express/index.ts',
        index: 'src/index.ts',
        'nest/index': 'src/nest/index.ts',
        register: 'src/register.ts',
    },
    external: ['@nestjs/common', 'postgres', 'rxjs'],
    format: ['esm'],
    outDir: 'dist',
    sourcemap: true,
    splitting: true,
    target: 'node20',
})
