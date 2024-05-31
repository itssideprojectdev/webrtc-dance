require('esbuild')
  .build({
    entryPoints: ['./src/index.ts'],
    bundle: true,
    platform: 'node',
    watch: true,
    outfile: './dist/index.js',
    sourcemap: true,
    plugins: require('./plugins'),
  })
  .catch(() => process.exit(1));
