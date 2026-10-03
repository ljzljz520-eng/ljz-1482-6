require('esbuild').build({
  entryPoints: ['src/App.jsx'], bundle: true, outfile: 'public/bundle.js',
  loader: { '.jsx': 'jsx' }, jsx: 'automatic', minify: false,
}).then(() => console.log('bundle built')).catch(e => { console.error(e); process.exit(1); });
