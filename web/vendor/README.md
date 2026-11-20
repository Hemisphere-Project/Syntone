# web/vendor — third-party files served as they are

| file | from | version | licence |
|---|---|---|---|
| `opus-decoder.min.js` | npm `opus-decoder` (`dist/opus-decoder.min.js`), github.com/eshaz/wasm-audio-decoders | 0.7.12 | MIT, © 2021-2026 Ethan Halsall (header kept) |

`opus-decoder.min.js` is the receiver's WebAssembly Opus decoder, for a browser whose WebCodecs cannot
decode Opus (`web/js/codecs.js`, `WasmOpusDecoder`). The WebAssembly is inside the file; it is loaded
only when needed, as a classic script (it sets `globalThis['opus-decoder']`). The source-map comment
was removed, since the map is not vendored.

To update: `npm pack opus-decoder@<version>`, copy `package/dist/opus-decoder.min.js` here, drop its
last line (`//# sourceMappingURL=…`), change the version above.
