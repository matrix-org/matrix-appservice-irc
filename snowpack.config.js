/** @type {import("snowpack").SnowpackUserConfig } */
module.exports = {
    mount: {
        "web/": '/'
    },
    plugins: [
        '@prefresh/snowpack',
        '@snowpack/plugin-sass',
        ['@snowpack/plugin-typescript', '--project tsconfig.web.json'],
    ],
    packageOptions: {
        installTypes: true,
        polyfillNode: true,
    },
    buildOptions: {
        out: 'public'
    },
    alias: {
        "react": "preact/compat",
        "react-dom/test-utils": "preact/test-utils",
        "react-dom": "preact/compat",
        "react/jsx-runtime": "preact/jsx-runtime",
    }
  };
  