const path = require('node:path');

/** @type {import('next').NextConfig} */
module.exports = {
  output: process.env.SHADOWCAST_STANDALONE === '1' ? 'standalone' : undefined,
  outputFileTracingRoot: path.join(__dirname, '..'),
  async headers() {
    return [{
      source: '/sample.png',
      headers: [{ key: 'Cache-Control', value: 'public, max-age=86400, immutable' }],
    }];
  },
};
