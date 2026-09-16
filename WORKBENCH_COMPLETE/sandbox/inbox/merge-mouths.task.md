# Standing order: merge the two scribe mouths

`scribe-voice.js` (askScribe Q&A bridge: recall :4000 + OmniRoute prose, cited ids)
+ `scribe-voice.cjs` (voice/speak state-lines + log)
= ONE file `sandbox/scribe-voice.cjs` with both mouths, one module.exports.

Then delete `sandbox/scribe-voice.js` so no ESM-trapped twin remains.

Rules: no secrets in files (env only), node --check after writing.
When done, write `merge-mouths.done.md` in this inbox via write_file.
