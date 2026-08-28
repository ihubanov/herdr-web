# Third-party notices

## xterm.js
`src/web/xterm.js`, `src/web/xterm.css`, `src/web/xterm-addon-fit.js` are
vendored builds of [xterm.js](https://github.com/xtermjs/xterm.js) and its fit
addon, MIT licensed. They are copied from `node_modules/@xterm/*` at the
versions pinned in `package.json`; refresh them with `bun run sync-vendor`.

## herdr
This project talks to [herdr](https://github.com/herdrdev/herdr) (Apache-2.0)
over its documented socket API. It vendors no herdr code and is not affiliated
with the herdr project.
