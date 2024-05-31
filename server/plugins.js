const fs = require('fs');
const path = require('path');
const {nodeExternalsPlugin} = require('esbuild-node-externals');
const alias = require('esbuild-plugin-alias');

module.exports = [
  alias({
  }),
  /*nodeExternalsPlugin(),*/
];
